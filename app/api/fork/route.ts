import { streamText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { GUARDS, MODELS } from '@/lib/config'
import { store } from '@/lib/store'
import { workspace } from '@/lib/repo'

const Body = z.object({ runId: z.string().uuid(), divergenceId: z.string().min(1), branchIdx: z.union([z.literal(0), z.literal(1)]) })

/** Fork koreksi: TIDAK mengulang dari nol. Agent bekerja di working copy yang sama,
 *  merevisi hanya yang bergantung pada keputusan itu, dan diff-nya diperbarui.
 *  Misprediction penalty jadi murah. */
export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'runId, divergenceId, branchIdx required' }, { status: 400 })
  const { runId, divergenceId, branchIdx } = parsed.data
  const run = store.get(runId)
  const d = run?.divergences.find((x) => x.id === divergenceId)
  if (!run || !d) return Response.json({ error: 'not found' }, { status: 404 })
  const b = d.branches[branchIdx]
  const ws = workspace(runId)
  run.committed[divergenceId] = branchIdx   // fork = koreksi keputusan yang sudah lewat

  const result = streamText({
    model: MODELS.main,
    stopWhen: stepCountIs(10),
    maxOutputTokens: GUARDS.maxOutputTokens,
    system: 'You are revising your own earlier refactor. Change ONLY what depends on the decision below. ' +
      'Read the current files before writing. Keep everything else byte-identical. ' +
      'Start your reply with one line: "↻ forked: <what changes>".',
    prompt:
      `Original request: ${run.prompt}\n\nYour earlier decision log:\n${run.output.slice(-4000)}\n\n` +
      `Current diff:\n${run.diff.slice(0, 12000)}\n\n` +
      `Revise for this decision: ${b.constraintIfPinned}\nIntended shape: ${b.sketch}`,
    tools: {
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
    onFinish: () => { run.diff = ws.diff() },
  })
  return result.toTextStreamResponse()
}
