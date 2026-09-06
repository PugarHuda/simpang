import { store } from '@/lib/store'

/** State sebuah run (dipoll UI) dan pohon multiplayer.
 *  ?runId=<id>      -> state terkini run itu (pohon, commit, aksi, diff, prefetch)
 *  ?exclude=<id-mu> -> run lain yang sedang berjalan, untuk kamu bantu pangkas.
 *  Pangkasannya lewat /api/steer biasa dengan runId mereka. */
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
    output: byId ? run.output : undefined,   // pemulihan UI setelah koneksi SSE putus
    prefetch: byId ? run.prefetch : undefined,
  })
}
