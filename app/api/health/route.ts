import { HAS_MODEL, X402 } from '@/lib/config'
import { store, STORE_KIND } from '@/lib/store'
import { bazaarHealth } from '@/lib/bazaar'

export const maxDuration = 30

/** The real status of every integration: model provider, store, x402 facilitator, Bazaar
 *  catalog, agent wallet. For judges, and for us when something dies quietly. */
export async function GET() {
  const t0 = Date.now()
  const [redis, facilitator, bazaar] = await Promise.all([
    store.standing().then(() => ({ ok: true })).catch((e) => ({ ok: false, error: String(e).slice(0, 120) })),
    fetch(`${X402.facilitator}/supported`, { signal: AbortSignal.timeout(8000) })
      .then(async (r) => ({ ok: r.ok, kinds: r.ok ? ((await r.json()).kinds?.length ?? 0) : 0 }))
      .catch((e) => ({ ok: false, kinds: 0, error: String(e).slice(0, 120) })),
    bazaarHealth(),
  ])
  const body = {
    ok: HAS_MODEL && redis.ok && facilitator.ok,
    model: HAS_MODEL ? 'configured' : 'missing',
    store: { kind: STORE_KIND, ...redis },
    x402: { network: X402.network, payTo: X402.payTo, facilitator: X402.facilitator, ...facilitator },
    bazaar,
    agentWallet: process.env.X402_BUYER_PRIVATE_KEY ? 'configured' : 'missing',
    region: process.env.VERCEL_REGION ?? 'local',
    ms: Date.now() - t0,
  }
  return Response.json(body, { status: body.ok ? 200 : 503, headers: { 'cache-control': 'no-store' } })
}
