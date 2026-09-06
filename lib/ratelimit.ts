import { Ratelimit } from '@upstash/ratelimit'
import { Redis } from '@upstash/redis'

/** /api/run and /api/fork burn model money per call and are open to the internet.
 *  A per-IP sliding window plus a global daily cap. With Redis: @upstash/ratelimit (shared across
 *  instances); without Redis: an in-memory sliding window for the single process.
 *  SIMPANG_RUN_LIMIT / SIMPANG_DAILY_LIMIT override the defaults. */
const PER_IP = Number(process.env.SIMPANG_RUN_LIMIT ?? 8)          // per hour per IP
const DAILY = Number(process.env.SIMPANG_DAILY_LIMIT ?? 150)       // all IPs, per day

const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN

type Verdict = { ok: boolean; remaining: number; resetMs: number; scope: 'ip' | 'daily' | 'none' }

let check: (ip: string) => Promise<Verdict>

if (url && token) {
  const redis = new Redis({ url, token })
  const perIp = new Ratelimit({ redis, limiter: Ratelimit.slidingWindow(PER_IP, '1 h'), prefix: 'rl:ip', analytics: false })
  const daily = new Ratelimit({ redis, limiter: Ratelimit.fixedWindow(DAILY, '1 d'), prefix: 'rl:day', analytics: false })
  check = async (ip) => {
    const [a, b] = await Promise.all([perIp.limit(ip), daily.limit('all')])
    if (!a.success) return { ok: false, remaining: 0, resetMs: a.reset - Date.now(), scope: 'ip' }
    if (!b.success) return { ok: false, remaining: 0, resetMs: b.reset - Date.now(), scope: 'daily' }
    return { ok: true, remaining: Math.min(a.remaining, b.remaining), resetMs: 0, scope: 'none' }
  }
} else {
  const hits = new Map<string, number[]>()
  const window = (key: string, limit: number, ms: number): Verdict => {
    const now = Date.now()
    const arr = (hits.get(key) ?? []).filter((t) => now - t < ms)
    if (arr.length >= limit) return { ok: false, remaining: 0, resetMs: arr[0] + ms - now, scope: key === 'all' ? 'daily' : 'ip' }
    arr.push(now); hits.set(key, arr)
    return { ok: true, remaining: limit - arr.length, resetMs: 0, scope: 'none' }
  }
  check = async (ip) => {
    const a = window(ip, PER_IP, 3600_000)
    if (!a.ok) return a
    return window('all', DAILY, 86_400_000)
  }
}

export const clientIp = (req: Request) =>
  req.headers.get('x-forwarded-for')?.split(',')[0].trim() || req.headers.get('x-real-ip') || 'local'

/** null when the request may proceed; a 429 Response when it may not. */
export async function rateLimited(req: Request): Promise<Response | null> {
  const v = await check(clientIp(req))
  if (v.ok) return null
  const secs = Math.max(1, Math.ceil(v.resetMs / 1000))
  return Response.json(
    { error: v.scope === 'ip' ? `too many runs from this address, try again in ${Math.ceil(secs / 60)} min` : 'this instance is out of daily quota' },
    { status: 429, headers: { 'retry-after': String(secs) } },
  )
}
