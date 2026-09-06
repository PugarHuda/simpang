import { z } from 'zod'
import { generateObject } from 'ai'
import { GUARDS, MODELS } from './config'

// The schema is deliberately plain: no .int()/.max()/tuple. Strict structured-output backends
// (Anthropic, OpenAI, Gemini, vLLM grammars) reject minimum/maxLength/items[].
// Length and shape constraints are enforced in qualityGate instead.
const BranchSchema = z.object({
  label: z.string(),
  sketch: z.string(),
  filesTouched: z.number(),
  costUsd: z.number(),
  confidence: z.number(),
  // Generated IN THE SAME SCAN. That is why KILL/PIN is instant:
  // there is no second model call when the user presses a key.
  constraintIfPinned: z.string(),
})
// constraintIfKilled is NOT asked of the model: models (luna, mistral) demonstrably swap the
// prohibitions between branches. The two branches are mutually exclusive, so kill = forbid this
// label + force the opposite branch. Derived deterministically in qualityGate.
export type Branch = z.infer<typeof BranchSchema> & { constraintIfKilled: string }

export const DivergenceSet = z.object({
  etaSeconds: z.number(),
  divergences: z.array(
    z.object({
      id: z.string(),
      axis: z.string(),
      question: z.string(),
      branches: z.array(BranchSchema),
    })
  ),
})
export type DivergenceSet = z.infer<typeof DivergenceSet>
export type Divergence = Omit<DivergenceSet['divergences'][number], 'branches'> & { branches: Branch[] }

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
constraintIfPinned: plain-English imperative sentence forcing THIS SAME branch
(e.g. for branch "redis": "Use redis for session storage."). No code, no comment markers.
etaSeconds: honest estimate of how long a coding agent needs for the whole task.

REPO CONTEXT is the codebase the agent can edit. It matters ONLY if the request is
about changing that codebase. For research, analysis, comparisons or writing tasks,
ignore it completely and never propose decisions about its code (auth, storage, ...).
Write labels, questions and constraints in the language of the user's prompt.

Output only decisions the user would be annoyed to discover 90 seconds from now.
Output an empty list if the prompt has no real decision points.`

/** Throw out fake divergences deterministically. Do not just hope the prompt holds. */
export function qualityGate(set: DivergenceSet): Divergence[] {
  // Some models prefix the constraint with "// " or "- ". Strip it.
  const clean = (s: string) => s.replace(/^[\s/\-*]+/, '').trim()
  return set.divergences
    .filter((d) => d.branches.length === 2)
    .map((d) => ({
      ...d,
      id: d.id.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || `d${Math.random().toString(36).slice(2, 6)}`,
      axis: d.axis.slice(0, 24),
      question: d.question.slice(0, 120),
      branches: d.branches.map((b, i, all) => ({
        ...b, label: b.label.slice(0, 40), sketch: b.sketch.slice(0, 160),
        filesTouched: Math.round(b.filesTouched), confidence: Math.min(1, Math.max(0, b.confidence)),
        constraintIfPinned: clean(b.constraintIfPinned),
        constraintIfKilled: `Do NOT choose "${b.label.slice(0, 40)}". ${clean(all[1 - i].constraintIfPinned)}`,
      })),
    }))
    .filter((d) => {
      const [a, b] = d.branches
      const lead = Math.max(a.confidence, b.confidence)
      const sums = Math.abs(a.confidence + b.confidence - 1) < 0.06
      const distinct = a.label.trim().toLowerCase() !== b.label.trim().toLowerCase()
      return lead < GUARDS.leadConfidenceCeiling && sums && distinct
    })
    // ids must be unique: the `decide` tool uses them as an enum.
    .filter((d, i, all) => all.findIndex((x) => x.id === d.id) === i)
    .slice(0, GUARDS.maxDivergences)
}

export async function scan(prompt: string, repoContext: string, standing: string[]):
  Promise<{ divergences: Divergence[]; etaSeconds: number }> {
  const started = Date.now()
  const system = SCAN_PROMPT + (standing.length
    ? `\n\nThis user has consistently rejected the following. Treat as settled, do not offer as a decision:\n- ${standing.join('\n- ')}`
    : '')
  const once = async (extra = '') => {
    const { object } = await generateObject({
      model: MODELS.scan,
      schema: DivergenceSet,
      maxOutputTokens: GUARDS.maxOutputTokens,
      abortSignal: AbortSignal.timeout(Math.max(5000, GUARDS.scanBudgetMs - (Date.now() - started))),
      system: system + extra,
      prompt: `USER PROMPT:\n${prompt}\n\nREPO CONTEXT:\n${repoContext}`,
    })
    return { raw: object.divergences.length, divergences: qualityGate(object), etaSeconds: Math.round(object.etaSeconds) }
  }
  try {
    let r = await once()
    // The model produced divergences but all of them failed the gate (confidences not summing to 1,
    // leader >= 0.85, twin labels): retry once with the reason, while there is budget left.
    if (!r.divergences.length && r.raw > 0 && Date.now() - started < GUARDS.scanBudgetMs - 8000) {
      console.warn(`scan: ${r.raw} raw -> 0 after gate, retrying once`)
      r = await once('\n\nYour previous attempt was rejected: confidences must sum to 1.0, the leading branch must be ' +
        'below 0.85, and the two labels must differ. Produce valid divergences.')
    }
    return { divergences: r.divergences, etaSeconds: r.etaSeconds }
  } catch (err) {
    // Scan failed or ran late -> the user just sees an ordinary loading screen. Zero regression.
    console.warn('scan dropped:', String(err).slice(0, 200))
    return { divergences: [], etaSeconds: 0 }
  }
}
