import fs from 'node:fs'
import path from 'node:path'
import type { Divergence } from './divergence'
import { GUARDS } from './config'

export type Action = { verb: 'kill' | 'pin'; branchIdx: number; at: number }
export type Prefetch = {
  divergenceId: string; branchIdx: number; label: string
  text: string; status: 'running' | 'done' | 'dropped'
}

export type Run = {
  id: string
  prompt: string
  divergences: Divergence[]
  etaSeconds: number
  steer: string[]                       // antrian yang di-drain di batas tool call
  actions: Record<string, Action>       // divergenceId -> aksi user
  committed: Record<string, number>     // divergenceId -> branchIdx yang benar-benar diambil main run
  prefetch: Prefetch[]                  // cabang selamat yang dihitung sungguhan selama menunggu
  output: string
  diff: string
  startedAt: number
  unlockedCount: number                 // divergensi ke-4+ yang sudah dibayar lewat x402
  done: boolean
}

// ponytail: Map di level modul = satu proses. Cukup untuk satu server; multi-instance butuh Redis.
const runs = new Map<string, Run>()

// Prior (preferensi yang dibunuh >= 3x) dipersistenkan ke disk supaya belajarnya tidak hilang saat restart.
const PRIOR_FILE = path.resolve('.simpang/prior.json')
const prior = new Map<string, number>(
  fs.existsSync(PRIOR_FILE)
    ? Object.entries(JSON.parse(fs.readFileSync(PRIOR_FILE, 'utf8')) as Record<string, number>)
    : [],
)
const savePrior = () => {
  fs.mkdirSync(path.dirname(PRIOR_FILE), { recursive: true })
  fs.writeFileSync(PRIOR_FILE, JSON.stringify(Object.fromEntries(prior), null, 2))
}

export const store = {
  create(id: string, prompt: string): Run {
    const run: Run = {
      id, prompt, divergences: [], etaSeconds: 0, steer: [], actions: {}, committed: {},
      prefetch: [], output: '', diff: '', startedAt: Date.now(), unlockedCount: 0, done: false,
    }
    runs.set(id, run)
    return run
  },
  get: (id: string) => runs.get(id),

  /** Run orang lain yang masih berjalan dan sudah punya pohon: bahan pohon multiplayer. */
  others: (exclude: string) =>
    [...runs.values()]
      .filter((r) => r.id !== exclude && !r.done && r.divergences.length)
      .sort((a, b) => b.startedAt - a.startedAt)[0],

  /** Divergensi yang boleh dilihat/dipangkas user: tier gratis + yang sudah dibayar. */
  visible: (r: Run) => r.divergences.slice(0, GUARDS.freeBranches + r.unlockedCount),
  locked: (r: Run) => Math.max(0, r.divergences.length - GUARDS.freeBranches - r.unlockedCount),

  /** Dipanggil dari prepareStep di setiap batas tool call. */
  drain(id: string): string[] {
    const r = runs.get(id)
    if (!r?.steer.length) return []
    return r.steer.splice(0, r.steer.length)
  },

  push(id: string, constraint: string) {
    runs.get(id)?.steer.push(constraint)
  },

  /** Standing constraints: dibunuh >= 3x berarti sudah jadi preferensi, bukan pertanyaan. */
  bumpPrior(constraint: string) {
    prior.set(constraint, (prior.get(constraint) ?? 0) + 1)
    savePrior()
  },
  standing: () => [...prior.entries()].filter(([, n]) => n >= 3).map(([c]) => c),
}
