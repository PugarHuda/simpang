import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import net from 'node:net'
import dns from 'node:dns/promises'
import { privateKeyToAccount } from 'viem/accounts'
import { x402Client } from '@x402/core/client'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { wrapFetchWithPayment, x402HTTPClient } from '@x402/fetch'
import { findPaidResources } from './bazaar'

/** Live-data tools for the agent. Without them the agent can only work the repo and answers
 *  "I have no data access" to a prompt like a price analysis.
 *  - webSearch: Venice web search (same key as the model), an answer plus citations
 *  - marketData: daily crypto prices from CoinGecko (public, no key)
 *  - paidFetch: x402-gated endpoints, paid automatically from the agent's wallet
 *    (X402_BUYER_PRIVATE_KEY, USDC on Base Sepolia) — the BUYER side of x402 */

type Emit = (e: Record<string, unknown>) => void

/** A URL from the model is untrusted input. https to public hosts only: loopback, private
 *  networks, link-local (cloud metadata at 169.254.x) and internal names are rejected AFTER DNS
 *  resolution, so "evil.example -> 127.0.0.1" is caught too. */
async function assertPublicUrl(raw: string) {
  let u: URL
  try { u = new URL(raw) } catch { throw new Error('invalid url') }
  if (u.protocol !== 'https:') throw new Error('only https urls are allowed')
  if (u.username || u.password) throw new Error('credentials in url are not allowed')
  const host = u.hostname.toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal'))
    throw new Error('internal host is not allowed')
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address)
  for (const a of addrs) if (isPrivateIp(a)) throw new Error(`host resolves to a private address (${a})`)
}
function isPrivateIp(ip: string): boolean {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase()
    if (v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80')) return true
    const m4 = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    return m4 ? isPrivateIp(m4[1]) : false
  }
  const [a, b] = ip.split('.').map(Number)
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
}

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

  // The x402 Bazaar catalog: find paid data/AI endpoints, then buy them with paidFetch.
  tools.findPaidData = tool({
    description: 'Search the x402 Bazaar catalog of paid data and AI endpoints (price in USDC, network, description). ' +
      `Prefer network "${process.env.X402_NETWORK ?? 'eip155:84532'}" (the agent wallet holds testnet USDC there); ` +
      'then call paidFetch with the resource url to buy it.',
    inputSchema: z.object({ query: z.string(), network: z.string().optional() }),
    execute: async ({ query, network }) => {
      emit({ type: 'tool', name: 'bazaar', path: query })
      try { return await findPaidResources(query, network) }
      catch (e) { return `bazaar unreachable: ${String((e as Error).message ?? e).slice(0, 160)}` }
    },
  })

  const buyerKey = process.env.X402_BUYER_PRIVATE_KEY as `0x${string}` | undefined
  if (buyerKey) {
    // The agent decides what to buy from tool output it did not write: Bazaar listings carry a
    // description, service name and tags supplied by whoever registered the resource. That text
    // reaches the model as data it is asked to act on, and the model holds a funded wallet for up
    // to 30 steps. So the wallet gets a budget the model cannot talk its way past: every purchase
    // is priced from the unpaid 402 challenge first and refused before any signature if it breaks
    // the per-call ceiling or what is left of the run.
    const MAX_CALL = Number(process.env.X402_MAX_CALL_USD ?? 0.10)
    const RUN_BUDGET = Number(process.env.X402_RUN_BUDGET_USD ?? 0.50)
    let spent = 0
    const account = privateKeyToAccount(buyerKey)
    const client = new x402Client().register('eip155:*', new ExactEvmScheme(account))
    const pay = wrapFetchWithPayment(fetch, client)
    const http = new x402HTTPClient(client)
    tools.paidFetch = tool({
      description: 'GET a URL that may require x402 payment (paid data or AI endpoints). The agent wallet pays ' +
        `automatically (USDC on Base Sepolia, address ${account.address}). Returns the body and the payment receipt.`,
      inputSchema: z.object({
        url: z.string(),
        method: z.enum(['GET', 'POST']).optional().describe('POST when the resource declares a JSON body input'),
        body: z.record(z.string(), z.unknown()).optional().describe('JSON body for POST'),
      }),
      execute: async ({ url, method, body }) => {
        try { await assertPublicUrl(url) } catch (e) { return `refused: ${(e as Error).message}` }
        emit({ type: 'tool', name: 'paid', path: url })
        const init: RequestInit = {
          method: method ?? (body ? 'POST' : 'GET'),
          headers: { accept: 'application/json, text/plain;q=0.9, */*;q=0.5', ...(body ? { 'content-type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
          redirect: 'manual',
        }

        // Ask without paying first. A free endpoint answers here and costs nothing extra; a paid
        // one answers 402 and names its price, which is the only chance to refuse it.
        const probe = await fetch(url, init)
        if (probe.status === 402) {
          let accepts: { amount?: string }[] = []
          try {
            const challenge = probe.headers.get('payment-required')
            if (challenge) accepts = JSON.parse(Buffer.from(challenge, 'base64').toString()).accepts ?? []
          } catch { /* unreadable challenge -> priced as Infinity below, which refuses it */ }
          // USDC is 6dp. An unreadable challenge is treated as too expensive rather than free.
          const usd = accepts.length ? Number(accepts[0].amount) / 1e6 : Infinity
          if (!(usd <= MAX_CALL))
            return `refused: this resource costs ${Number.isFinite(usd) ? `$${usd}` : 'an amount I could not read'}, over the $${MAX_CALL} per-call limit`
          if (spent + usd > RUN_BUDGET)
            return `refused: $${spent.toFixed(2)} of the $${RUN_BUDGET} budget for this run is already spent`
          spent += usd
        }

        const res = probe.status === 402 ? await pay(url, init) : probe
        let receipt: unknown = null
        try { receipt = http.getPaymentSettleResponse((n) => res.headers.get(n)) } catch { /* not a paid endpoint */ }
        const text = (await res.text()).slice(0, 8000)
        if (receipt) emit({ type: 'paid', url, receipt })
        return { status: res.status, body: text, receipt }
      },
    })
  }

  return tools
}
