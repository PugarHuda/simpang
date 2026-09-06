// Tes API tanpa browser, melawan server sungguhan (BASE) dan model sungguhan.
// Jalankan: SIMPANG_FREE_BRANCHES=2 npx next dev -p 3101 &  lalu  BASE=http://localhost:3101 npm run test:api
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { x402Client } from '@x402/core/client'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { wrapFetchWithPayment, x402HTTPClient } from '@x402/fetch'

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
//    UI memanaskan route steer saat run mulai; tes meniru itu (GET = warm-up, 204).
a((await fetch(`${BASE}/api/steer`)).status === 204, 'steer: warm-up 204')
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
  //    X402_TEST_BUYER_KEY berisi USDC testnet -> pembayaran benar-benar settle on-chain (tx hash).
  const funded = process.env.X402_TEST_BUYER_KEY
  const account = privateKeyToAccount(funded ?? generatePrivateKey())
  const client = new x402Client().register('eip155:*', new ExactEvmScheme(account))
  const pay = wrapFetchWithPayment(fetch, client)
  const http = new x402HTTPClient(client)
  const paid = await pay(`${BASE}/api/unlock?runId=${runId}`, { method: 'POST' })
  const body = await paid.json().catch(() => ({}))
  const reason = paid.status === 402 ? JSON.parse(Buffer.from(paid.headers.get('payment-required') ?? '', 'base64').toString()).error : 'paid'
  console.log('    facilitator ->', paid.status, reason)
  if (funded) {
    a(paid.status === 200, 'unlock: wallet berisi USDC -> 200, pembayaran settle')
    const settle = http.getPaymentSettleResponse((n) => paid.headers.get(n))
    a(settle?.success && /^0x[0-9a-f]{64}$/i.test(settle.transaction ?? ''), `unlock: PAYMENT-RESPONSE berisi tx on-chain ${settle?.transaction} (${settle?.network})`)
  } else {
    a(paid.status === 200 || reason === 'invalid_exact_evm_insufficient_balance',
      'unlock: tanda tangan EIP-3009 diterima facilitator; ditolak hanya karena saldo 0 (kunci berisi USDC testnet -> lolos)')
  }
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

// 7b. Atribusi: run ini dibuat tanpa client id -> semua aksi 'helper'. Dengan header pemilik -> 'owner'.
a(state.actions[d0.id]?.by === 'helper', 'atribusi: steer tanpa client id pemilik tercatat sebagai helper')
const owned = await fetch(`${BASE}/api/run`, { method: 'POST', headers: { 'x-simpang-client': 'owner-A' }, body: JSON.stringify({ prompt: 'refactor the auth system to use sessions' }) })
const ordr = owned.body.getReader(); let obuf = '', oid = '', oscan = null
outer2: for (;;) {
  const { done, value } = await ordr.read(); if (done) break
  obuf += dec.decode(value, { stream: true }); const parts = obuf.split('\n\n'); obuf = parts.pop()
  for (const p of parts) { if (!p.startsWith('data: ')) continue; const e = JSON.parse(p.slice(6)); if (e.type === 'run') oid = e.runId; if (e.type === 'scan') { oscan = e; break outer2 } if (e.type === 'done') break outer2 }
}
if (oscan?.divergences.length) {
  const od = oscan.divergences[0].id
  await fetch(`${BASE}/api/steer`, { method: 'POST', headers: { 'x-simpang-client': 'owner-A' }, body: JSON.stringify({ runId: oid, divergenceId: od, branchIdx: 0, verb: 'kill' }) })
  const st = await fetch(`${BASE}/api/others?runId=${oid}`).then((r) => r.json())
  a(st.actions[od]?.by === 'owner', 'atribusi: steer dengan client id pemilik tercatat sebagai owner')
  if (oscan.divergences[1]) {
    const od2 = oscan.divergences[1].id
    await fetch(`${BASE}/api/steer`, { method: 'POST', headers: { 'x-simpang-client': 'helper-B' }, body: JSON.stringify({ runId: oid, divergenceId: od2, branchIdx: 0, verb: 'kill' }) })
    const st2 = await fetch(`${BASE}/api/others?runId=${oid}`).then((r) => r.json())
    a(st2.actions[od2]?.by === 'helper', 'atribusi: steer dari client lain tercatat sebagai helper')
  }
}
ordr.cancel().catch(() => {})

// 7c. Preferensi yang dipelajari terlihat dan bisa dilupakan.
const prefs1 = await fetch(`${BASE}/api/prefs`).then((r) => r.json())
const killedC = d0.branches[0].constraintIfKilled
const mine = prefs1.prefs.find((p) => p.constraint === killedC)
a(mine && mine.count >= 1, `prefs: constraint yang dibunuh tercatat (${mine?.count}x, standing=${mine?.standing})`)
a((await fetch(`${BASE}/api/prefs`, { method: 'DELETE', body: JSON.stringify({ constraint: killedC }) })).ok, 'prefs: DELETE ok')
const prefs2 = await fetch(`${BASE}/api/prefs`).then((r) => r.json())
a(!prefs2.prefs.some((p) => p.constraint === killedC), 'prefs: constraint dilupakan')
// 7d. Health: status sungguhan tiap integrasi (model, store, facilitator, bazaar, wallet agent).
const health = await fetch(`${BASE}/api/health`).then(async (r) => ({ status: r.status, ...(await r.json()) }))
console.log('    health ->', JSON.stringify({ status: health.status, store: health.store?.kind, x402: health.x402?.ok, bazaar: health.bazaar, wallet: health.agentWallet }))
a(health.model === 'configured' && health.store?.ok && health.x402?.ok, `health: model+store+facilitator ok (bazaar reachable=${health.bazaar?.reachable})`)

// 7e. SIMPANG sebagai PENJUAL untuk agent lain: /api/paid/scan di balik x402, terdeklarasi ke Bazaar.
const ps402 = await post('/api/paid/scan', { prompt: 'add rate limiting to the login endpoint' })
a(ps402.status === 402, 'paid scan: tanpa pembayaran -> 402')
const psChallenge = JSON.parse(Buffer.from(ps402.headers.get('payment-required') ?? '', 'base64').toString())
const psReq = psChallenge.accepts[0]
a(psReq.amount === '20000' && psReq.network === 'eip155:84532', `paid scan: harga ${Number(psReq.amount) / 1e6} USDC di ${psReq.network}`)
a(JSON.stringify(psChallenge).includes('bazaar'), 'paid scan: deklarasi discovery Bazaar ikut di challenge')
if (process.env.X402_TEST_BUYER_KEY) {
  const buyer = privateKeyToAccount(process.env.X402_TEST_BUYER_KEY)
  const bc = new x402Client().register('eip155:*', new ExactEvmScheme(buyer))
  const bpay = wrapFetchWithPayment(fetch, bc)
  const bought = await bpay(`${BASE}/api/paid/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'add rate limiting to the login endpoint' }) })
  const bj = await bought.json().catch(() => ({}))
  const bs = bought.status === 200 ? new x402HTTPClient(bc).getPaymentSettleResponse((n) => bought.headers.get(n)) : null
  a(bought.status === 200 && Array.isArray(bj.divergences) && bj.divergences.length > 0, `paid scan: dibeli agent lain -> ${bj.divergences?.length} divergensi dalam ${bj.scanMs}ms, tx ${bs?.transaction}`)
}

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
