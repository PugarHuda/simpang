import { HTTPFacilitatorClient } from '@x402/core/server'
import { withBazaar, type DiscoveryResource } from '@x402/extensions/bazaar'
import { Redis } from '@upstash/redis'

/** The x402 Bazaar catalog (discovery) through the official SDK. The CDP facilitator indexes
 *  paid endpoints that have settled with a discovery declaration; the SDK gives listResources
 *  and search. Note: some Indonesian ISPs DNS-block api.cdp.coinbase.com (it resolves to
 *  internetbaik.telkomsel.com); from a Vercel Singapore server it is reachable. */
export const BAZAAR_URL = process.env.X402_BAZAAR_URL ?? 'https://api.cdp.coinbase.com/platform/v2/x402'
const bazaar = withBazaar(new HTTPFacilitatorClient({ url: BAZAAR_URL, timeoutMs: 12_000 }))

const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL
const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN
const cache = url && token ? new Redis({ url, token }) : null

export type PaidResource = {
  url: string; description: string; service?: string; tags?: string[]
  network: string; price: string; asset: string; payTo: string; mimeType?: string
}

const shape = (r: DiscoveryResource): PaidResource[] =>
  (r.accepts ?? []).map((a) => ({
    url: r.resource, description: r.description ?? '', service: r.serviceName, tags: r.tags,
    network: a.network, price: `${Number(a.amount) / 1e6} USDC`, asset: a.asset, payTo: a.payTo, mimeType: r.mimeType,
  }))

/** Search for paid resources. Cached for 10 minutes (the catalog changes rarely and the RPC is far away). */
export async function findPaidResources(query: string, network?: string, limit = 8): Promise<{ total: number; items: PaidResource[] }> {
  const key = `bazaar:${network ?? '*'}:${query.toLowerCase().trim()}`
  const hit = cache ? await cache.get<{ total: number; items: PaidResource[] }>(key).catch(() => null) : null
  if (hit) return hit
  const res = query.trim()
    ? await bazaar.extensions.bazaar.search({ query, type: 'http', network, limit })
    : await bazaar.extensions.bazaar.listResources({ type: 'http', network, limit })
  const list = 'resources' in res ? res.resources : res.items
  const pg = 'pagination' in res ? res.pagination : null
  const total = pg && 'total' in pg ? pg.total : list.length
  const out = { total, items: list.flatMap(shape).slice(0, limit) }
  if (cache) await cache.set(key, out, { ex: 600 }).catch(() => {})
  return out
}

/** For /api/health: is the catalog reachable from this server, and how big is it. */
export async function bazaarHealth(): Promise<{ reachable: boolean; total?: number; error?: string }> {
  try {
    const res = await bazaar.extensions.bazaar.listResources({ type: 'http', limit: 1 })
    return { reachable: true, total: res.pagination?.total ?? res.items.length }
  } catch (e) {
    return { reachable: false, error: String((e as Error).message ?? e).slice(0, 160) }
  }
}
