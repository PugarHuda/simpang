import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { privateKeyToAccount } from 'viem/accounts'
import { x402Client } from '@x402/core/client'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { wrapFetchWithPayment, x402HTTPClient } from '@x402/fetch'

/** Tool data hidup untuk agent. Tanpa ini agent hanya bisa mengerjakan repo dan
 *  menjawab "saya tidak punya akses data" untuk prompt seperti analisa harga.
 *  - webSearch: Venice web search (kunci yang sama dengan model), jawaban + sitasi
 *  - marketData: harga harian kripto dari CoinGecko (publik, tanpa kunci)
 *  - paidFetch: endpoint berbayar x402, dibayar otomatis dari wallet agent
 *    (X402_BUYER_PRIVATE_KEY, USDC Base Sepolia) — sisi PEMBELI x402 */

type Emit = (e: Record<string, unknown>) => void

export function researchTools(emit: Emit) {
  const tools: ToolSet = {}
  const venice = process.env.VENICE_API_KEY

  if (venice) {
    tools.webSearch = tool({
      description: 'Search the live web and get a concise answer with cited sources. Use for anything after your ' +
        'training data: prices, news, releases, current facts. One focused query per call.',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        emit({ type: 'tool', name: 'search', path: query })
        const res = await fetch('https://api.venice.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: { authorization: `Bearer ${venice}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'openai-gpt-4o-mini-2024-07-18',
            max_tokens: 600,
            messages: [{ role: 'user', content: `${query}\n\nAnswer with concrete numbers and dates. Cite sources.` }],
            venice_parameters: { enable_web_search: 'on', enable_web_citations: true },
          }),
        })
        if (!res.ok) return `web search failed: HTTP ${res.status}`
        const j = await res.json()
        const cites = (j.venice_parameters?.web_search_citations ?? []) as { title?: string; url?: string }[]
        return {
          answer: j.choices?.[0]?.message?.content ?? '',
          sources: cites.slice(0, 6).map((c) => ({ title: c.title, url: c.url })),
        }
      },
    })
  }

  tools.marketData = tool({
    description: 'Daily crypto prices, market caps and volumes for the last N days from CoinGecko. ' +
      'coin is a CoinGecko id (bitcoin, ethereum, solana); currency is usd, idr, eur, ...',
    inputSchema: z.object({ coin: z.string(), currency: z.string(), days: z.number() }),
    execute: async ({ coin, currency, days }) => {
      const n = Math.min(90, Math.max(1, Math.round(days)))
      emit({ type: 'tool', name: 'market', path: `${coin}/${currency} ${n}d` })
      const url = `https://api.coingecko.com/api/v3/coins/${encodeURIComponent(coin.toLowerCase())}/market_chart` +
        `?vs_currency=${encodeURIComponent(currency.toLowerCase())}&days=${n}&interval=daily`
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      if (!res.ok) return `coingecko failed: HTTP ${res.status} (${await res.text().then((t) => t.slice(0, 120))})`
      const j = await res.json() as { prices: [number, number][]; total_volumes: [number, number][]; market_caps: [number, number][] }
      const day = (ms: number) => new Date(ms).toISOString().slice(0, 10)
      return {
        coin, currency, source: url,
        daily: j.prices.map(([t, p], i) => ({ date: day(t), price: +p.toFixed(2), volume: Math.round(j.total_volumes[i]?.[1] ?? 0) })),
      }
    },
  })

  const buyerKey = process.env.X402_BUYER_PRIVATE_KEY as `0x${string}` | undefined
  if (buyerKey) {
    const account = privateKeyToAccount(buyerKey)
    const client = new x402Client().register('eip155:*', new ExactEvmScheme(account))
    const pay = wrapFetchWithPayment(fetch, client)
    const http = new x402HTTPClient(client)
    tools.paidFetch = tool({
      description: 'GET a URL that may require x402 payment (paid data or AI endpoints). The agent wallet pays ' +
        `automatically (USDC on Base Sepolia, address ${account.address}). Returns the body and the payment receipt.`,
      inputSchema: z.object({ url: z.string() }),
      execute: async ({ url }) => {
        emit({ type: 'tool', name: 'paid', path: url })
        const res = await pay(url, { headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.5' } })
        let receipt: unknown = null
        try { receipt = http.getPaymentSettleResponse((n) => res.headers.get(n)) } catch { /* tidak berbayar */ }
        const body = (await res.text()).slice(0, 8000)
        if (receipt) emit({ type: 'paid', url, receipt })
        return { status: res.status, body, receipt }
      },
    })
  }

  return tools
}
