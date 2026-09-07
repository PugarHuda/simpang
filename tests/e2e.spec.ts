import { test, expect, type Page } from '@playwright/test'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'

// Every test runs against real models. One run takes 60-120 seconds.
const PROMPT = 'refactor the auth system to use sessions'

async function startRun(page: Page, prompt = PROMPT) {
  await page.goto('/')
  await page.getByTestId('prompt').fill(prompt)
  await page.getByTestId('run').click()
  await expect(page.getByTestId('tree')).toBeVisible({ timeout: 45_000 })
  const ids = await page.locator('[data-testid^="div-"]').evaluateAll((els) =>
    els.map((e) => e.getAttribute('data-testid')!.slice(4)))
  expect(ids.length).toBeGreaterThan(0)
  return ids
}

test('a kill changes execution: steer -> injected -> commits to the opposite branch -> 100% calibration + a real diff', async ({ page }) => {
  const ids = await startRun(page)
  // While waiting: ask mode, collapse, and tab with no other run in flight.
  await page.keyboard.press('Space')
  await expect(page.getByTestId('ask')).toBeVisible()
  await expect(page.getByTestId('legend')).toContainText('[y] take left')
  // [space] walks the whole tree, one divergence per press, then closes.
  for (let i = 1; i < ids.length; i++) {
    await page.keyboard.press('Space')
    await expect(page.getByTestId(`div-${ids[i]}`).getByTestId('ask')).toBeVisible()
  }
  await page.keyboard.press('Space')
  await expect(page.getByTestId('ask')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('collapsed')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('tree')).toBeVisible()
  await page.keyboard.press('Tab')
  // The store is shared, so another live run is legitimate here (the multiplayer test, or one
  // orphaned by a killed server inside the staleness window). This only asserts [tab] does
  // something sane and comes back; the multiplayer test owns the rest.
  await expect(page.getByTestId('toast').or(page.getByTestId('helping'))).toBeVisible()
  if (await page.getByTestId('helping').isVisible()) {
    await page.keyboard.press('Tab')
    await expect(page.getByTestId('helping')).toHaveCount(0)
  }

  // Kill branch 0 of the first divergence. The effect must land in under a second:
  // the toast carries the constraint that was written during the scan.
  await page.keyboard.press('Digit1')
  await expect(page.getByTestId('toast')).toContainText(/killed · injected: ".+"/)
  await expect(page.getByTestId(`branch-${ids[0]}-0`)).toHaveAttribute('data-state', /killed|lost/)

  // While you wait the agent is visibly working (tool activity), not an empty spinner.
  await expect(page.getByTestId('activity')).toBeVisible({ timeout: 120_000 })

  await expect(page.getByTestId('result')).toBeVisible({ timeout: 240_000 })
  // Once the run is over, nothing may still claim to be waiting for a tool call that will never
  // come. Every directive has resolved one way or the other.
  if (await page.getByTestId('directives').isVisible())
    await expect(page.getByTestId('directives')).not.toContainText('… queued')
  // The main run MUST NOT take the killed branch: that is the one claim that cannot be faked.
  await expect(page.getByTestId(`branch-${ids[0]}-0`)).toHaveAttribute('data-state', 'lost')
  await expect(page.getByTestId(`branch-${ids[0]}-1`)).toHaveAttribute('data-state', 'won')
  await expect(page.getByTestId('calibration')).toContainText('calibration 100%')

  // The diff is real: a/<file> b/<file> headers, and [d] opens it.
  await expect(page.getByTestId('diff')).toBeVisible()
  await page.keyboard.press('d')
  await expect(page.getByTestId('diff')).toContainText(/diff --git a\/.+ b\/.+/)
  await expect(page.getByTestId('diff')).toContainText('+++ b/')
  await expect(page.getByTestId('diff')).not.toContainText('.simpang/runs')   // the working-copy path never leaks into the header

  // Learned preferences show up after the run (that kill = 1x) and can be forgotten.
  await expect(page.getByTestId('prefs')).toBeVisible()
  await expect(page.getByTestId('prefs')).toContainText('forget')

  // A surviving prefetched branch can be APPLIED: a fork in the same working copy, not just something to read.
  const apply = page.locator('[data-testid^="apply-"]').first()
  if (await apply.isVisible()) {
    test.setTimeout(540_000)
    await apply.click()
    await expect(page.getByTestId('toast')).toContainText('forking')
    await expect(page.getByTestId('toast')).toContainText('forked · diff updated', { timeout: 240_000 })
  }
})

test('a late prune does not evaporate: late -> [f] forks a revision in the same working copy', async ({ page }) => {
  test.setTimeout(540_000)   // two agent runs back to back: the main run, then the fork
  await startRun(page)
  // Wait for the first commit (the decide tool mid-run, or the classifier at the end), then kill
  // the branch that already WON -> late, whatever state the run is in.
  const firstWon = page.locator('[data-state="won"]').first()
  await expect(firstWon).toBeVisible({ timeout: 240_000 })
  // Pin the element down by testid: after the fork the opposite branch becomes "won".
  const won = page.getByTestId((await firstWon.getAttribute('data-testid'))!)
  const key = (await won.locator('span').first().textContent())!.trim()
  const code = /\d/.test(key) ? `Digit${key}` : key === '-' ? 'Minus' : 'Equal'
  const diffBefore = await page.getByTestId('diff').textContent().catch(() => '')
  await page.keyboard.press(code)
  await expect(page.getByTestId('toast')).toContainText('late')
  await expect(page.getByTestId('legend')).toContainText('[f] fork the fix')

  await page.keyboard.press('f')
  await expect(page.getByTestId('toast')).toContainText('forking')
  // The fork is a second agent run in the same working copy; it finishes with a toast and a new diff.
  await expect(page.getByTestId('toast')).toContainText('forked · diff updated', { timeout: 240_000 })
  await expect(won).toHaveAttribute('data-state', 'lost')
  await expect(page.getByTestId('diff')).toBeVisible()
  expect(await page.getByTestId('diff').textContent()).not.toBe(diffBefore)
})

test('the multiplayer tree: [tab] picks up someone else\'s run and your prune lands in their queue', async ({ browser, request }) => {
  const a = await browser.newPage()
  const b = await browser.newPage()
  // B's run starts FIRST. Waiting for a tree takes 30-45s, and on a fast model the run it is
  // supposed to help would already be finished by then — /api/others only offers live runs.
  await startRun(b)
  await startRun(a, 'add rate limiting to the login endpoint')
  const theirsRes = await request.get('/api/others?exclude=none')
  const theirs = await theirsRes.json()
  expect(theirs, `others -> ${theirsRes.status()} ${JSON.stringify(theirs).slice(0, 200)}`).toHaveProperty('prompt', 'add rate limiting to the login endpoint')

  await b.keyboard.press('Tab')
  await expect(b.getByTestId('helping')).toBeVisible()
  await expect(b.getByTestId('helping')).toContainText('add rate limiting')
  await b.keyboard.press('Digit1')
  await expect(b.getByTestId('toast')).toContainText(/killed|late/)

  const state = await request.get(`/api/others?runId=${theirs.runId}`).then((r) => r.json())
  expect(Object.keys(state.actions)).toHaveLength(1)
  // Attribution: a prune from another browser is recorded as a helper, and the owner sees the 🤝
  // on their tree through the `actions` event at the next step boundary (no polling).
  expect(Object.values(state.actions as Record<string, { by?: string }>)[0].by).toBe('helper')
  await expect(a.locator('[data-testid^="helped-"]').first()).toBeVisible({ timeout: 150_000 })
  await b.keyboard.press('Tab')
  await expect(b.getByTestId('helping')).toHaveCount(0)
  await a.close(); await b.close()
})

test.describe('phone: no keyboard, a research prompt', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('example prompt -> live-data tools -> tap the kill button -> the directive is visible -> a markdown answer with a table', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('intro')).toBeVisible()
    await page.getByTestId('example').filter({ hasText: 'bitcoin' }).click()
    await expect(page.getByTestId('prompt')).toHaveValue(/bitcoin/)
    await page.getByTestId('run').click()
    await expect(page.getByTestId('tree')).toBeVisible({ timeout: 45_000 })
    await expect(page.getByTestId('intro')).toHaveCount(0)

    // The kill/pin buttons are always visible on a small screen; tapping steers without a number row.
    const ids = await page.locator('[data-testid^="div-"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-testid')!.slice(4)))
    const killBtn = page.getByTestId(`kill-${ids[0]}-0`)
    await expect(killBtn).toBeVisible()
    await killBtn.click()
    await expect(page.getByTestId('toast')).toContainText(/killed · injected|late/)
    // The directive that landed is shown as a panel, not just a toast that flashes past.
    await expect(page.getByTestId('directives')).toContainText(/queued|applied/)
    await expect(page.getByTestId(`status-${ids[0]}`)).toContainText(/killed · waiting|resolved/)

    // The agent uses live data and writes a deliverable, instead of "I have no access".
    await expect(page.getByTestId('activity')).toContainText(/market data|searching the web/, { timeout: 120_000 })
    await expect(page.getByTestId('result')).toBeVisible({ timeout: 240_000 })
    const output = page.getByTestId('output')
    await expect(output).not.toContainText(/(no|don't have|do not have|lack) (real-?time |live )?(data )?access/i)
    await expect(output.locator('table, h1, h2, h3').first()).toBeVisible()   // markdown is rendered, not raw text
    await expect(output).toContainText(/\$?\d{2}[.,]\d{3}/)                    // real price numbers
    await expect(page.getByTestId('directives')).toContainText('✓ applied')
    // The agent's reason shows under a divergence once it is resolved.
    await expect(page.locator('[data-testid^="why-"]').first()).toBeVisible()
  })
})

test('x402 with a real wallet: [enter] -> 402 -> a valid EIP-3009 signature -> the facilitator decides', async ({ page }) => {
  // A real EVM wallet (fresh key, zero balance) is injected as window.ethereum. Its signature is
  // cryptographically valid; the x402.org facilitator rejects it for BALANCE, not for the signature.
  const account = privateKeyToAccount(generatePrivateKey())
  await page.exposeFunction('__signTypedData', (json: string) => account.signTypedData(JSON.parse(json)))
  await page.addInitScript((address) => {
    ;(window as unknown as { ethereum: unknown }).ethereum = {
      isSimpangTestWallet: true,
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address]
        if (method === 'eth_chainId') return '0x14a34'
        if (method === 'eth_signTypedData_v4') {
          const typed = JSON.parse(params![1] as string)
          delete typed.types.EIP712Domain
          return (window as unknown as { __signTypedData: (s: string) => Promise<string> }).__signTypedData(JSON.stringify(typed))
        }
        throw new Error(`unsupported: ${method}`)
      },
    }
  }, account.address)

  await startRun(page)
  const paywall = page.getByTestId('paywall')
  test.skip(!(await paywall.isVisible()), 'this scan produced no locked divergence')
  await expect(paywall).toContainText('[enter] pay via x402')
  await expect(paywall).not.toContainText('needs an EVM wallet')

  await page.keyboard.press('Enter')
  const toast = page.getByTestId('toast')
  await expect(toast).toContainText(/paid|✗/, { timeout: 60_000 })
  const text = (await toast.textContent()) ?? ''
  expect(text).not.toMatch(/needs an EVM wallet|signature|unsupported|HTTP 402/i)
  // Zero balance -> the facilitator rejects on balance; a key holding testnet USDC -> "paid".
  expect(text).toMatch(/paid|insufficient_balance/i)
})
