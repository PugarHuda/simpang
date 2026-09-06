import { store } from '@/lib/store'

/** The state of one run (polled by the UI) and the multiplayer tree.
 *  ?runId=<id>       -> the current state of that run (tree, commits, actions, diff, prefetch)
 *  ?exclude=<your-id> -> another run in flight, for you to help prune.
 *  Pruning it goes through the ordinary /api/steer with their runId. */
export async function GET(req: Request) {
  const u = new URL(req.url)
  const byId = u.searchParams.get('runId')
  const run = byId ? await store.get(byId) : await store.others(u.searchParams.get('exclude') ?? '')
  if (!run) return Response.json({ error: byId ? 'no such run' : 'no other run in flight' }, { status: 404 })
  return Response.json({
    runId: run.id,
    prompt: run.prompt,
    done: run.done,
    etaSeconds: run.etaSeconds,
    divergences: store.visible(run),
    locked: store.locked(run),
    committed: run.committed,
    actions: run.actions,
    diff: byId ? run.diff : undefined,
    output: byId ? run.output : undefined,   // lets the UI recover after the SSE connection drops
    prefetch: byId ? run.prefetch : undefined,
  })
}
