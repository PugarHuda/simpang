import { z } from 'zod'
import { store } from '@/lib/store'

/** Preferensi yang dipelajari: constraint yang dibunuh user. >= 3x = "standing" dan
 *  disuntik ke scan sebagai keputusan yang sudah selesai. UI menampilkannya dan bisa
 *  melupakannya, supaya pembelajaran ini terlihat dan bisa dibatalkan. */
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
