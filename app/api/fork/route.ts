import { streamText, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { GUARDS, MODELS } from '@/lib/config'
import { store } from '@/lib/store'
import { workspace } from '@/lib/repo'
import { researchTools } from '@/lib/tools'
import { rateLimited } from '@/lib/ratelimit'

export const maxDuration = 300

const Body = z.object({ runId: z.string().uuid(), divergenceId: z.string().min(1), branchIdx: z.union([z.literal(0), z.literal(1)]) })

/** A correcting fork: it does NOT start over. The agent works in the same working copy
 *  (rehydrated from the store if this is a different instance), revises only what depends on
 *  that decision, and the diff is updated. For a research task the deliverable is rewritten
 *  for the alternative branch using the live-data tools. This is also what the prefetch
 *  "apply" button calls: the branch computed while you waited becomes the main answer. */
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
  run.committed[divergenceId] = branchIdx   // a fork corrects a decision that already happened
  await store.setCommit(runId, divergenceId, branchIdx)
  const isCode = run.diff.length > 0
  const ready = run.prefetch.find((p) => p.divergenceId === divergenceId && p.branchIdx === branchIdx && p.status === 'done')

  // A fork is a second agent run and needs the same guards as the first. Without them a provider
  // error closed the stream silently and the page sat on "↻ forking…" until the tab was closed.
  const deadline = Date.now() + GUARDS.runBudgetMs
  const result = streamText({
    model: MODELS.main,
    stopWhen: [stepCountIs(12), () => Date.now() > deadline],
    maxOutputTokens: GUARDS.maxOutputTokens,
    onError: ({ error }) => console.warn('fork dropped:', String(error).slice(0, 200)),
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
