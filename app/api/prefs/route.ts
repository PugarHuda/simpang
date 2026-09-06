import { z } from 'zod'
import { store } from '@/lib/store'

/** Learned preferences: constraints the user has killed. >= 3x makes one "standing", and it
 *  is injected into the scan as a settled decision. The UI lists them and can forget one, so
 *  the learning is visible and reversible. */
export async function GET() {
  const all = await store.priorAll()
  const prefs = Object.entries(all)
    .map(([constraint, count]) => ({ constraint, count, standing: count >= 3 }))
    .sort((a, b) => b.count - a.count)
  return Response.json({ prefs })
}

const Body = z.object({ constraint: z.string().min(1).max(500) })

export async function DELETE(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'constraint required' }, { status: 400 })
  await store.forgetPrior(parsed.data.constraint)
  return Response.json({ ok: true })
}
