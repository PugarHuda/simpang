import { NextRequest, NextResponse } from 'next/server'
import { withX402 } from '@x402/next'
import { declareDiscoveryExtension } from '@x402/extensions/bazaar'
import { z } from 'zod'
import { X402 } from '@/lib/config'
import { x402Server } from '@/lib/x402'
import { scan } from '@/lib/divergence'
import { repoContext } from '@/lib/repo'
import { rateLimited } from '@/lib/ratelimit'

export const maxDuration = 60

/** SIMPANG as a data SELLER for other agents: the divergence scan as a paid x402 API.
 *  Send a prompt, pay 0.02 USDC, get the decision points plus ready-to-inject constraints.
 *  It is declared to the Bazaar (discovery) so other agents can find it, and SIMPANG's own
 *  paidFetch tool can buy it: the buyer-seller loop closed end to end. */
const Body = z.object({ prompt: z.string().trim().min(3).max(2000), repoContext: z.string().max(60_000).optional() })

const handler = async (req: NextRequest): Promise<NextResponse<unknown>> => {
  const limited = await rateLimited(req)
  if (limited) return NextResponse.json(await limited.json(), { status: 429 })
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return NextResponse.json({ error: 'prompt required (3-2000 chars)' }, { status: 400 })
  const t0 = Date.now()
  const { divergences, etaSeconds } = await scan(parsed.data.prompt, parsed.data.repoContext ?? repoContext(), [])
  return NextResponse.json({ prompt: parsed.data.prompt, etaSeconds, divergences, scanMs: Date.now() - t0 })
}

export const POST = withX402(
  handler,
  {
    '/api/paid/scan': {
      accepts: { scheme: 'exact', price: process.env.X402_SCAN_PRICE ?? '$0.02', network: X402.network, payTo: X402.payTo },
      description: 'Divergence scan: the decision points an AI coding agent will hit for a prompt, each with two branches, confidence, and ready-to-inject constraints.',
      mimeType: 'application/json',
      serviceName: 'SIMPANG',
      tags: ['ai', 'agents', 'planning', 'code'],
      extensions: declareDiscoveryExtension({
        bodyType: 'json',
        input: { prompt: 'refactor the auth system to use sessions' },
        inputSchema: {
          type: 'object',
          properties: {
            prompt: { type: 'string', description: 'the task the agent is about to do' },
            repoContext: { type: 'string', description: 'optional: files of the repo the agent will edit' },
          },
          required: ['prompt'],
        },
        output: {
          example: {
            etaSeconds: 120,
            divergences: [{ id: 'storage', axis: 'session storage', question: 'Where do sessions live?',
              branches: [{ label: 'postgres table', confidence: 0.62, constraintIfPinned: 'Use a postgres sessions table.', constraintIfKilled: 'Do NOT choose "postgres table". Use redis for sessions.' }] }],
          },
        },
      }),
    },
  },
  x402Server,
)
