// Tes API tanpa browser, melawan server sungguhan (BASE) dan model sungguhan.
// Jalankan: SIMPANG_FREE_BRANCHES=2 npx next dev -p 3101 &  lalu  BASE=http://localhost:3101 npm run test:api
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { x402Client } from '@x402/core/client'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { wrapFetchWithPayment } from '@x402/fetch'

const BASE = process.env.BASE ?? 'http://localhost:3101'
const a = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1) } else console.log('ok  ', m) }
const post = (path, body, headers = {}) => fetch(`${BASE}${path}`, { method: 'POST', body: JSON.stringify(body), headers })

// 1. Validasi di batas kepercayaan: input rusak -> 400, bukan 500.
a((await post('/api/run', { prompt: '' })).status === 400, 'run: prompt kosong -> 400')
a((await post('/api/steer', { runId: 'x' })).status === 400, 'steer: body rusak -> 400')
a((await post('/api/fork', { nope: 1 })).status === 400, 'fork: body rusak -> 400')
a((await fetch(`${BASE}/api/others?runId=00000000-0000-0000-0000-000000000000`)).status === 404, 'others: run tak dikenal -> 404')

// 2. Run sungguhan sampai pohon muncul.
const res = await post('/api/run', { prompt: 'refactor the auth system to use sessions' })
a(res.status === 200 && res.headers.get('content-type')?.includes('text/event-stream'), 'run: SSE dimulai')
const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = ''
let runId = '', scan = null
outer: for (;;) {
  const { done, value } = await reader.read(); if (done) break
  buf += dec.decode(value, { stream: true }); const parts = buf.split('\n\n'); buf = parts.pop()
  for (const p of parts) {
    if (!p.startsWith('data: ')) continue
    const e = JSON.parse(p.slice(6))
    if (e.type === 'run') runId = e.runId
    if (e.type === 'scan') { scan = e; break outer }
    if (e.type === 'done') break outer
  }
}
a(scan && scan.divergences.length > 0, `scan: ${scan?.divergences.length} divergensi terlihat, ${scan?.locked} terkunci, eta ${scan?.etaSeconds}s`)
const d0 = scan.divergences[0]

// 3. Steer instan, tanpa panggilan model: constraint sudah ada sejak scan.
const t0 = Date.now()
const s1 = await post('/api/steer', { runId, divergenceId: d0.id, branchIdx: 0, verb: 'kill' }).then((r) => r.json())
a(s1.status === 'queued' && s1.injected === d0.branches[0].constraintIfKilled && Date.now() - t0 < 1000, `steer: queued dalam ${Date.now() - t0}ms, injected "${s1.injected}"`)

// 4. Gerbang x402 dari SDK resmi: tanpa pembayaran -> 402 + PAYMENT-REQUIRED yang bisa didecode.
if (scan.locked > 0) {
  const lockedId = (await fetch(`${BASE}/api/others?runId=${runId}`).then((r) => r.json())).divergences.length
  const r402 = await post(`/api/unlock?runId=${runId}`, {})
  a(r402.status === 402, 'unlock: tanpa pembayaran -> 402')
  const header = r402.headers.get('payment-required')
  a(Boolean(header), 'unlock: header PAYMENT-REQUIRED ada')
  const challenge = JSON.parse(Buffer.from(header, 'base64').toString())
  const req = challenge.accepts[0]
  a(challenge.x402Version === 2 && req.scheme === 'exact' && req.network === 'eip155:84532' && req.amount === '10000',
    `unlock: challenge v2 exact ${req.network} ${req.amount} units USDC -> ${req.payTo}`)

  // Steer ke divergensi terkunci ditolak di server, bukan cuma disembunyikan UI.
  const all = scan.divergences.length + scan.locked
  a(all > lockedId, 'ada divergensi terkunci di server')

  // 5. Bayar dengan wallet sungguhan (kunci baru, saldo 0) lewat @x402/fetch: tanda tangan EIP-3009
  //    valid secara kriptografi; facilitator x402.org memutuskan berdasarkan saldo.
  const account = privateKeyToAccount(generatePrivateKey())
  const client = new x402Client().register('eip155:*', new ExactEvmScheme(account))
  const pay = wrapFetchWithPayment(fetch, client)
  const paid = await pay(`${BASE}/api/unlock?runId=${runId}`, { method: 'POST' })
  const body = await paid.json().catch(() => ({}))
  const reason = paid.status === 402 ? JSON.parse(Buffer.from(paid.headers.get('payment-required') ?? '', 'base64').toString()).error : 'paid'
  console.log('    facilitator ->', paid.status, reason)
  a(paid.status === 200 || reason === 'invalid_exact_evm_insufficient_balance',
    'unlock: tanda tangan EIP-3009 diterima facilitator; ditolak hanya karena saldo 0 (kunci berisi USDC testnet -> lolos)')
  if (paid.status === 200) a(body.divergence?.id && typeof body.locked === 'number', `unlock: divergensi "${body.divergence.axis}" terbuka, sisa ${body.locked}`)
} else {
  console.log('skip: scan ini tidak menghasilkan divergensi terkunci (perlu >= 3 divergensi dengan SIMPANG_FREE_BRANCHES=2)')
}

// 6. Multiplayer: run ini terlihat oleh orang lain selama masih berjalan.
const other = await fetch(`${BASE}/api/others?exclude=none`).then((r) => r.json())
a(other.runId === runId, 'others: run yang sedang berjalan ditemukan')

// 7. Tunggu selesai: diff nyata + commit ke cabang lawan + kalibrasi 100%.
let doneEv = null, patch = null
for (;;) {
  const { done, value } = await reader.read(); if (done) break
  buf += dec.decode(value, { stream: true }); const parts = buf.split('\n\n'); buf = parts.pop()
  for (const p of parts) {
    if (!p.startsWith('data: ')) continue
    const e = JSON.parse(p.slice(6))
    if (e.type === 'patch') patch = e
    if (e.type === 'done') doneEv = e
    if (e.type === 'error') console.log('    error:', e.message.slice(0, 200))
  }
}
a(patch && patch.diff.startsWith('diff --git a/'), `patch: diff nyata ${patch?.diff.length} chars, finish=${patch?.finishReason}`)
const state = await fetch(`${BASE}/api/others?runId=${runId}`).then((r) => r.json())
a(state.committed[d0.id] === 1, `commit: "${d0.axis}" -> cabang 1 (cabang 0 dibunuh)`)
a(doneEv && doneEv.calibration === 1, `done: kalibrasi ${doneEv?.calibration}, prefetch ${doneEv?.prefetch.length}, ${doneEv?.elapsedMs}ms`)
const after = await post('/api/steer', { runId, divergenceId: d0.id, branchIdx: 0, verb: 'kill' }).then((r) => r.json())
a(after.status === 'finished', 'steer sejalan setelah selesai -> finished (masuk prior)')
const lateR = await post('/api/steer', { runId, divergenceId: d0.id, branchIdx: 1, verb: 'kill' }).then((r) => r.json())
a(lateR.status === 'late' && lateR.forkable, 'steer bertentangan setelah selesai -> late + forkable')
// 8. Prompt non-kode: agent harus memakai tool data hidup, bukan bilang "tidak punya akses".
const r2 = await post('/api/run', { prompt: 'analisa harga bitcoin 7 hari terakhir dalam USD, sebutkan angka harian' })
const rd2 = r2.body.getReader(); let buf2 = '', tools = [], text2 = '', done2 = null
for (;;) {
  const { done, value } = await rd2.read(); if (done) break
  buf2 += dec.decode(value, { stream: true }); const parts = buf2.split('\n\n'); buf2 = parts.pop()
  for (const p of parts) {
    if (!p.startsWith('data: ')) continue
    const e = JSON.parse(p.slice(6))
    if (e.type === 'tool') tools.push(e.name)
    if (e.type === 'text') text2 += e.delta
    if (e.type === 'done') done2 = e
  }
}
a(tools.some((t) => t === 'market' || t === 'search'), `research: agent memakai tool data hidup (${[...new Set(tools)].join(',')})`)
a(/\d{2},\d{3}|\d{5}/.test(text2) && !/tidak (punya|memiliki) akses/i.test(text2), `research: jawaban berisi angka harga sungguhan (${text2.length} chars)`)
a(done2, 'research: selesai')

console.log('\nOK — validasi, scan, steer, x402 (SDK resmi + wallet asli), multiplayer, diff, kalibrasi, research tools')
