import { streamText, generateText, generateObject, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { GUARDS, MODELS, HAS_MODEL, X402 } from '@/lib/config'
import { scan, type Divergence } from '@/lib/divergence'
import { store, type Run } from '@/lib/store'
import { listFiles, repoContext, workspace } from '@/lib/repo'
import { researchTools } from '@/lib/tools'
import { rateLimited } from '@/lib/ratelimit'

export const maxDuration = 300

type Emit = (e: Record<string, unknown>) => void
const Body = z.object({ prompt: z.string().trim().min(3).max(2000) })

export async function POST(req: Request) {
  const limited = await rateLimited(req)   // this endpoint burns model money and is open to the internet
  if (limited) return limited
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'prompt required (3-2000 chars)' }, { status: 400 })
  if (!HAS_MODEL) return Response.json({ error: 'no model provider configured (VENICE_API_KEY etc.)' }, { status: 503 })
  const { prompt } = parsed.data
  const runId = crypto.randomUUID()
  const run = store.create(runId, prompt, req.headers.get('x-simpang-client') ?? '')
  // Same rule everywhere below: a store failure degrades steering, it never cancels the agent.
  await store.saveBase(run).catch((e) => console.warn('saveBase dropped:', String(e).slice(0, 160)))

  // Outside start(): cancel() has to be able to switch it off when the client hangs up.
  let open = true
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      const emit: Emit = (e) => { if (open) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)) }

      emit({ type: 'run', runId })

      // The scan and the main run START TOGETHER. The scan never blocks the main run.
      const context = repoContext()
      // The scan AND its store are optional: if Redis hiccups, the user still gets the agent.
      // Without this .catch() a single store error takes the whole main run down with it.
      const scanning = store.standing().then((standing) => scan(prompt, context, standing)).then(async ({ divergences, etaSeconds }) => {
        run.etaSeconds = etaSeconds
        // Estimated wait too short: the panel is not worth showing. No tree = no steering.
        if (etaSeconds && etaSeconds < GUARDS.minEtaSeconds) {
          emit({ type: 'scan', divergences: [], locked: 0, etaSeconds, skipped: 'short-wait' })
          return
        }
        run.divergences = divergences
        await store.saveBase(run)   // steer/unlock/others in another process need the tree
        if (divergences.length) {
          emit({ type: 'scan', divergences: store.visible(run), locked: store.locked(run), price: X402.price, etaSeconds })
          void prefetch(run, context, emit)   // the alternative branch is computed WHILE you wait
        }
      }).catch((err) => console.warn('scan path dropped:', String(err).slice(0, 200)))

      try {
        await scanning // the tree has to exist before the user can prune it
        await liveRun(run, prompt, emit)
      } catch (err) {
        emit({ type: 'error', message: String(err) })
      }

      try { await finish(run, emit) } catch (err) { emit({ type: 'error', message: String(err) }) }
      if (open) { open = false; controller.close() }
    },
    // Tab closed / connection dropped. Without this the next emit throws from inside start()
    // and becomes an unhandled rejection.
    // ponytail: the run still finishes (its cost is capped by the rate limit).
    // Pass req.signal into streamText if abandoned runs start showing up on the bill.
    cancel() { open = false },
  })

  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  })
}

/* ---------------------------------------------------------------- main ---- */

async function liveRun(run: Run, prompt: string, emit: Emit) {
  const ws = workspace(run.id)
  const divergences = run.divergences

  // The main run is handed the tree's vocabulary: id, axis, the two exact labels. Committing = the `decide` tool call.
  const vocabulary = divergences.length
    ? '\n\nDecision points already identified for this task. BEFORE writing any file, call the `decide` tool ' +
      'once per decision point you have resolved. This is MANDATORY before the first writeFile:\n' +
      divergences.map((d) => `- ${d.id} (${d.axis}): 0 = "${d.branches[0].label}", 1 = "${d.branches[1].label}"`).join('\n')
    : ' State each decision on its own line as: "Decision - <axis>: going with <choice>."'
  const ids = divergences.map((d) => d.id)

  // Code task: repo tools. Research/analysis task: live-data tools. The final answer is the deliverable.
  const system = 'You are a capable agent. Decide from the request what kind of task it is.\n' +
    '- Code task: read the repo with readFile before writing; write complete files with writeFile ' +
    '(the user sees a real diff); finish with a short summary.\n' +
    '- Research/analysis task (prices, news, comparisons, reports): fetch live data with marketData / webSearch / ' +
    'paidFetch, then write the full deliverable as your final answer in markdown with concrete numbers, dates and sources. ' +
    'Never say you lack data access: you have these tools. Answer in the language of the request.' + vocabulary
  const steering: string[] = []   // every directive that has landed; they hold until the run ends

  const result = streamText({
    model: MODELS.main,
    stopWhen: stepCountIs(30),   // one-tool-per-step models (qwen) need more than 16
    maxOutputTokens: GUARDS.maxOutputTokens,
    // Without this a provider error closes the stream silently and the user just sees a blank screen.
    onError: ({ error }) => emit({ type: 'error', message: String(error) }),
    system,
    prompt: `${prompt}\n\nFiles in the repo (only relevant for code tasks): ${listFiles().join(', ')}`,
    tools: {
      ...researchTools(emit),
      readFile: tool({
        description: 'Read a file from the repo',
        inputSchema: z.object({ path: z.string() }),
        execute: async ({ path }) => {
          emit({ type: 'tool', name: 'read', path })
          return ws.read(path) ?? `not found: ${path}`
        },
      }),
      writeFile: tool({
        description: 'Write a complete file into the working copy of the repo',
        inputSchema: z.object({ path: z.string(), content: z.string() }),
        execute: async ({ path, content }) => {
          ws.write(path, content)
          emit({ type: 'tool', name: 'write', path, lines: content.split('\n').length })
          return `wrote ${path} (${content.split('\n').length} lines)`
        },
      }),
      // Committing is a tool call, not a text pattern. Models obey a schema far more
      // reliably than a sentence format, and the result is structured for free.
      // branch takes 0/1 as a number OR a string: qwen sends "0", and a strict schema
      // made it fail over and over without ever recording a commit.
      decide: tool({
        description: 'Record which branch you are taking for an identified decision point.',
        inputSchema: z.object({
          decision: ids.length ? z.enum(ids as [string, ...string[]]) : z.string(),
          branch: z.union([z.number(), z.string()]).describe('0 or 1'),
          why: z.string().describe('one short sentence'),
        }),
        execute: async ({ decision, branch, why }) => {
          const d = run.divergences.find((x) => x.id === decision)
          if (!d) return 'unknown decision'
          const idx = Number(branch)
          if (idx !== 0 && idx !== 1) return 'branch must be 0 or 1'
          run.committed[d.id] = idx
          await store.setCommit(run.id, d.id, idx)
          emit({ type: 'commit', divergenceId: d.id, branchIdx: idx, why: String(why).slice(0, 200) })
          return `recorded: ${d.axis} -> ${d.branches[idx].label}`
        },
      }),
    },

    // === THE INJECTION POINT. At every tool-call boundary the steering queue is drained. ===
    // SDK 7 forbids a system message in the middle of `messages`; the way in is to override
    // `instructions` per step.
    prepareStep: async ({ stepNumber }) => {
      emit({ type: 'step', n: stepNumber })
      const [pending, fresh] = await Promise.all([store.drain(run.id), store.get(run.id)])
        .catch((e): [string[], undefined] => {
          console.warn('steer drain dropped:', String(e).slice(0, 160))
          return [[], undefined]
        })
      // The owner sees actions arriving from other people (the multiplayer tree) without polling.
      if (fresh && Object.keys(fresh.actions).length) emit({ type: 'actions', actions: fresh.actions })
      if (pending.length) {
        steering.push(...pending)
        emit({ type: 'applied', constraints: pending })
      }
      if (!steering.length) return {}
      return {
        instructions:
          system +
          '\n\nThe user issued live steering directives. They OVERRIDE your earlier plan. ' +
          'Apply them from this step onward:\n' +
          steering.map((p) => `- ${p}`).join('\n'),
      }
    },
  })

  for await (const delta of result.textStream) {
    run.output += delta
    emit({ type: 'text', delta })
    // The pattern is newline-terminated; without this guard the whole output is re-scanned per token (O(n^2)).
    if (delta.includes('\n')) await detectCommits(run, emit)
  }
  run.diff = ws.diff()
  // a fork on another instance can continue this working copy
  await Promise.all([store.saveFiles(run.id, ws.changed()), store.saveBase(run)])
    .catch((e) => console.warn('persist dropped:', String(e).slice(0, 160)))
  emit({ type: 'patch', diff: run.diff, finishReason: await result.finishReason })
}

/* ------------------------------------------------------------ prefetch ---- */

/** The branch the main run probably will NOT take (the lower-confidence one) is really
 *  computed while you wait: a concrete plan plus code, ready the moment the answer lands.
 *  If you kill that branch the work is dropped; if the main run picks it after all,
 *  the result is hidden. */
async function prefetch(run: Run, context: string, emit: Emit) {
  const targets = run.divergences
    .slice(0, GUARDS.prefetchCap)
    .map((d) => ({ d, i: d.branches[0].confidence >= d.branches[1].confidence ? 1 : 0 }))
  await Promise.all(targets.map(async ({ d, i }) => {
    const b = d.branches[i]
    const entry = { divergenceId: d.id, branchIdx: i, label: b.label, text: '', status: 'running' as const }
    run.prefetch.push(entry)
    try {
      const { text } = await generateText({
        model: MODELS.prefetch,
        maxOutputTokens: 700,
        system: 'You prepare a ready-to-use alternative for a task. Be concrete and terse, no preamble. ' +
          'If the task is about code: the files to touch, then the key snippet. Otherwise: the alternative ' +
          'deliverable itself in outline form (what changes, what it would show, what it needs). ' +
          'Answer in the language of the task.',
        prompt: `Task: ${run.prompt}\n\nThe agent will likely choose "${d.branches[1 - i].label}" for the decision "${d.axis}". ` +
          `Prepare the alternative "${b.label}" (${b.sketch}) so the user can switch with one action.` +
          (/\b(refactor|code|file|api|bug|test|implement|migrate|fix)\b/i.test(run.prompt) ? `\n\nRepo:\n${context}` : ''),
      })
      const fresh = await store.get(run.id)
      const killed = fresh?.actions[d.id]?.verb === 'kill' && fresh.actions[d.id].branchIdx === i
      Object.assign(entry, { text, status: killed ? 'dropped' : 'done' })
      emit({ type: 'prefetch', divergenceId: d.id, branchIdx: i, label: b.label, status: entry.status })
    } catch (err) {
      Object.assign(entry, { status: 'dropped', text: String(err) })
    }
  }))
}

/* ------------------------------------------------------- commit + score ---- */

/** Fallback for a model that writes "Decision - <axis>: going with <label>." instead of
 *  calling the decide tool. Match the axis, then the exact label; fall back to word overlap
 *  only when it paraphrased. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const words = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length >= 3))
async function detectCommits(run: Run, emit: Emit) {
  for (const m of run.output.matchAll(/Decision - ([^:\n]+): going with ([^\n]+?)\.?(?:\n|$)/g)) {
    const axis = norm(m[1]), choice = norm(m[2])
    const d = run.divergences.find((x) => !(x.id in run.committed) &&
      (norm(x.axis) === axis || [...words(x.axis)].some((w) => words(m[1]).has(w))))
    if (!d) continue
    let idx = d.branches.findIndex((b) => choice.includes(norm(b.label)))
    if (idx < 0) {
      const score = d.branches.map((b) => [...words(b.label)].filter((w) => words(m[2]).has(w)).length)
      if (score[0] === score[1]) continue
      idx = score[0] > score[1] ? 0 : 1
    }
    run.committed[d.id] = idx
    await store.setCommit(run.id, d.id, idx)
    emit({ type: 'commit', divergenceId: d.id, branchIdx: idx })
  }
}

/** A model that ignores the `decide` tool still gets its commits: the scan model classifies
 *  the diff and the log (cheap, structured output). A real post-hoc classifier, not keyword
 *  guessing. */
async function classifyCommits(run: Run, emit: Emit) {
  const open = run.divergences.filter((d) => !(d.id in run.committed))
  if (!open.length || (!run.diff && !run.output)) return
  try {
    const { object } = await generateObject({
      model: MODELS.prefetch,   // non-reasoning: 400 output tokens must become JSON, not thoughts
      maxOutputTokens: 400,
      abortSignal: AbortSignal.timeout(12000),
      schema: z.object({ decisions: z.array(z.object({ id: z.string(), branch: z.number(), confident: z.boolean() })) }),
      system: 'You read a code diff and decide which of two branches the author took for each decision point. ' +
        'branch is 0 or 1. confident=false if the diff does not show it.',
      prompt: open.map((d) => `${d.id}: 0 = "${d.branches[0].label}" (${d.branches[0].sketch}); 1 = "${d.branches[1].label}" (${d.branches[1].sketch})`).join('\n') +
        `\n\nAgent log:\n${run.output.slice(-3000)}\n\nDiff:\n${run.diff.slice(0, 14000)}`,
    })
    for (const x of object.decisions) {
      const d = open.find((o) => o.id === x.id)
      if (!d || !x.confident || (x.branch !== 0 && x.branch !== 1)) continue
      run.committed[d.id] = x.branch
      await store.setCommit(run.id, d.id, x.branch)
      emit({ type: 'commit', divergenceId: d.id, branchIdx: x.branch, why: 'classified from diff' })
    }
  } catch (err) {
    console.warn('classify dropped:', String(err).slice(0, 160))
  }
}

async function finish(run: Run, emit: Emit) {
  await classifyCommits(run, emit)

  // User actions arrive from any process: read the shared state, not the local copy.
  const shared = (await store.get(run.id)) ?? run
  const acted = Object.entries(run.committed).filter(([id]) => shared.actions[id])
  const hits = acted.filter(([id, idx]) => {
    const a = shared.actions[id]
    return a.verb === 'pin' ? a.branchIdx === idx : a.branchIdx !== idx
  })
  const calibration = acted.length ? hits.length / acted.length : null

  // Prefetches still in flight get a short grace period; the rest is reported as it stands.
  const deadline = Date.now() + 8000
  while (run.prefetch.some((p) => p.status === 'running') && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 250))

  // Only branches the user did not kill and the main run did not take: finished follow-ups.
  const ready = run.prefetch.filter((p) =>
    p.status === 'done' &&
    !(shared.actions[p.divergenceId]?.verb === 'kill' && shared.actions[p.divergenceId].branchIdx === p.branchIdx) &&
    run.committed[p.divergenceId] !== p.branchIdx)

  await store.saveBase(run)
  await store.setDone(run.id)
  emit({
    type: 'done',
    calibration,
    prefetch: ready.map(({ divergenceId, branchIdx, label, text }) => ({ divergenceId, branchIdx, label, text })),
    elapsedMs: Date.now() - run.startedAt,
  })
}

export type { Divergence }
