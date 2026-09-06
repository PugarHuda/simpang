import { z } from 'zod'
import { store } from '@/lib/store'

const Body = z.object({
  runId: z.string().uuid(),
  divergenceId: z.string().min(1),
  branchIdx: z.union([z.literal(0), z.literal(1)]),
  verb: z.enum(['kill', 'pin']),
})

/** KILL / PIN. Tidak memanggil model sama sekali — constraint-nya sudah dibuat
 *  saat scan. Itulah cara memenuhi aturan "efek terlihat < 1 detik". */
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

  // Tiga tingkat degradasi. Tidak ada aksi user yang menguap.
  const committed = run.committed[divergenceId]
  const conflicts = committed !== undefined && (verb === 'pin' ? committed !== branchIdx : committed === branchIdx)
  const status = conflicts ? 'late' : run.done ? 'finished' : 'queued'

  // Semua tulisan paralel: satu round-trip Redis, bukan tiga. Klaim UX-nya "efek < 1 detik".
  await Promise.all([
    store.setAction(runId, divergenceId, { verb, branchIdx, at: Date.now() }),
    verb === 'kill' ? store.bumpPrior(constraint) : null,
    status === 'queued' ? store.push(runId, constraint) : null,
  ])
  // late: main run sudah memilih arah lain (mungkin sudah selesai) -> koreksi lewat fork.
  // finished: selesai dan sejalan -> tidak ada yang diubah; prior sudah dicatat.
  return Response.json(status === 'late' ? { status, injected: constraint, forkable: true } : { status, injected: constraint })
}
