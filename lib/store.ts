import fs from 'node:fs'
import path from 'node:path'
import { Redis } from '@upstash/redis'
import type { Divergence } from './divergence'
import { GUARDS } from './config'

export type Action = { verb: 'kill' | 'pin'; branchIdx: number; at: number }
export type Prefetch = {
  divergenceId: string; branchIdx: number; label: string
  text: string; status: 'running' | 'done' | 'dropped'
}

/** Field yang dimiliki route /api/run (ditulis satu proses) vs field bersama
 *  (ditulis steer/unlock dari proses mana pun). Yang bersama disimpan terpisah
 *  supaya tidak ada read-modify-write yang saling menimpa. */
export type RunBase = {
  id: string
  prompt: string
  divergences: Divergence[]
  etaSeconds: number
  prefetch: Prefetch[]
  output: string
  diff: string
  startedAt: number
}
export type Run = RunBase & {
  actions: Record<string, Action>       // divergenceId -> aksi user
  committed: Record<string, number>     // divergenceId -> branchIdx yang benar-benar diambil main run
  unlockedCount: number                 // divergensi ke-4+ yang sudah dibayar lewat x402
  done: boolean
}

const TTL = 24 * 3600

interface Backend {
  saveBase(run: RunBase): Promise<void>
  load(id: string): Promise<Run | undefined>
  setAction(id: string, divergenceId: string, a: Action): Promise<void>
  setCommit(id: string, divergenceId: string, idx: number): Promise<void>
  incrUnlocked(id: string): Promise<number>
  setDone(id: string): Promise<void>
  push(id: string, constraint: string): Promise<void>
  drain(id: string): Promise<string[]>
  saveFiles(id: string, files: Record<string, string>): Promise<void>
  loadFiles(id: string): Promise<Record<string, string>>
  latestActive(exclude: string): Promise<string | undefined>
  bumpPrior(constraint: string): Promise<number>
  standing(): Promise<string[]>
}

/* ------------------------------------------------------------- redis ---- */
// Upstash lewat Vercel Marketplace memberi KV_REST_API_*; akun Upstash langsung memberi UPSTASH_REDIS_REST_*.
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN

function redisBackend(url: string, token: string): Backend {
  const r = new Redis({ url, token })
  const k = (id: string, suffix = '') => `run:${id}${suffix}`
  return {
    async saveBase(run) {
      await r.set(k(run.id), JSON.stringify(run), { ex: TTL })
      await r.zadd('runs:active', { score: run.startedAt, member: run.id })
    },
    async load(id) {
      const [base, actions, committed, unlocked, done] = await Promise.all([
        r.get<RunBase | string>(k(id)),
        r.hgetall<Record<string, Action>>(k(id, ':actions')),
        r.hgetall<Record<string, number>>(k(id, ':committed')),
        r.get<number>(k(id, ':unlocked')),
        r.get<number>(k(id, ':done')),
      ])
      if (!base) return undefined
      const b = typeof base === 'string' ? (JSON.parse(base) as RunBase) : base
      return {
        ...b,
        actions: actions ?? {},
        committed: Object.fromEntries(Object.entries(committed ?? {}).map(([d, i]) => [d, Number(i)])),
        unlockedCount: Number(unlocked ?? 0),
        done: Boolean(done),
      }
    },
    async setAction(id, d, a) { await r.hset(k(id, ':actions'), { [d]: a }); await r.expire(k(id, ':actions'), TTL) },
    async setCommit(id, d, idx) { await r.hset(k(id, ':committed'), { [d]: idx }); await r.expire(k(id, ':committed'), TTL) },
    async incrUnlocked(id) { const n = await r.incr(k(id, ':unlocked')); await r.expire(k(id, ':unlocked'), TTL); return n },
    async setDone(id) { await r.set(k(id, ':done'), 1, { ex: TTL }); await r.zrem('runs:active', id) },
    async push(id, c) { await r.rpush(k(id, ':steer'), c); await r.expire(k(id, ':steer'), TTL) },
    async drain(id) {
      // LRANGE + DEL dalam satu pipeline: antrian dikosongkan atomik per batas step.
      const [items] = await r.multi().lrange<string>(k(id, ':steer'), 0, -1).del(k(id, ':steer')).exec()
      return (items as string[]) ?? []
    },
    async saveFiles(id, files) { await r.set(k(id, ':files'), JSON.stringify(files), { ex: TTL }) },
    async loadFiles(id) {
      const v = await r.get<Record<string, string> | string>(k(id, ':files'))
      return !v ? {} : typeof v === 'string' ? JSON.parse(v) : v
    },
    async latestActive(exclude) {
      const ids = await r.zrange<string[]>('runs:active', 0, 4, { rev: true })
      return ids.find((x) => x !== exclude)
    },
    async bumpPrior(c) { return r.hincrby('prior', c, 1) },
    async standing() {
      const all = await r.hgetall<Record<string, number>>('prior')
      return Object.entries(all ?? {}).filter(([, n]) => Number(n) >= 3).map(([c]) => c)
    },
  }
}

/* ------------------------------------------------------------ memory ---- */
// Satu proses (dev lokal, tes). Prior tetap dipersistenkan ke disk supaya belajarnya tidak hilang.
function memoryBackend(): Backend {
  const base = new Map<string, RunBase>()
  const actions = new Map<string, Record<string, Action>>()
  const committed = new Map<string, Record<string, number>>()
  const unlocked = new Map<string, number>()
  const done = new Set<string>()
  const queue = new Map<string, string[]>()
  const files = new Map<string, Record<string, string>>()
  const PRIOR_FILE = path.join(process.cwd(), '.simpang', 'prior.json')
  const prior = new Map<string, number>(
    fs.existsSync(PRIOR_FILE) ? Object.entries(JSON.parse(fs.readFileSync(PRIOR_FILE, 'utf8')) as Record<string, number>) : [],
  )
  return {
    async saveBase(run) { base.set(run.id, run) },
    async load(id) {
      const b = base.get(id)
      if (!b) return undefined
      return { ...b, actions: actions.get(id) ?? {}, committed: committed.get(id) ?? {}, unlockedCount: unlocked.get(id) ?? 0, done: done.has(id) }
    },
    async setAction(id, d, a) { actions.set(id, { ...(actions.get(id) ?? {}), [d]: a }) },
    async setCommit(id, d, idx) { committed.set(id, { ...(committed.get(id) ?? {}), [d]: idx }) },
    async incrUnlocked(id) { const n = (unlocked.get(id) ?? 0) + 1; unlocked.set(id, n); return n },
    async setDone(id) { done.add(id) },
    async push(id, c) { queue.set(id, [...(queue.get(id) ?? []), c]) },
    async drain(id) { const q = queue.get(id) ?? []; queue.set(id, []); return q },
    async saveFiles(id, f) { files.set(id, f) },
    async loadFiles(id) { return files.get(id) ?? {} },
    async latestActive(exclude) {
      return [...base.values()].filter((r) => r.id !== exclude && !done.has(r.id) && r.divergences.length)
        .sort((a, b) => b.startedAt - a.startedAt)[0]?.id
    },
    async bumpPrior(c) {
      prior.set(c, (prior.get(c) ?? 0) + 1)
      fs.mkdirSync(path.dirname(PRIOR_FILE), { recursive: true })
      fs.writeFileSync(PRIOR_FILE, JSON.stringify(Object.fromEntries(prior), null, 2))
      return prior.get(c)!
    },
    async standing() { return [...prior.entries()].filter(([, n]) => n >= 3).map(([c]) => c) },
  }
}

export const STORE_KIND = REDIS_URL && REDIS_TOKEN ? 'redis' : 'memory'
const backend: Backend = REDIS_URL && REDIS_TOKEN ? redisBackend(REDIS_URL, REDIS_TOKEN) : memoryBackend()

export const store = {
  ...backend,
  create(id: string, prompt: string): Run {
    return {
      id, prompt, divergences: [], etaSeconds: 0, prefetch: [], output: '', diff: '', startedAt: Date.now(),
      actions: {}, committed: {}, unlockedCount: 0, done: false,
    }
  },
  get: (id: string) => backend.load(id),
  /** Run orang lain yang masih berjalan dan sudah punya pohon: bahan pohon multiplayer. */
  async others(exclude: string) {
    const id = await backend.latestActive(exclude)
    const run = id ? await backend.load(id) : undefined
    return run && !run.done && run.divergences.length ? run : undefined
  },
  /** Divergensi yang boleh dilihat/dipangkas user: tier gratis + yang sudah dibayar. */
  visible: (r: Run) => r.divergences.slice(0, GUARDS.freeBranches + r.unlockedCount),
  locked: (r: Run) => Math.max(0, r.divergences.length - GUARDS.freeBranches - r.unlockedCount),
}
