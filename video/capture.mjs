// Drives the real production deployment and records it, emitting a timeline of everything
// the composer needs to draw on top: cursor moves, clicks, keypresses, and the bounding box
// of whatever is being explained at that moment.
//
// Run from anywhere; node resolves playwright/viem from the parent project's node_modules.
//   node video/capture.mjs
//
// Nothing here is staged: it types into the live site, the agent really runs, and the x402
// payment really settles on Base Sepolia.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { privateKeyToAccount } from 'viem/accounts'
import { createPublicClient, http, parseAbiItem } from 'viem'
import { baseSepolia } from 'viem/chains'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const OUT = path.join(HERE, 'out')
const BASE = process.env.VIDEO_BASE ?? 'https://simpang.vercel.app'
// 5 divergences on this prompt, so two sit behind the x402 gate at the default free tier.
const PROMPT = process.env.VIDEO_PROMPT ?? 'make the login endpoint production ready'
const HELPER_PROMPT = 'add a background job queue for sending emails'
const W = 1920, H = 1080
// The app is a centred 896px column, which is a stamp in the middle of a 1920 frame. Recording a
// SMALLER viewport makes that column fill the shot once it is scaled up to 1080p — and unlike a
// CSS zoom it leaves page coordinates alone, so clicks still land where Playwright thinks.
// deviceScaleFactor 2 means the captured pixels are 2x the layout, so the upscale is really a
// downscale and the text stays sharp.
const VW = 1280, VH = 720, DSF = 2

// out/ also holds the generated narration, so clear only what this script produces.
fs.mkdirSync(OUT, { recursive: true })
for (const f of fs.readdirSync(OUT)) {
  if (/\.webm$/.test(f) || f === 'events.jsonl' || f === 'timeline.json') fs.rmSync(path.join(OUT, f), { force: true })
}

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8').split(/\r?\n/)
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]))

/* ------------------------------------------------------------- timeline ---- */

let t0 = 0
const events = []
const now = () => Date.now() - t0
const ev = (o) => {
  const e = { t: now(), ...o }
  events.push(e)
  fs.appendFileSync(path.join(OUT, 'events.jsonl'), JSON.stringify(e) + '\n')
  return e
}
const mark = (name) => {
  ev({ type: 'mark', name })
  console.log(`  · ${name} @ ${(now() / 1000).toFixed(1)}s`)
}

/* ------------------------------------------------- cursor / box helpers ---- */

let cx = VW / 2, cy = VH * 0.35

/** Two cursor samples `travel` apart; the composer eases between them. */
async function moveTo(page, x, y, { travel = 650, dwell = 350 } = {}) {
  ev({ type: 'cursor', x: Math.round(cx), y: Math.round(cy) })
  await page.mouse.move(x, y, { steps: 24 })
  await page.waitForTimeout(travel)
  cx = x; cy = y
  ev({ type: 'cursor', x: Math.round(x), y: Math.round(y) })
  if (dwell) await page.waitForTimeout(dwell)
}

const rectOf = async (page, sel) =>
  await page.locator(sel).first().boundingBox({ timeout: 4000 }).catch(() => null)

async function moveToEl(page, sel, opts) {
  const r = await rectOf(page, sel)
  if (r) await moveTo(page, Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2), opts)
  return r
}

async function clickEl(page, sel) {
  await moveToEl(page, sel, { dwell: 150 })
  ev({ type: 'click', x: Math.round(cx), y: Math.round(cy) })
  await page.locator(sel).first().click({ timeout: 10_000 })
  await page.waitForTimeout(250)
}

let boxSeq = 0
/** Draw a marker box around an element. Returns its id; pass `hold` to auto-close. */
async function box(page, sel, label, hold = 0, pageId = 'a') {
  const r = await rectOf(page, sel)
  if (!r) { console.log(`    (no box: ${sel})`); return null }
  const id = `b${++boxSeq}`
  ev({ type: 'box', id, page: pageId, label, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } })
  // With `hold` the box is already closed; the id is still returned so callers can tell it drew.
  if (hold) { await page.waitForTimeout(hold); ev({ type: 'boxoff', id }) }
  return id
}
const boxOff = (id) => { if (id) ev({ type: 'boxoff', id }) }

async function key(page, code, label) {
  ev({ type: 'key', label })
  await page.keyboard.press(code)
  await page.waitForTimeout(200)
}

async function scene(name, fn) {
  try { await fn() }
  catch (e) {
    console.log(`  !! ${name} failed: ${String(e).split('\n')[0].slice(0, 180)}`)
    ev({ type: 'sceneFailed', name })
  }
}

/* ------------------------------------------------------ browser wallet ---- */

// The agent's own Base Sepolia wallet, injected as window.ethereum so the x402 payment
// really settles. It signs EIP-3009 in node; the page only ever sees an EIP-1193 provider.
const account = privateKeyToAccount(env.X402_BUYER_PRIVATE_KEY)

async function installWallet(page) {
  await page.exposeFunction('__sign', (json) => account.signTypedData(JSON.parse(json)))
  await page.addInitScript((address) => {
    window.ethereum = {
      isSimpangDemoWallet: true,
      request: async ({ method, params }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address]
        if (method === 'eth_chainId') return '0x14a34'
        if (method === 'eth_signTypedData_v4') {
          const typed = JSON.parse(params[1])
          delete typed.types.EIP712Domain
          return window.__sign(JSON.stringify(typed))
        }
        throw new Error(`unsupported: ${method}`)
      },
    }
  }, account.address)
}

/* ------------------------------------------------------------------ run ---- */

console.log(`recording ${BASE} · wallet ${account.address}`)
const browser = await chromium.launch()
const contextOpts = {
  viewport: { width: VW, height: VH },
  // A bigger recording size does not render more detail, it just pads the frame with grey.
  recordVideo: { dir: OUT, size: { width: VW, height: VH } },
  deviceScaleFactor: DSF,
  colorScheme: 'dark',
}
const context = await browser.newContext(contextOpts)

const page = await context.newPage()
await installWallet(page)
t0 = Date.now()
await page.goto(BASE, { waitUntil: 'domcontentloaded' })
await page.waitForTimeout(1500)

let unlockTx = ''

/* --- 1. the idle page: the thesis --------------------------------------- */
await scene('intro', async () => {
  mark('intro')
  await moveTo(page, 700, 300, { travel: 900, dwell: 600 })
  await box(page, 'header', 'the thesis, in one line', 3200)

  mark('intro-2')
  const id = await box(page, '[data-testid="intro"] p', 'you prune while it thinks')
  await moveToEl(page, '[data-testid="intro"] p', { dwell: 3000 })
  boxOff(id)

  mark('intro-3')
  for (const i of [0, 1, 2]) await moveToEl(page, `[data-testid="example"] >> nth=${i}`, { travel: 450, dwell: 700 })
})

/* --- 2. start a real run ------------------------------------------------- */
await scene('start', async () => {
  await clickEl(page, '[data-testid="prompt"]')
  await page.locator('[data-testid="prompt"]').fill('')
  await page.locator('[data-testid="prompt"]').pressSequentially(PROMPT, { delay: 55 })
  mark('typed')
  await box(page, '[data-testid="prompt"]', 'a real task, on a real repo', 2200)

  await clickEl(page, '[data-testid="run"]')
  mark('scanning')
  await box(page, '[data-testid="scanning"]', 'a second, cheaper model scans in parallel', 3000).catch(() => {})
})

/* --- 3. the tree --------------------------------------------------------- */
let ids = []
await scene('tree', async () => {
  await page.waitForSelector('[data-testid="tree"]', { timeout: 60_000 })
  ids = await page.locator('[data-testid^="div-"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-testid').slice(4)))
  console.log(`    tree: ${ids.length} divergences`)
  mark('tree')
  const t = await box(page, '[data-testid="tree"]', 'the decision points, ranked')
  await page.waitForTimeout(2500)
  boxOff(t)

  mark('tree-guard')
  await box(page, `[data-testid="branch-${ids[0]}-0"]`, 'label · files · cost · confidence', 2500)
})

/* --- 4. the kill, and the proof it landed -------------------------------- */
await scene('kill', async () => {
  mark('kill')
  await moveToEl(page, `[data-testid="branch-${ids[0]}-0"]`, { dwell: 500 })
  await key(page, 'Digit1', '1')

  mark('killed')
  await page.waitForSelector('[data-testid="toast"]', { timeout: 15_000 })
  // The toast auto-hides after 3.2s, so the box must not outlive the thing it points at.
  await box(page, '[data-testid="toast"]', 'the constraint — written during the scan, no model call', 2600)

  mark('queued')
  await page.waitForSelector('[data-testid="directives"]', { timeout: 30_000 })
  const q = await box(page, '[data-testid="directives"]', 'queued for the next tool call')
  await page.waitForTimeout(2500)
  boxOff(q)
})

await scene('applied', async () => {
  // Capped deliberately. It normally lands in about three seconds; when the agent has already
  // taken its last step it never will, and waiting three minutes for that would cost us the
  // multiplayer and diff scenes too.
  await page.locator('[data-testid="directives"]').getByText('✓ applied').first()
    .waitFor({ timeout: 45_000 })
  mark('applied')
  await box(page, '[data-testid="directives"]', 'drained at the tool-call boundary, mid-run', 5000)
})

/* --- the multiplayer tree, while OUR run is still in flight -------------- */
// One run, not two: the second browser helps the run we already have going. That also keeps the
// whole capture inside the production rate limit.
// A SEPARATE context, not just another tab: pages in one context share localStorage, so the
// helper would carry our own client id, the server would call it the owner, and no handshake
// would ever appear on our tree.
const contextB = await browser.newContext(contextOpts)
const pageB = await contextB.newPage()
ev({ type: 'pageB', role: 'created' })
await scene('multiplayer', async () => {
  await installWallet(pageB)
  await pageB.goto(BASE, { waitUntil: 'domcontentloaded' })
  await pageB.waitForTimeout(1200)

  mark('multi')
  await key(pageB, 'Tab', 'tab')
  await pageB.waitForSelector('[data-testid="helping"]', { timeout: 25_000 })
  await box(pageB, '[data-testid="helping"]', "our tree, in someone else's browser", 4200, 'b')
  await key(pageB, 'Digit3', '3')      // a branch we did not touch ourselves
  await pageB.waitForTimeout(1500)

  // Back to our own browser to watch their prune land on our tree.
  await page.bringToFront()
  await page.waitForTimeout(500)
  mark('helped')
  await page.locator('[data-testid^="helped-"]').first().waitFor({ timeout: 120_000 })
  await box(page, '[data-testid^="helped-"]', 'pruned by someone else, mid-run', 5000)
})


await scene('working', async () => {
  mark('working')
  if (!await box(page, '[data-testid="activity"]', 'reading and writing real files', 5000))
    await box(page, '[data-testid="tree"]', 'reading and writing real files', 5000)
})

/* --- 5. the unfakeable claim --------------------------------------------- */
await scene('result', async () => {
  await page.waitForSelector('[data-testid="result"]', { timeout: 300_000 })
  mark('result')
  const lost = await box(page, `[data-testid="branch-${ids[0]}-0"]`, 'killed')
  const won = await box(page, `[data-testid="branch-${ids[0]}-1"]`, 'what the finished code did')
  await page.waitForTimeout(4500)
  boxOff(lost); boxOff(won)

  mark('result-2')
  await box(page, '[data-testid="calibration"]', 'your guess vs what the agent chose', 4500)
})

await scene('diff', async () => {
  // The toast is pinned to the bottom centre and sits on top of the diff header, so wait for
  // it to clear and aim at the header's left edge rather than its middle.
  if (!await page.locator('[data-testid="diff"]').isVisible().catch(() => false)) {
    console.log('    (this run wrote no files, so there is no diff to show)')
    return
  }
  await page.locator('[data-testid="diff"]').scrollIntoViewIfNeeded({ timeout: 10_000 })
  await page.locator('[data-testid="toast"]').waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(400)
  const dh = await rectOf(page, '[data-testid="diff"] button')
  if (dh) await moveTo(page, Math.round(dh.x + 90), Math.round(dh.y + dh.height / 2), { dwell: 200 })
  ev({ type: 'click', x: Math.round(cx), y: Math.round(cy) })
  await page.locator('[data-testid="diff"] button').click({ timeout: 15_000, force: true })
  mark('diff')
  await page.waitForTimeout(800)
  await box(page, '[data-testid="diff"]', 'a real unified diff, computed without git', 3000)
  await page.mouse.wheel(0, 320); await page.waitForTimeout(1200)
  await page.mouse.wheel(0, 320); await page.waitForTimeout(2500)
  await page.locator('[data-testid="diff"] button').click({ timeout: 15_000, force: true })   // collapse again
  await page.waitForTimeout(400)
})

/* --- 6. what it learned -------------------------------------------------- */
await scene('prefs', async () => {
  await page.locator('[data-testid="prefs"]').scrollIntoViewIfNeeded({ timeout: 10_000 })
  await page.waitForTimeout(600)
  mark('prefs')
  await box(page, '[data-testid="prefs"]', 'killed 3× and the scan stops asking', 5000)
  mark('prefs-2')
  await moveToEl(page, '[data-testid="forget"]', { dwell: 800 })
  await box(page, '[data-testid="forget"]', 'and you can take it back', 3500)
  await page.mouse.wheel(0, -900)
  await page.waitForTimeout(800)
})

/* --- 8. x402, for real --------------------------------------------------- */
await scene('x402', async () => {
  await page.locator('[data-testid="paywall"]').scrollIntoViewIfNeeded({ timeout: 10_000 })
  mark('paywall')
  await moveToEl(page, '[data-testid="paywall"]', { dwell: 400 })
  await box(page, '[data-testid="paywall"]', 'three free · the rest cost a cent each', 4500)

  await key(page, 'Enter', 'enter')
  await page.locator('[data-testid="toast"]').filter({ hasText: /paid|✗/ }).waitFor({ timeout: 90_000 })
  const toast = (await page.locator('[data-testid="toast"]').textContent()) ?? ''
  console.log(`    x402 -> ${toast.slice(0, 120)}`)
  mark('paid')
  await box(page, '[data-testid="toast"]', 'signed, verified, settled on Base Sepolia', 4200)
  await box(page, '[data-testid="tree"]', 'the paid decision point, now yours', 3000)
})

// The full hash is not in the toast, so read the newest transfer for our wallet off-chain.
await scene('txlookup', async () => {
  // The toast truncates the hash and basescan's API now wants a key, so read the transfer
  // straight off Base Sepolia.
  const rpc = createPublicClient({ chain: baseSepolia, transport: http() })
  const head = await rpc.getBlockNumber()
  const logs = await rpc.getLogs({
    event: parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)'),
    args: { from: account.address },
    fromBlock: head - 400n, toBlock: head,
  })
  unlockTx = logs.at(-1)?.transactionHash ?? ''
  console.log(`    latest on-chain transfer: ${unlockTx || '(none found)'}`)
})

await scene('basescan', async () => {
  const url = unlockTx
    ? `https://sepolia.basescan.org/tx/${unlockTx}`
    : `https://sepolia.basescan.org/address/${account.address}#tokentxns`
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)
  mark('basescan')
  let drew = false
  for (const sel of ['#ContentPlaceHolder1_maintable', 'div.card', 'main']) {
    if (await box(page, sel, 'on-chain, not a mock', 5500)) { drew = true; break }
  }
  if (!drew) {
    // Not our markup to depend on: frame the top of the page, where the hash and status sit.
    ev({ type: 'box', id: 'bScan', page: 'a', label: 'on-chain, not a mock', rect: { x: 24, y: 90, w: VW - 48, h: 320 } })
    await page.waitForTimeout(5500)
    ev({ type: 'boxoff', id: 'bScan' })
  }
})

await scene('health', async () => {
  // Navigating to the JSON endpoint aborts in Chromium; fetch it and lay it out instead.
  const health = await fetch(`${BASE}/api/health`).then((r) => r.json())
  console.log(`    health: bazaar ${health.bazaar?.total} · store ${health.store?.kind} · ${health.region}`)
  await page.setContent(`<style>
      body{margin:0;background:#0a0a0a;color:#d4d4d4;font:19px/1.9 Consolas,ui-monospace,monospace;
           display:flex;align-items:center;justify-content:center;height:100vh}
      pre{margin:0;padding:32px 38px;border:1px solid #262626;border-radius:10px;background:#0f0f0f}
      .k{color:#737373}
    </style><pre>GET ${BASE}/api/health

${JSON.stringify(health, null, 2)}</pre>`)
  await page.waitForTimeout(1200)
  mark('health')
  await box(page, 'pre', 'every integration, reported live', 5000)
  mark('health-2')
  await page.waitForTimeout(6000)
})

await scene('seller', async () => {
  await page.goto(`https://sepolia.basescan.org/address/${account.address}#tokentxns`, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6500)
  mark('seller')
  await page.waitForTimeout(6000)
})

/* --- 9. close ------------------------------------------------------------ */
await scene('close', async () => {
  await page.goto(BASE, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(1500)
  mark('close')
  await moveTo(page, 760, 300, { travel: 900, dwell: 2500 })
  mark('close-2')
  await box(page, 'header', null, 6000)
})

ev({ type: 'end' })

/* --------------------------------------------------------------- finish ---- */

const videoA = page.video(), videoB = pageB.video()
const pathA = await videoA.path()
const pathB = await videoB?.path().catch(() => null)
await page.close(); await pageB.close()
await context.close(); await contextB.close()   // flushes both .webm files
await browser.close()
fs.renameSync(pathA, path.join(OUT, 'main.webm'))
if (pathB && fs.existsSync(pathB)) fs.renameSync(pathB, path.join(OUT, 'helper.webm'))

const bStart = events.find((e) => e.type === 'pageB')?.t ?? 0
fs.writeFileSync(path.join(OUT, 'timeline.json'), JSON.stringify({
  base: BASE, prompt: PROMPT, viewport: { width: VW, height: VH },
  wallet: account.address, unlockTx,
  main: 'main.webm', helper: fs.existsSync(path.join(OUT, 'helper.webm')) ? 'helper.webm' : null,
  helperStartMs: bStart,
  durationMs: events.at(-1).t,
  events,
}, null, 2))

const marks = events.filter((e) => e.type === 'mark').map((e) => e.name)
console.log(`\ncaptured ${(events.at(-1).t / 1000 / 60).toFixed(1)} min, ${events.length} events`)
console.log(`marks: ${marks.join(', ')}`)
const failed = events.filter((e) => e.type === 'sceneFailed').map((e) => e.name)
if (failed.length) console.log(`FAILED SCENES: ${failed.join(', ')}`)
