import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

export const GUARDS = {
  minEtaSeconds: 15,     // scan memperkirakan wait lebih pendek dari ini: panel tidak muncul
  scanBudgetMs: 40000,   // scan telat = scan dibuang, main run tidak pernah ditunda (luna 15-30s)
  maxDivergences: 6,
  freeBranches: Number(process.env.SIMPANG_FREE_BRANCHES ?? 3), // sisanya di balik x402, satu divergensi per pembayaran
  prefetchCap: 2,        // cabang selamat yang dihitung sungguhan selama menunggu
  leadConfidenceCeiling: 0.85, // di atas ini bukan keputusan, cuma asumsi
  maxOutputTokens: 8000,       // per step; 4000 terbukti memotong writeFile (finishReason: length)
} as const

/** x402 v2 lewat SDK resmi (@x402/next). Default testnet Base Sepolia + facilitator x402.org,
 *  jadi pembayaran selalu sungguhan: tanda tangan diverifikasi dan USDC benar-benar berpindah. */
export const X402 = {
  price: process.env.X402_PRICE ?? '$0.01',                                   // per divergensi
  network: (process.env.X402_NETWORK ?? 'eip155:84532') as `${string}:${string}`,
  payTo: (process.env.X402_PAY_TO ?? '0x0000000000000000000000000000000000000001') as `0x${string}`,
  facilitator: process.env.X402_FACILITATOR_URL ?? 'https://x402.org/facilitator',
} as const

// Provider, urutan prioritas: Venice (OpenAI-compatible) > OpenRouter > AI Gateway (string model).
const venice = process.env.VENICE_API_KEY
  ? createOpenAICompatible({ name: 'venice', baseURL: 'https://api.venice.ai/api/v1', apiKey: process.env.VENICE_API_KEY, supportsStructuredOutputs: true })
  : null
const openrouter = process.env.OPENROUTER_API_KEY
  ? createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY })
  : null
export const HAS_MODEL = Boolean(venice || openrouter || process.env.AI_GATEWAY_API_KEY || process.env.ANTHROPIC_API_KEY)

// Nama model beda per provider; env SIMPANG_MAIN_MODEL / SIMPANG_SCAN_MODEL menimpa default.
// Scan: diukur 2026-09-06 di Venice. gpt-56-luna 18s/5 divergensi bagus; gpt-4o-mini 4s tapi dangkal;
// deepseek/gemma berpikir dulu 10-30s; claude-sonnet-5 22s dan mahal.
const ids = venice
  ? { scan: 'openai-gpt-56-luna', main: 'claude-sonnet-5' }
  : { scan: 'anthropic/claude-haiku-4.5', main: 'anthropic/claude-sonnet-5' }
const m = (id: string) => (venice ? venice.chatModel(id) : openrouter ? openrouter(id) : id)
export const MODELS = {
  scan: m(process.env.SIMPANG_SCAN_MODEL ?? ids.scan),
  main: m(process.env.SIMPANG_MAIN_MODEL ?? ids.main),
  prefetch: m(process.env.SIMPANG_PREFETCH_MODEL ?? process.env.SIMPANG_SCAN_MODEL ?? ids.scan),
}
