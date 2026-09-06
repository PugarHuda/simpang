import { NextRequest, NextResponse } from 'next/server'
import { withX402 } from '@x402/next'
import { X402, GUARDS } from '@/lib/config'
import { x402Server } from '@/lib/x402'
import { store } from '@/lib/store'

/** Unlock the NEXT single locked divergence. Gated by x402 through the official SDK:
 *  no PAYMENT-SIGNATURE -> 402 + PAYMENT-REQUIRED; with a valid payment this handler runs,
 *  then the SDK settles through the facilitator and attaches PAYMENT-RESPONSE.
 *  runId travels in the query string because the SDK may already have read the body. */
const handler = async (req: NextRequest): Promise<NextResponse<unknown>> => {
  const runId = req.nextUrl.searchParams.get('runId') ?? ''
  const run = await store.get(runId)
  if (!run) return NextResponse.json({ error: 'no such run' }, { status: 404 })
  if (!store.locked(run)) return NextResponse.json({ error: 'nothing locked' }, { status: 409 })
  const n = await store.incrUnlocked(runId)
  const opened = run.divergences[GUARDS.freeBranches + n - 1]
  // Check-locked then incr is not atomic: two concurrent payments for the last slot leave
  // the loser with undefined. Non-2xx -> the SDK does not settle, so nobody pays for nothing.
  if (!opened) return NextResponse.json({ error: 'nothing locked' }, { status: 409 })
  return NextResponse.json({ divergence: opened, locked: Math.max(0, run.divergences.length - GUARDS.freeBranches - n) })
}

export const POST = withX402(
  handler,
  {
    '/api/unlock': {
      accepts: { scheme: 'exact', price: X402.price, network: X402.network, payTo: X402.payTo },
      description: 'Unlock one more decision point in the SIMPANG divergence tree',
      mimeType: 'application/json',
    },
  },
  x402Server,
)
