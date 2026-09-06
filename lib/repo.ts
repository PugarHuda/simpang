import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

/** Repo sungguhan di disk. Default: examples/acme (aplikasi kecil dengan auth JWT).
 *  SIMPANG_REPO_DIR menunjuk ke repo lain. Tulisan agent masuk ke salinan per run di
 *  .simpang/runs/<id>/, jadi repo asli tidak pernah disentuh; hasilnya unified diff nyata. */
export const REPO_DIR = path.resolve(process.env.SIMPANG_REPO_DIR ?? 'examples/acme')
const RUNS_DIR = path.resolve('.simpang/runs')
const SKIP = new Set(['node_modules', '.git', '.next', '.simpang'])

export function listFiles(dir = REPO_DIR, base = dir): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (SKIP.has(e.name)) return []
    const p = path.join(dir, e.name)
    return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p).split(path.sep).join('/')]
  })
}

const safe = (root: string, rel: string) => {
  const p = path.resolve(root, rel)
  if (!p.startsWith(root + path.sep) && p !== root) throw new Error(`path escapes repo: ${rel}`)
  return p
}

/** Konteks untuk scan: isi semua file (repo contoh kecil; dipotong di 60 KB kalau repo besar). */
export function repoContext(): string {
  let out = ''
  for (const f of listFiles()) {
    out += `--- ${f}\n${fs.readFileSync(safe(REPO_DIR, f), 'utf8')}\n`
    if (out.length > 60_000) { out += '--- (truncated)\n'; break }
  }
  return out
}

/** Working copy lebih tua dari 2 jam dibuang; run-nya sudah lama selesai. */
function prune() {
  if (!fs.existsSync(RUNS_DIR)) return
  const cutoff = Date.now() - 2 * 3600_000
  for (const e of fs.readdirSync(RUNS_DIR, { withFileTypes: true })) {
    const p = path.join(RUNS_DIR, e.name)
    if (e.isDirectory() && fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true })
  }
}

export function workspace(runId: string) {
  const dir = path.join(RUNS_DIR, runId)
  if (!fs.existsSync(dir)) {
    prune()
    fs.cpSync(REPO_DIR, dir, { recursive: true, filter: (s) => !SKIP.has(path.basename(s)) })
  }
  return {
    dir,
    read: (rel: string) => {
      const p = safe(dir, rel)
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
    },
    write: (rel: string, content: string) => {
      const p = safe(dir, rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, content)
    },
    /** Unified diff nyata antara repo asli dan hasil kerja agent. */
    diff: (): string => {
      // Path relatif dari cwd supaya header diff bersih (tanpa kutip/backslash Windows),
      // lalu prefix repo dan working copy dibuang: tinggal a/<file> b/<file>.
      const rel = (p: string) => path.relative(process.cwd(), p).split(path.sep).join('/')
      let raw = ''
      try {
        raw = execFileSync('git', ['diff', '--no-index', '--no-color', '--', rel(REPO_DIR), rel(dir)], { encoding: 'utf8', cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] })
      } catch (e) {
        // git diff --no-index keluar dengan kode 1 kalau ada perbedaan; stdout-nya tetap diff-nya.
        raw = (e as { stdout?: string }).stdout ?? ''
      }
      // File baru memakai path working copy di sisi a/ juga; file terhapus memakai path repo di sisi b/.
      return raw
        .replaceAll(`a/${rel(REPO_DIR)}/`, 'a/').replaceAll(`a/${rel(dir)}/`, 'a/')
        .replaceAll(`b/${rel(dir)}/`, 'b/').replaceAll(`b/${rel(REPO_DIR)}/`, 'b/')
    },
  }
}
