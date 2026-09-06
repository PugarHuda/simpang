import { z } from 'zod'
import { store } from '@/lib/store'

const Body = z.object({
  runId: z.string().uuid(),
  divergenceId: z.string().min(1),
  branchIdx: z.union([z.literal(0), z.literal(1)]),
  verb: z.enum(['kill', 'pin']),
})

/** Warm-up: the UI calls this the moment a run starts, so this route's function and Redis
 *  connection are already alive when the first key is pressed (cold steer 1.8 s, warm ~150 ms). */
export async function GET() {
  await store.standing()
  return new Response(null, { status: 204 })
}

/** KILL / PIN. No model call at all — the constraint text was written during the scan.
 *  That is how the "visible effect in under a second" rule is met. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'runId, divergenceId, branchIdx (0|1), verb (kill|pin) required' }, { status: 400 })
  const { runId, divergenceId, branchIdx, verb } = parsed.data
  const run = await store.get(runId)
  if (!run) return Response.json({ error: 'no such run' }, { status: 404 })

  const d = run.divergences.find((x) => x.id === divergenceId)
  if (!d) return Response.json({ error: 'no such divergence' }, { status: 404 })
  if (!store.visible(run).includes(d)) return Response.json({ error: 'locked, pay via /api/unlock' }, { status: 402 })

  const b = d.branches[branchIdx]
  const constraint = verb === 'pin' ? b.constraintIfPinned : b.constraintIfKilled

  // Three levels of degradation. No user action ever evaporates.
  const committed = run.committed[divergenceId]
  const conflicts = committed !== undefined && (verb === 'pin' ? committed !== branchIdx : committed === branchIdx)
  const status = conflicts ? 'late' : run.done ? 'finished' : 'queued'

  // All writes in parallel: one Redis round-trip, not three. The UX claim is "effect in under a second".
  // Attribution: same client id as the run's owner = owner; anyone else is a helper ([tab]).
  const client = req.headers.get('x-simpang-client') ?? ''
  // A run with no recorded owner (called from a script, say) has no helpers.
  const by = !run.owner || client === run.owner ? 'owner' : 'helper'
  await Promise.all([
    store.setAction(runId, divergenceId, { verb, branchIdx, at: Date.now(), by }),
    // The prior is global. If helpers could bump it, a stranger could mark a constraint
    // "settled" in EVERYONE's scans with three kills.
    verb === 'kill' && by === 'owner' ? store.bumpPrior(constraint) : null,
    status === 'queued' ? store.push(runId, constraint) : null,
  ])
  // late: the main run already went the other way (it may even be finished) -> correct it with a fork.
  // finished: done and in agreement -> nothing to change; the prior is already recorded.
  return Response.json(status === 'late' ? { status, injected: constraint, forkable: true } : { status, injected: constraint })
}
