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
  const limited = await rateLimited(req)   // endpoint ini membakar uang model; terbuka di internet
  if (limited) return limited
  const parsed = Body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return Response.json({ error: 'prompt required (3-2000 chars)' }, { status: 400 })
  if (!HAS_MODEL) return Response.json({ error: 'no model provider configured (VENICE_API_KEY etc.)' }, { status: 503 })
  const { prompt } = parsed.data
  const runId = crypto.randomUUID()
  const run = store.create(runId, prompt, req.headers.get('x-simpang-client') ?? '')
  await store.saveBase(run)

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      let open = true
      const emit: Emit = (e) => { if (open) controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`)) }

      emit({ type: 'run', runId })

      // Scan dan main run START BERSAMAAN. Scan tidak pernah memblokir main run.
      const context = repoContext()
      const scanning = scan(prompt, context, await store.standing()).then(async ({ divergences, etaSeconds }) => {
        run.etaSeconds = etaSeconds
        // Wait yang diperkirakan terlalu pendek: panel tidak layak muncul. Tanpa pohon = tanpa steering.
        if (etaSeconds && etaSeconds < GUARDS.minEtaSeconds) {
          emit({ type: 'scan', divergences: [], locked: 0, etaSeconds, skipped: 'short-wait' })
          return
        }
        run.divergences = divergences
        await store.saveBase(run)   // steer/unlock/others di proses lain butuh pohonnya
        if (divergences.length) {
          emit({ type: 'scan', divergences: store.visible(run), locked: store.locked(run), price: X402.price, etaSeconds })
          void prefetch(run, context, emit)   // cabang alternatif dihitung SELAMA menunggu
        }
      })

      try {
        await scanning // pohon harus ada sebelum user bisa memangkasnya
        await liveRun(run, prompt, emit)
      } catch (err) {
        emit({ type: 'error', message: String(err) })
      }

      await finish(run, emit)
      open = false
      controller.close()
    },
  })

  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
  })
}

/* ---------------------------------------------------------------- main ---- */

async function liveRun(run: Run, prompt: string, emit: Emit) {
  const ws = workspace(run.id)
  const divergences = run.divergences

  // Main run diberi kosakata pohon: id, sumbu, dua label persis. Commit = tool call `decide`.
  const vocabulary = divergences.length
    ? '\n\nDecision points already identified for this task. BEFORE writing any file, call the `decide` tool ' +
      'once per decision point you have resolved. This is MANDATORY before the first writeFile:\n' +
      divergences.map((d) => `- ${d.id} (${d.axis}): 0 = "${d.branches[0].label}", 1 = "${d.branches[1].label}"`).join('\n')
    : ' State each decision on its own line as: "Decision - <axis>: going with <choice>."'
  const ids = divergences.map((d) => d.id)

  // Tugas kode: repo tools. Tugas riset/analisa: tool data hidup. Jawaban akhir = deliverable.
  const system = 'You are a capable agent. Decide from the request what kind of task it is.\n' +
    '- Code task: read the repo with readFile before writing; write complete files with writeFile ' +
    '(the user sees a real diff); finish with a short summary.\n' +
    '- Research/analysis task (prices, news, comparisons, reports): fetch live data with marketData / webSearch / ' +
    'paidFetch, then write the full deliverable as your final answer in markdown with concrete numbers, dates and sources. ' +
    'Never say you lack data access: you have these tools. Answer in the language of the request.' + vocabulary
  const steering: string[] = []   // semua directive yang sudah masuk; berlaku sampai run selesai

  const result = streamText({
    model: MODELS.main,
    stopWhen: stepCountIs(30),   // model satu-tool-per-step (qwen) butuh lebih dari 16
    maxOutputTokens: GUARDS.maxOutputTokens,
    // Tanpa ini, error provider menutup stream dalam diam dan user cuma lihat layar kosong.
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
      // Commit = tool call, bukan pola teks. Model jauh lebih patuh pada schema
      // daripada pada format kalimat, dan hasilnya langsung terstruktur.
      // branch menerima 0/1 sebagai angka ATAU string: qwen mengirim "0" dan schema
      // yang ketat membuatnya gagal berkali-kali tanpa pernah mencatat commit.
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

    // === TITIK INJEKSI. Setiap batas tool call, antrian steering di-drain. ===
    // SDK 7 melarang pesan system di tengah messages; yang benar: timpa `instructions` per step.
    prepareStep: async ({ stepNumber }) => {
      emit({ type: 'step', n: stepNumber })
      const [pending, fresh] = await Promise.all([store.drain(run.id), store.get(run.id)])
      // Pemilik melihat aksi yang datang dari orang lain (pohon multiplayer) tanpa polling.
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
    await detectCommits(run, emit)
  }
  run.diff = ws.diff()
  await store.saveFiles(run.id, ws.changed())   // fork di instance lain bisa melanjutkan working copy ini
  await store.saveBase(run)
  emit({ type: 'patch', diff: run.diff, finishReason: await result.finishReason })
}

/* ------------------------------------------------------------ prefetch ---- */

/** Cabang yang kemungkinan TIDAK diambil main run (confidence lebih rendah) dihitung
 *  sungguhan selama menunggu: rencana konkret + potongan kode, siap saat jawaban mendarat.
 *  Kalau user membunuh cabang itu, hitungannya dibuang; kalau main run justru memilihnya,
 *  hasilnya disembunyikan. */
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

/** Cadangan kalau model menulis "Decision - <axis>: going with <label>." alih-alih memanggil
 *  tool decide. Cocokkan sumbu lalu label persis; irisan kata hanya kalau diparafrase. */
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

/** Model yang mengabaikan tool `decide` tetap diberi commit: diff dan log-nya
 *  diklasifikasikan model scan (murah, terstruktur). Ini classifier post-hoc sungguhan,
 *  bukan tebakan kata kunci. */
async function classifyCommits(run: Run, emit: Emit) {
  const open = run.divergences.filter((d) => !(d.id in run.committed))
  if (!open.length || (!run.diff && !run.output)) return
  try {
    const { object } = await generateObject({
      model: MODELS.prefetch,   // non-reasoning: 400 token output harus jadi JSON, bukan pikiran
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

  // Aksi user datang dari proses mana pun: baca state bersama, bukan salinan lokal.
  const shared = (await store.get(run.id)) ?? run
  const acted = Object.entries(run.committed).filter(([id]) => shared.actions[id])
  const hits = acted.filter(([id, idx]) => {
    const a = shared.actions[id]
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
