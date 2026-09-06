import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createTwoFilesPatch } from 'diff'

/** A real repo on disk. Default: examples/acme (a small app with JWT auth).
 *  SIMPANG_REPO_DIR points at another repo. The agent's writes land in a per-run copy, so the
 *  original repo is never touched; the result is a real unified diff.
 *  On serverless (Vercel) the working copy lives in that instance's tmpdir; the changed files
 *  are also saved to the store so a fork on another instance can continue. */
// A static path (process.cwd() + subfolder) so Next's bundle tracing pulls in examples/ only,
// not the whole project. The env override is deliberately invisible to the tracer.
export const REPO_DIR = process.env.SIMPANG_REPO_DIR
  ? path.resolve(/*turbopackIgnore: true*/ process.env.SIMPANG_REPO_DIR)
  : path.join(process.cwd(), 'examples', 'acme')
const RUNS_DIR = process.env.VERCEL ? path.join(os.tmpdir(), 'simpang-runs') : path.join(process.cwd(), '.simpang', 'runs')
const SKIP = new Set(['node_modules', '.git', '.next', '.simpang'])

export function listFiles(dir = REPO_DIR, base = dir): string[] {
  if (!fs.existsSync(dir)) return []
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

/** Context for the scan: the contents of every file (the example repo is small; capped at 60 KB). */
export function repoContext(): string {
  let out = ''
  for (const f of listFiles()) {
    out += `--- ${f}\n${fs.readFileSync(safe(REPO_DIR, f), 'utf8')}\n`
    if (out.length > 60_000) { out += '--- (truncated)\n'; break }
  }
  return out
}

/** Working copies older than 2 hours are dropped; their runs finished long ago. */
function prune() {
  if (!fs.existsSync(RUNS_DIR)) return
  const cutoff = Date.now() - 2 * 3600_000
  for (const e of fs.readdirSync(RUNS_DIR, { withFileTypes: true })) {
    const p = path.join(RUNS_DIR, e.name)
    if (e.isDirectory() && fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true })
  }
}

/** @param overlay files this run already wrote (from the store), for when its working copy
 *  lives on another instance. */
export function workspace(runId: string, overlay: Record<string, string> = {}) {
  const dir = path.join(RUNS_DIR, runId)
  if (!fs.existsSync(dir)) {
    prune()
    fs.cpSync(REPO_DIR, dir, { recursive: true, filter: (s) => !SKIP.has(path.basename(s)) })
    for (const [rel, content] of Object.entries(overlay)) {
      const p = safe(dir, rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, content)
    }
  }
  const read = (root: string, rel: string) => {
    const p = safe(root, rel)
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null
  }
  return {
    dir,
    read: (rel: string) => read(dir, rel),
    write: (rel: string, content: string) => {
      const p = safe(dir, rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, content)
    },
    /** Files that differ from the original repo: these get persisted to the store. */
    changed: (): Record<string, string> => {
      const out: Record<string, string> = {}
      for (const f of new Set([...listFiles(REPO_DIR), ...listFiles(dir)])) {
        const after = read(dir, f)
        if (after !== null && after !== read(REPO_DIR, f)) out[f] = after
      }
      return out
    },
    /** A real unified diff between the original repo and the agent's work (no git: it runs on serverless). */
    diff: (): string => {
      let out = ''
      for (const f of [...new Set([...listFiles(REPO_DIR), ...listFiles(dir)])].sort()) {
        const before = read(REPO_DIR, f), after = read(dir, f)
        if (before === after) continue
        out += `diff --git a/${f} b/${f}\n` +
          createTwoFilesPatch(before === null ? '/dev/null' : `a/${f}`, after === null ? '/dev/null' : `b/${f}`,
            before ?? '', after ?? '', undefined, undefined, { context: 3 })
            .split('\n').slice(1).join('\n')   // drop jsdiff's "Index:" line
      }
      return out
    },
  }
}
