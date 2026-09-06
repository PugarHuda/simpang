import { streamText, generateText, generateObject, stepCountIs, tool } from 'ai'
import { z } from 'zod'
import { GUARDS, MODELS, HAS_MODEL, X402 } from '@/lib/config'
import { scan, type Divergence } from '@/lib/divergence'
import { store, type Run } from '@/lib/store'
import { listFiles, repoContext, workspace } from '@/lib/repo'

export const maxDuration = 300

type Emit = (e: Record<string, unknown>) => void
const Body = z.object({ prompt: z.string().trim().min(3).max(2000) })

export async function POST(req: Request) {
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'prompt required (3-2000 chars)' }, { status: 400 })
  if (!HAS_MODEL) return Response.json({ error: 'no model provider configured (VENICE_API_KEY etc.)' }, { status: 503 })
  const { prompt } = parsed.data
  const runId = crypto.randomUUID()
  const run = store.create(runId, prompt)

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      let open = true
      const emit: Emit = (e) => { if (open) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)) }

      emit({ type: 'run', runId })

      // Scan dan main run START BERSAMAAN. Scan tidak pernah memblokir main run.
      const context = repoContext()
      const scanning = scan(prompt, context, store.standing()).then(({ divergences, etaSeconds }) => {
        run.etaSeconds = etaSeconds
        // Wait yang diperkirakan terlalu pendek: panel tidak layak muncul. Tanpa pohon = tanpa steering.
        if (etaSeconds && etaSeconds < GUARDS.minEtaSeconds) {
          emit({ type: 'scan', divergences: [], locked: 0, etaSeconds, skipped: 'short-wait' })
          return
        }
        run.divergences = divergences
        if (divergences.length) {
          emit({ type: 'scan', divergences: store.visible(run), locked: store.locked(run), price: X402.price, etaSeconds })
          void prefetch(run, context, emit)   // cabang alternatif dihitung SELAMA menunggu
        }
      })

      try {
        await scanning // pohon harus ada sebelum user bisa memangkasnya
        await liveRun(runId, prompt, emit)
      } catch (err) {
        emit({ type: 'error', message: String(err) })
      }

      await finish(runId, emit)
      open = false
      controller.close()
    },
  })

  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  })
}

/* ---------------------------------------------------------------- main ---- */

async function liveRun(runId: string, prompt: string, emit: Emit) {
  const run = store.get(runId)!
  const ws = workspace(runId)
  const divergences = run.divergences

  // Main run diberi kosakata pohon: id, sumbu, dua label persis. Commit = tool call `decide`.
  const vocabulary = divergences.length
    ? '\n\nDecision points already identified for this task. BEFORE writing any file, call the `decide` tool ' +
      'once per decision point you have resolved (you may call several in one step):\n' +
      divergences.map((d) => `- ${d.id} (${d.axis}): 0 = "${d.branches[0].label}", 1 = "${d.branches[1].label}"`).join('\n')
    : ' State each decision on its own line as: "Decision - <axis>: going with <choice>."'
  const ids = divergences.map((d) => d.id)

  const system = 'You are a senior engineer refactoring a small codebase. Read before you write. ' +
    'Write complete files with writeFile; the result is shown to the user as a real diff. ' +
    'Finish with a short summary of what changed.' + vocabulary
  const steering: string[] = []   // semua directive yang sudah masuk; berlaku sampai run selesai

  const result = streamText({
    model: MODELS.main,
    stopWhen: stepCountIs(30),   // model satu-tool-per-step (qwen) butuh lebih dari 16
    maxOutputTokens: GUARDS.maxOutputTokens,
    // Tanpa ini, error provider menutup stream dalam diam dan user cuma lihat layar kosong.
    onError: ({ error }) => emit({ type: 'error', message: String(error) }),
    system,
    prompt: `${prompt}\n\nFiles in the repo: ${listFiles().join(', ')}`,
    tools: {
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
      // Commit = tool call, bukan pola teks. Model jauh lebih patuh pada schema
      // daripada pada format kalimat, dan hasilnya langsung terstruktur.
      decide: tool({
        description: 'Record which branch you are taking for an identified decision point.',
        inputSchema: z.object({
          decision: ids.length ? z.enum(ids as [string, ...string[]]) : z.string(),
          branch: z.union([z.literal(0), z.literal(1)]),
          why: z.string().max(200),
        }),
        execute: async ({ decision, branch, why }) => {
          const d = run.divergences.find((x) => x.id === decision)
          if (!d) return 'unknown decision'
          run.committed[d.id] = branch
          emit({ type: 'commit', divergenceId: d.id, branchIdx: branch, why })
          return `recorded: ${d.axis} -> ${d.branches[branch].label}`
        },
      }),
    },

    // === TITIK INJEKSI. Setiap batas tool call, antrian steering di-drain. ===
    // SDK 7 melarang pesan system di tengah messages; yang benar: timpa `instructions` per step.
    prepareStep: async ({ stepNumber }) => {
      emit({ type: 'step', n: stepNumber })
      const pending = store.drain(runId)
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
    detectCommits(runId, emit)
  }
  run.diff = ws.diff()
  emit({ type: 'patch', diff: run.diff, finishReason: await result.finishReason })
}

/* ------------------------------------------------------------ prefetch ---- */

/** Cabang yang kemungkinan TIDAK diambil main run (confidence lebih rendah) dihitung
 *  sungguhan selama menunggu: rencana konkret + potongan kode, siap saat jawaban mendarat.
 *  Kalau user membunuh cabang itu, hitungannya dibuang; kalau main run justru memilihnya,
 *  hasilnya tetap dipakai sebagai konfirmasi. */
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
        system: 'You prepare a ready-to-apply follow-up for an engineer. Be concrete and terse: ' +
          'list the files to touch, then the key code snippet. No preamble.',
        prompt: `Task: ${run.prompt}\n\nThe agent will likely choose "${d.branches[1 - i].label}" for the decision "${d.axis}". ` +
          `Prepare the alternative "${b.label}" (${b.sketch}) so the user can switch with one action.\n\nRepo:\n${context}`,
      })
      const killed = run.actions[d.id]?.verb === 'kill' && run.actions[d.id].branchIdx === i
      Object.assign(entry, { text, status: killed ? 'dropped' : 'done' })
      emit({ type: 'prefetch', divergenceId: d.id, branchIdx: i, label: b.label, status: entry.status })
    } catch (err) {
      Object.assign(entry, { status: 'dropped', text: String(err) })
    }
  }))
}

/* ------------------------------------------------------- commit + score ---- */

/** Cadangan kalau model menulis "Decision - <axis>: going with <label>." alih-alih memanggil
 *  tool decide. Cocokkan sumbu lalu label persis; irisan kata hanya kalau diparafrase. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
const words = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length >= 3))
function detectCommits(runId: string, emit: Emit) {
  const run = store.get(runId)
  if (!run) return
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
    emit({ type: 'commit', divergenceId: d.id, branchIdx: idx })
  }
}

/** Model yang mengabaikan tool `decide` tetap diberi commit: diff dan log-nya
 *  diklasifikasikan model scan (murah, terstruktur). Ini classifier post-hoc sungguhan,
 *  bukan tebakan kata kunci. */
async function classifyCommits(run: Run, emit: Emit) {
  const open = run.divergences.filter((d) => !(d.id in run.committed))
  if (!open.length || (!run.diff && !run.output)) return
  try {
    const { object } = await generateObject({
      model: MODELS.scan,
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
      emit({ type: 'commit', divergenceId: d.id, branchIdx: x.branch, why: 'classified from diff' })
    }
  } catch (err) {
    console.warn('classify dropped:', String(err).slice(0, 160))
  }
}

async function finish(runId: string, emit: Emit) {
  const run = store.get(runId)!
  await classifyCommits(run, emit)
  run.done = true
  const acted = Object.entries(run.committed).filter(([id]) => run.actions[id])
  const hits = acted.filter(([id, idx]) => {
    const a = run.actions[id]
    return a.verb === 'pin' ? a.branchIdx === idx : a.branchIdx !== idx
  })
  const calibration = acted.length ? hits.length / acted.length : null

  // Prefetch yang masih jalan diberi kesempatan singkat; sisanya dilaporkan apa adanya.
  const deadline = Date.now() + 8000
  while (run.prefetch.some((p) => p.status === 'running') && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 250))

  // Hanya cabang yang tidak dibunuh user dan tidak diambil main run: follow-up yang sudah jadi.
  const ready = run.prefetch.filter((p) =>
    p.status === 'done' &&
    !(run.actions[p.divergenceId]?.verb === 'kill' && run.actions[p.divergenceId].branchIdx === p.branchIdx) &&
    run.committed[p.divergenceId] !== p.branchIdx)

  emit({
    type: 'done',
    calibration,
    prefetch: ready.map(({ divergenceId, branchIdx, label, text }) => ({ divergenceId, branchIdx, label, text })),
    elapsedMs: Date.now() - run.startedAt,
  })
}

export type { Divergence }
