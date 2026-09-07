import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

export const GUARDS = {
  minEtaSeconds: 15,     // the scan estimates a shorter wait than this: no panel
  scanBudgetMs: 40000,   // a late scan is a dropped scan; the main run is never delayed (luna 15-30s)
  maxDivergences: 5,   // the scan prompt asks for at most 5; the gate must not disagree with it
  freeBranches: Number(process.env.SIMPANG_FREE_BRANCHES ?? 3), // the rest sit behind x402, one divergence per payment
  prefetchCap: 2,        // surviving branches actually computed while you wait
  leadConfidenceCeiling: 0.85, // above this it is not a decision, just an assumption
  maxOutputTokens: 8000,       // per step; 4000 was shown to truncate writeFile (finishReason: length)
} as const

/** x402 v2 through the official SDK (@x402/next). Defaults to Base Sepolia testnet plus the
 *  x402.org facilitator, so payments are always real: signatures are verified and USDC moves. */
export const X402 = {
  price: process.env.X402_PRICE ?? '$0.01',                                   // per divergence
  network: (process.env.X402_NETWORK ?? 'eip155:84532') as `${string}:${string}`,
  payTo: (process.env.X402_PAY_TO ?? '0x0000000000000000000000000000000000000001') as `0x${string}`,
  facilitator: process.env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator',
} as const

// Providers, in priority order: Venice (OpenAI-compatible) > OpenRouter > AI Gateway (model as a string).
const venice = process.env.VENICE_API_KEY
  ? createOpenAICompatible({ name: 'venice', baseURL: 'https://api.venice.ai/api/v1', apiKey: process.env.VENICE_API_KEY, supportsStructuredOutputs: true })
  : null
const openrouter = process.env.OPENROUTER_API_KEY
  ? createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
  : null
export const HAS_MODEL = Boolean(venice || openrouter || process.env.AI_GATEWAY_API_KEY || process.env.ANTHROPIC_API_KEY)

// Model names differ per provider; SIMPANG_MAIN_MODEL / SIMPANG_SCAN_MODEL override the defaults.
// Scan: measured 2026-09-06 on Venice. gpt-56-luna 18s for 5 good divergences; gpt-4o-mini 4s but
// shallow; deepseek/gemma think first for 10-30s; claude-sonnet-5 22s and expensive.
// Prefetch and the classifier need a NON-reasoning model: luna spends all 700 output tokens
// thinking and returns empty text (finishReason: length).
const ids = venice
  ? { scan: 'openai-gpt-56-luna', main: 'claude-sonnet-5', prefetch: 'openai-gpt-4o-mini-2024-07-18' }
  : { scan: 'anthropic/claude-haiku-4.5', main: 'anthropic/claude-sonnet-5', prefetch: 'anthropic/claude-haiku-4.5' }
const m = (id: string) => (venice ? venice.chatModel(id) : openrouter ? openrouter(id) : id)
/** The ids actually in force after the env overrides. /api/health reports these: "configured"
 *  does not tell you whether a deployment is running the expensive model or the cheap one. */
export const MODEL_IDS = {
  scan: process.env.SIMPANG_SCAN_MODEL ?? ids.scan,
  main: process.env.SIMPANG_MAIN_MODEL ?? ids.main,
  prefetch: process.env.SIMPANG_PREFETCH_MODEL ?? ids.prefetch,
} as const
export const MODELS = {
  scan: m(MODEL_IDS.scan),
  main: m(MODEL_IDS.main),
  prefetch: m(MODEL_IDS.prefetch),
}
