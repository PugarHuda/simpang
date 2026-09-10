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
  // The serverless ceiling is 300s and cannot be raised on this plan. A cheaper main model is a
  // slower one — a real run measured 270s, leaving 30s of margin — so the agent stops on the
  // clock rather than on a step count, with room left for the classifier and the final save.
  // Stopping early still runs finish(), so the user keeps the diff and the score. Being killed
  // by the platform at 300s would leave them with neither.
  runBudgetMs: 210_000,
  // A fork revises: it starts from the current diff plus the prefetched draft, so it does not need
  // the whole run budget. It was taking 210s+ behind a button labelled "ready now", which is the
  // second wait of the session and the one nobody signed up for.
  // ponytail: one flat ceiling; per-task budgets if code forks start truncating.
  forkBudgetMs: 150_000,
} as const

/** x402 v2 through the official SDK (@x402/next). Defaults to Base Sepolia testnet plus the
 *  x402.org facilitator, so payments are always real: signatures are verified and USDC moves. */
export const X402 = {
  price: process.env.X402_PRICE ?? '$0.01',                                   // per divergence
  network: (process.env.X402_NETWORK ?? 'eip155:84532') as `${string}:${string}`,
  payTo: (process.env.X402_PAY_TO ?? '0x0000000000000000000000000000000000000001') as `0x${string}`,
  facilitator: process.env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator',
} as const

// Providers, in priority order: Commons > Venice > OpenRouter > AI Gateway (model as a string).
// Commons hosts an OpenAI-compatible API at api.commonsmade.com/v1 — an unauthenticated GET
// /v1/models answers `{"detail":{"message":"Missing Commons token"}}`. It is the hackathon's own
// runtime, and tokens spent through it are the only ones that register on the tokens-spent board:
// a personal provider key scores zero there however much it is run. It also draws on the builder's
// free monthly credits rather than a paid balance.
// ponytail: no fallback chain between providers; whichever key is set wins, /api/health says which.
const commons = process.env.COMMONS_API_KEY
  ? createOpenAICompatible({ name: 'commons', baseURL: process.env.COMMONS_BASE_URL ?? 'https://api.commonsmade.com/v1', apiKey: process.env.COMMONS_API_KEY, supportsStructuredOutputs: true })
  : null
const venice = process.env.VENICE_API_KEY
  ? createOpenAICompatible({ name: 'venice', baseURL: 'https://api.venice.ai/api/v1', apiKey: process.env.VENICE_API_KEY, supportsStructuredOutputs: true })
  : null
const openrouter = process.env.OPENROUTER_API_KEY
  ? createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
  : null
export const HAS_MODEL = Boolean(commons || venice || openrouter || process.env.AI_GATEWAY_API_KEY || process.env.ANTHROPIC_API_KEY)

// Model names differ per provider; SIMPANG_MAIN_MODEL / SIMPANG_SCAN_MODEL override the defaults.
// Scan: measured 2026-09-06 on Venice. gpt-56-luna 18s for 5 good divergences; gpt-4o-mini 4s but
// shallow; deepseek/gemma think first for 10-30s; claude-sonnet-5 22s and expensive.
// Prefetch and the classifier need a NON-reasoning model: luna spends all 700 output tokens
// thinking and returns empty text (finishReason: length).
// The Commons ids are UNVERIFIED: GET /v1/models needs a token, so these are read off the model
// picker in the dashboard, where one id appeared in full as `deepseek/deepseek-v4-pro`. Check them
// against /v1/models on the first authenticated call and override with SIMPANG_*_MODEL if they differ.
const ids = commons
  ? { scan: 'openai/gpt-5.6-luna', main: 'deepseek/deepseek-v4-flash', prefetch: 'qwen/qwen3.7-flash' }
  : venice
  ? { scan: 'openai-gpt-56-luna', main: 'claude-sonnet-5', prefetch: 'openai-gpt-4o-mini-2024-07-18' }
  : { scan: 'anthropic/claude-haiku-4.5', main: 'anthropic/claude-sonnet-5', prefetch: 'anthropic/claude-haiku-4.5' }
const m = (id: string) => (commons ? commons.chatModel(id) : venice ? venice.chatModel(id) : openrouter ? openrouter(id) : id)
/** Which provider actually won the priority order. Only "commons" spends on the tokens board. */
export const PROVIDER = commons ? 'commons' : venice ? 'venice' : openrouter ? 'openrouter' : HAS_MODEL ? 'gateway' : 'none'
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
