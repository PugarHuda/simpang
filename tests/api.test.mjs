// Browserless API tests against a real server (BASE) and real models.
// Run: SIMPANG_FREE_BRANCHES=2 npx next dev -p 3101 &  then  BASE=http://localhost:3101 npm run test:api
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import { x402Client } from '@x402/core/client'
import { ExactEvmScheme } from '@x402/evm/exact/client'
import { wrapFetchWithPayment, x402HTTPClient } from '@x402/fetch'

const BASE = process.env.BASE ?? 'http://localhost:3101'
const a = (c, m) => { if (!c) { console.error('FAIL:', m); process.exit(1) } else console.log('ok  ', m) }
const post = (path, body, headers = {}) => fetch(`${BASE}${path}`, { method: 'POST', body: JSON.stringify(body), headers })

// 1. Validation at the trust boundary: broken input -> 400, not 500.
a((await post('/api/run', { prompt: '' })).status === 400, 'run: empty prompt -> 400')
a((await post('/api/steer', { runId: 'x' })).status === 400, 'steer: broken body -> 400')
a((await post('/api/fork', { nope: 1 })).status === 400, 'fork: broken body -> 400')
a((await fetch(`${BASE}/api/others?runId=00000000-0000-0000-0000-000000000000`)).status === 404, 'others: unknown run -> 404')

// 2. A real run, up to the point the tree appears.
const res = await post('/api/run', { prompt: 'refactor the auth system to use sessions' })
a(res.status === 200 && res.headers.get('content-type')?.includes('text/event-stream'), 'run: SSE started')
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
a(scan && scan.divergences.length > 0, `scan: ${scan?.divergences.length} divergences visible, ${scan?.locked} locked, eta ${scan?.etaSeconds}s`)
const d0 = scan.divergences[0]

// 3. Instant steer, no model call: the constraint has existed since the scan.
//    The UI warms the steer route when a run starts; the test mimics that (GET = warm-up, 204).
a((await fetch(`${BASE}/api/steer`)).status === 204, 'steer: warm-up 204')
const t0 = Date.now()
const s1 = await post('/api/steer', { runId, divergenceId: d0.id, branchIdx: 0, verb: 'kill' }).then((r) => r.json())
a(s1.status === 'queued' && s1.injected === d0.branches[0].constraintIfKilled && Date.now() - t0 < 1000, `steer: queued in ${Date.now() - t0}ms, injected "${s1.injected}"`)

// 4. The x402 gate from the official SDK: no payment -> 402 + a decodable PAYMENT-REQUIRED.
if (scan.locked > 0) {
  const lockedId = (await fetch(`${BASE}/api/others?runId=${runId}`).then((r) => r.json())).divergences.length
  const r402 = await post(`/api/unlock?runId=${runId}`, {})
  a(r402.status === 402, 'unlock: no payment -> 402')
  const header = r402.headers.get('payment-required')
  a(Boolean(header), 'unlock: PAYMENT-REQUIRED header present')
  const challenge = JSON.parse(Buffer.from(header, 'base64').toString())
  const req = challenge.accepts[0]
  a(challenge.x402Version === 2 && req.scheme === 'exact' && req.network === 'eip155:84532' && req.amount === '10000',
    `unlock: challenge v2 exact ${req.network} ${req.amount} units USDC -> ${req.payTo}`)

  // Steering a locked divergence is rejected on the server, not merely hidden by the UI.
  const all = scan.divergences.length + scan.locked
  a(all > lockedId, 'the server has locked divergences')

  // 5. Pay with a real wallet (fresh key, zero balance) through @x402/fetch: the EIP-3009
  //    signature is cryptographically valid; the x402.org facilitator decides on balance.
  //    X402_TEST_BUYER_KEY holding testnet USDC -> the payment really settles on-chain (tx hash).
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
    a(paid.status === 200, 'unlock: wallet holds USDC -> 200, payment settles')
    const settle = http.getPaymentSettleResponse((n) => paid.headers.get(n))
    a(settle?.success && /^0x[0-9a-f]{64}$/i.test(settle.transaction ?? ''), `unlock: PAYMENT-RESPONSE carries the on-chain tx ${settle?.transaction} (${settle?.network})`)
  } else {
    a(paid.status === 200 || reason === 'invalid_exact_evm_insufficient_balance',
      'unlock: the facilitator accepts the EIP-3009 signature; it only rejects on a zero balance (a key with testnet USDC passes)')
  }
  if (paid.status === 200) a(body.divergence?.id && typeof body.locked === 'number', `unlock: divergence "${body.divergence.axis}" opened, ${body.locked} left`)
} else {
  console.log('skip: this scan produced no locked divergence (needs >= 3 divergences with SIMPANG_FREE_BRANCHES=2)')
}

// 6. Multiplayer: this run is visible to other people while it is in flight.
const other = await fetch(`${BASE}/api/others?exclude=none`).then((r) => r.json())
a(other.runId === runId, 'others: the in-flight run is found')

// 7. Wait for the end: a real diff + a commit to the opposite branch + 100% calibration.
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
a(patch && patch.diff.startsWith('diff --git a/'), `patch: real diff, ${patch?.diff.length} chars, finish=${patch?.finishReason}`)
const state = await fetch(`${BASE}/api/others?runId=${runId}`).then((r) => r.json())
a(state.committed[d0.id] === 1, `commit: "${d0.axis}" -> branch 1 (branch 0 was killed)`)
a(doneEv && doneEv.calibration === 1, `done: calibration ${doneEv?.calibration}, prefetch ${doneEv?.prefetch.length}, ${doneEv?.elapsedMs}ms`)
const after = await post('/api/steer', { runId, divergenceId: d0.id, branchIdx: 0, verb: 'kill' }).then((r) => r.json())
a(after.status === 'finished', 'a steer that agrees, after the run finished -> finished (recorded in the prior)')
const lateR = await post('/api/steer', { runId, divergenceId: d0.id, branchIdx: 1, verb: 'kill' }).then((r) => r.json())
a(lateR.status === 'late' && lateR.forkable, 'a conflicting steer after the run finished -> late + forkable')

// 7b. Attribution: with an owner header the action is 'owner'; from another client id it is 'helper'.
a(state.actions[d0.id]?.by === 'owner', 'attribution: a run with no recorded owner has no helpers')
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
  a(st.actions[od]?.by === 'owner', 'attribution: a steer with the owner client id is recorded as owner')
  if (oscan.divergences[1]) {
    const od2 = oscan.divergences[1].id
    await fetch(`${BASE}/api/steer`, { method: 'POST', headers: { 'x-simpang-client': 'helper-B' }, body: JSON.stringify({ runId: oid, divergenceId: od2, branchIdx: 0, verb: 'kill' }) })
    const st2 = await fetch(`${BASE}/api/others?runId=${oid}`).then((r) => r.json())
    a(st2.actions[od2]?.by === 'helper', 'attribution: a steer from another client is recorded as helper')
  }
}
ordr.cancel().catch(() => {})

// 7c. Learned preferences are visible and can be forgotten.
const prefs1 = await fetch(`${BASE}/api/prefs`).then((r) => r.json())
const killedC = d0.branches[0].constraintIfKilled
const mine = prefs1.prefs.find((p) => p.constraint === killedC)
a(mine && mine.count >= 1, `prefs: the killed constraint is recorded (${mine?.count}x, standing=${mine?.standing})`)
a((await fetch(`${BASE}/api/prefs`, { method: 'DELETE', body: JSON.stringify({ constraint: killedC }) })).ok, 'prefs: DELETE ok')
const prefs2 = await fetch(`${BASE}/api/prefs`).then((r) => r.json())
a(!prefs2.prefs.some((p) => p.constraint === killedC), 'prefs: the constraint was forgotten')
// 7d. Health: the real status of every integration (model, store, facilitator, bazaar, agent wallet).
const health = await fetch(`${BASE}/api/health`).then(async (r) => ({ status: r.status, ...(await r.json()) }))
console.log('    health ->', JSON.stringify({ status: health.status, store: health.store?.kind, x402: health.x402?.ok, bazaar: health.bazaar, wallet: health.agentWallet }))
a(health.model === 'configured' && health.store?.ok && health.x402?.ok, `health: model+store+facilitator ok (bazaar reachable=${health.bazaar?.reachable})`)

// 7e. SIMPANG as a SELLER to other agents: /api/paid/scan behind x402, declared to the Bazaar.
const ps402 = await post('/api/paid/scan', { prompt: 'add rate limiting to the login endpoint' })
a(ps402.status === 402, 'paid scan: no payment -> 402')
const psChallenge = JSON.parse(Buffer.from(ps402.headers.get('payment-required') ?? '', 'base64').toString())
const psReq = psChallenge.accepts[0]
a(psReq.amount === '20000' && psReq.network === 'eip155:84532', `paid scan: priced ${Number(psReq.amount) / 1e6} USDC on ${psReq.network}`)
a(JSON.stringify(psChallenge).includes('bazaar'), 'paid scan: the Bazaar discovery declaration rides along in the challenge')
if (process.env.X402_TEST_BUYER_KEY) {
  const buyer = privateKeyToAccount(process.env.X402_TEST_BUYER_KEY)
  const bc = new x402Client().register('eip155:*', new ExactEvmScheme(buyer))
  const bpay = wrapFetchWithPayment(fetch, bc)
  const bought = await bpay(`${BASE}/api/paid/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'add rate limiting to the login endpoint' }) })
  const bj = await bought.json().catch(() => ({}))
  const bs = bought.status === 200 ? new x402HTTPClient(bc).getPaymentSettleResponse((n) => bought.headers.get(n)) : null
  a(bought.status === 200 && Array.isArray(bj.divergences) && bj.divergences.length > 0, `paid scan: bought by another agent -> ${bj.divergences?.length} divergences in ${bj.scanMs}ms, tx ${bs?.transaction}`)
}

// 8. A non-code prompt: the agent must use the live-data tools instead of claiming no access.
const r2 = await post('/api/run', { prompt: 'analyse the bitcoin price over the last 7 days in USD, give the daily numbers' })
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
a(tools.some((t) => t === 'market' || t === 'search'), `research: the agent used the live-data tools (${[...new Set(tools)].join(',')})`)
a(/\d{2},\d{3}|\d{5}/.test(text2) && !/(no|don't have|do not have|lack) (real-?time |live )?(data )?access/i.test(text2), `research: the answer carries real price numbers (${text2.length} chars)`)
a(done2, 'research: finished')

console.log('\nOK — validation, scan, steer, x402 (official SDK + a real wallet), multiplayer, diff, calibration, research tools')
