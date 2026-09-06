import { streamText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { GUARDS, MODELS } from '@/lib/config'
import { store } from '@/lib/store'
import { workspace } from '@/lib/repo'
import { researchTools } from '@/lib/tools'
import { rateLimited } from '@/lib/ratelimit'

export const maxDuration = 300

const Body = z.object({ runId: z.string().uuid(), divergenceId: z.string().min(1), branchIdx: z.union([z.literal(0), z.literal(1)]) })

/** Fork koreksi: TIDAK mengulang dari nol. Agent bekerja di working copy yang sama
 *  (dihidupkan lagi dari store kalau instance-nya beda), merevisi hanya yang bergantung
 *  pada keputusan itu, dan diff-nya diperbarui. Untuk tugas riset: deliverable ditulis
 *  ulang untuk cabang alternatif, dengan tool data hidup. Juga dipakai tombol "terapkan"
 *  pada prefetch: cabang yang sudah dihitung selama menunggu jadi jawaban utama. */
export async function POST(req: Request) {
  const limited = await rateLimited(req)
  if (limited) return limited
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'runId, divergenceId, branchIdx required' }, { status: 400 })
  const { runId, divergenceId, branchIdx } = parsed.data
  const run = await store.get(runId)
  const d = run?.divergences.find((x) => x.id === divergenceId)
  if (!run || !d) return Response.json({ error: 'not found' }, { status: 404 })
  const b = d.branches[branchIdx]
  const ws = workspace(runId, await store.loadFiles(runId))
  run.committed[divergenceId] = branchIdx   // fork = koreksi keputusan yang sudah lewat
  await store.setCommit(runId, divergenceId, branchIdx)
  const isCode = run.diff.length > 0
  const ready = run.prefetch.find((p) => p.divergenceId === divergenceId && p.branchIdx === branchIdx && p.status === 'done')

  const result = streamText({
    model: MODELS.main,
    stopWhen: stepCountIs(12),
    maxOutputTokens: GUARDS.maxOutputTokens,
    system: isCode
      ? 'You are revising your own earlier refactor. Change ONLY what depends on the decision below. ' +
        'Read the current files before writing. Keep everything else byte-identical. ' +
        'Start your reply with one line: "↻ forked: <what changes>".'
      : 'You are revising your own earlier deliverable for a different decision. Rewrite only the parts that ' +
        'depend on it; keep the rest. Use marketData / webSearch / paidFetch if the new branch needs fresh data. ' +
        'Answer in the language of the original request. Start with one line: "↻ forked: <what changes>".',
    prompt:
      `Original request: ${run.prompt}\n\nYour earlier output:\n${run.output.slice(-6000)}\n\n` +
      (isCode ? `Current diff:\n${run.diff.slice(0, 12000)}\n\n` : '') +
      (ready ? `A draft for this branch was prepared while waiting; reuse what fits:\n${ready.text.slice(0, 3000)}\n\n` : '') +
      `Revise for this decision: ${b.constraintIfPinned}\nIntended shape: ${b.sketch}`,
    tools: {
      ...researchTools(() => {}),
      readFile: tool({
        description: 'Read a file from the working copy',
        inputSchema: z.object({ path: z.string() }),
        execute: async ({ path }) => ws.read(path) ?? `not found: ${path}`,
      }),
      writeFile: tool({
        description: 'Write a complete file into the working copy',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: async ({ path, content }) => { ws.write(path, content); return `wrote ${path}` },
      }),
    },
    onFinish: async ({ text }) => {
      run.diff = ws.diff()
      run.output += `\n\n${text}`
      await store.saveFiles(runId, ws.changed())
      await store.saveBase(run)
    },
  })
  return result.toTextStreamResponse()
}
