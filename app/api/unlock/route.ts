import { NextRequest, NextResponse } from 'next/server'
import { withX402 } from '@x402/next'
import { X402 } from '@/lib/config'
import { x402Server } from '@/lib/x402'
import { store } from '@/lib/store'

/** Buka SATU divergensi terkunci berikutnya. Dilindungi x402 lewat SDK resmi:
 *  tanpa PAYMENT-SIGNATURE -> 402 + PAYMENT-REQUIRED; dengan pembayaran valid ->
 *  handler ini jalan, lalu SDK men-settle lewat facilitator dan menaruh PAYMENT-RESPONSE.
 *  runId lewat query karena body request sudah bisa dibaca SDK. */
const handler = async (req: NextRequest): Promise<NextResponse<unknown>> => {
  const runId = req.nextUrl.searchParams.get('runId') ?? ''
  const run = store.get(runId)
  if (!run) return NextResponse.json({ error: 'no such run' }, { status: 404 })
  if (!store.locked(run)) return NextResponse.json({ error: 'nothing locked' }, { status: 409 })
  run.unlockedCount++
  const opened = store.visible(run).at(-1)!
  return NextResponse.json({ divergence: opened, locked: store.locked(run) })
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
