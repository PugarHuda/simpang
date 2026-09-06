import { HTTPFacilitatorClient } from '@x402/core/server'
import { withBazaar, type DiscoveryResource } from '@x402/extensions/bazaar'
import { Redis } from '@upstash/redis'

/** Katalog x402 Bazaar (discovery) lewat SDK resmi. Facilitator CDP mengindeks endpoint
 *  berbayar yang pernah di-settle dengan deklarasi discovery; SDK menyediakan listResources
 *  dan search. Catatan: dari beberapa ISP Indonesia api.cdp.coinbase.com diblokir DNS
 *  (resolve ke internetbaik.telkomsel.com); dari server Vercel Singapura tidak. */
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

/** Cari resource berbayar. Hasil di-cache 10 menit (katalog jarang berubah, RPC-nya jauh). */
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

/** Untuk /api/health: apakah katalog terjangkau dari server ini, dan seberapa besar. */
export async function bazaarHealth(): Promise<{ reachable: boolean; total?: number; error?: string }> {
  try {
    const res = await bazaar.extensions.bazaar.listResources({ type: 'http', limit: 1 })
    return { reachable: true, total: res.pagination?.total ?? res.items.length }
  } catch (e) {
    return { reachable: false, error: String((e as Error).message ?? e).slice(0, 160) }
  }
}
