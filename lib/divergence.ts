import { z } from 'zod'
import { generateObject } from 'ai'
import { GUARDS, MODELS } from './config'

// Schema sengaja polos: tanpa .int()/.max()/tuple. Backend structured-output yang
// ketat (Anthropic, OpenAI, Gemini, vLLM grammar) menolak minimum/maxLength/items[].
// Batasan panjang & bentuk ditegakkan di qualityGate.
const Branch = z.object({
  label: z.string(),
  sketch: z.string(),
  filesTouched: z.number(),
  costUsd: z.number(),
  confidence: z.number(),
  // Di-generate DI SCAN YANG SAMA. Itulah kenapa KILL/PIN instan:
  // tidak ada panggilan model kedua saat user menekan tombol.
  constraintIfPinned: z.string(),
  constraintIfKilled: z.string(),
})
export type Branch = z.infer<typeof Branch>

export const DivergenceSet = z.object({
  etaSeconds: z.number(),
  divergences: z.array(
    z.object({
      id: z.string(),
      axis: z.string(),
      question: z.string(),
      branches: z.array(Branch),
    })
  ),
})
export type DivergenceSet = z.infer<typeof DivergenceSet>
export type Divergence = DivergenceSet['divergences'][number]

const SCAN_PROMPT = `You are a branch predictor for an AI coding agent, not an assistant.

Identify the DECISION POINTS the agent must resolve to answer the user's prompt
— places where a competent engineer could reasonably go two ways.

A divergence is INVALID unless ALL hold:
1. The two branches are mutually exclusive. Doing A forbids B.
2. Both are defensible. If one is obviously right, it is not a decision.
3. Leading branch confidence < 0.85. Higher means assumption, not decision.
4. The axis is visible in the final output. If the user could not tell which
   branch was taken by reading the result, drop it.
4b. Never offer a choice the prompt already made (prompt says "use sessions"
   -> "sessions vs tokens" is NOT a decision). Go one level deeper instead.
5. Max 5 divergences, ranked by how expensive the wrong choice is to undo.

confidence of the two branches in a divergence must sum to 1.0.
id: short snake_case slug. axis: a 1-3 word noun phrase naming the decision
(e.g. "storage", "session expiry"), never a question or a sentence fragment.
label: at most 4 words, concrete (e.g. "redis, new dep"). sketch: at most 12 words.
question: at most 10 words. Be terse everywhere; latency matters.
constraintIfPinned: plain-English imperative sentence forcing THIS SAME branch.
constraintIfKilled: plain-English imperative sentence forbidding THIS SAME branch
(e.g. for branch "redis": pinned = "Use redis for sessions.", killed = "Do not use redis.").
No code, no comment markers.
etaSeconds: honest estimate of how long a coding agent needs for the whole task.

Output only decisions the user would be annoyed to discover 90 seconds from now.
Output an empty list if the prompt has no real decision points.`

/** Buang divergensi palsu secara deterministik. Jangan berharap pada prompt saja. */
export function qualityGate(set: DivergenceSet): Divergence[] {
  // Beberapa model mengawali constraint dengan "// " atau "- ". Buang.
  const clean = (s: string) => s.replace(/^[\s/\-*]+/, '').trim()
  return set.divergences
    .filter((d) => d.branches.length === 2)
    .map((d) => ({
      ...d,
      id: d.id.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `d${Math.random().toString(36).slice(2, 6)}`,
      axis: d.axis.slice(0, 24),
      question: d.question.slice(0, 120),
      branches: d.branches.map((b) => ({
        ...b, label: b.label.slice(0, 40), sketch: b.sketch.slice(0, 160),
        filesTouched: Math.round(b.filesTouched), confidence: Math.min(1, Math.max(0, b.confidence)),
        constraintIfPinned: clean(b.constraintIfPinned), constraintIfKilled: clean(b.constraintIfKilled),
      })),
    }))
    .filter((d) => {
      const [a, b] = d.branches
      const lead = Math.max(a.confidence, b.confidence)
      const sums = Math.abs(a.confidence + b.confidence - 1) < 0.06
      const distinct = a.label.trim().toLowerCase() !== b.label.trim().toLowerCase()
      return lead < GUARDS.leadConfidenceCeiling && sums && distinct
    })
    // id harus unik: tool `decide` memakainya sebagai enum.
    .filter((d, i, all) => all.findIndex((x) => x.id === d.id) === i)
    .slice(0, GUARDS.maxDivergences)
}

export async function scan(prompt: string, repoContext: string, standing: string[]):
  Promise<{ divergences: Divergence[]; etaSeconds: number }> {
  try {
    const { object } = await generateObject({
      model: MODELS.scan,
      schema: DivergenceSet,
      maxOutputTokens: GUARDS.maxOutputTokens,
      abortSignal: AbortSignal.timeout(GUARDS.scanBudgetMs),
      system: SCAN_PROMPT + (standing.length
        ? `\n\nThis user has consistently rejected the following. Treat as settled, do not offer as a decision:\n- ${standing.join('\n- ')}`
        : ''),
      prompt: `USER PROMPT:\n${prompt}\n\nREPO CONTEXT:\n${repoContext}`,
    })
    return { divergences: qualityGate(object), etaSeconds: Math.round(object.etaSeconds) }
  } catch (err) {
    // Scan gagal atau telat -> user cuma lihat loading biasa. Regresi nol.
    console.warn('scan dropped:', String(err).slice(0, 200))
    return { divergences: [], etaSeconds: 0 }
  }
}
