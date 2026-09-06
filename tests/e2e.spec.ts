import { test, expect, type Page } from '@playwright/test'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'

// Semua tes memakai model sungguhan. Satu run ~60-120 detik.
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

test('kill mengubah eksekusi: steer -> injected -> commit ke cabang lawan -> kalibrasi 100% + diff nyata', async ({ page }) => {
  const ids = await startRun(page)
  // Sambil menunggu: ask mode, collapse, dan tab tanpa run lain.
  await page.keyboard.press('Space')
  await expect(page.getByTestId('ask')).toBeVisible()
  await expect(page.getByTestId('legend')).toContainText('[y] pilih kiri')
  await page.keyboard.press('Space')
  await expect(page.getByTestId('ask')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('collapsed')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('tree')).toBeVisible()
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('toast')).toContainText('tidak ada run lain')

  // Bunuh cabang 0 divergensi pertama. Efek harus < 1 detik: toast berisi constraint dari scan.
  await page.keyboard.press('Digit1')
  await expect(page.getByTestId('toast')).toContainText(/killed · injected: ".+"/)
  await expect(page.getByTestId(`branch-${ids[0]}-0`)).toHaveAttribute('data-state', /killed|lost/)

  // Selama menunggu, agent terlihat bekerja (tool activity), bukan spinner kosong.
  await expect(page.getByTestId('activity')).toBeVisible({ timeout: 120_000 })

  await expect(page.getByTestId('result')).toBeVisible({ timeout: 240_000 })
  // Main run WAJIB tidak memilih cabang yang dibunuh: itu satu-satunya klaim yang tidak bisa dipalsukan.
  await expect(page.getByTestId(`branch-${ids[0]}-0`)).toHaveAttribute('data-state', 'lost')
  await expect(page.getByTestId(`branch-${ids[0]}-1`)).toHaveAttribute('data-state', 'won')
  await expect(page.getByTestId('calibration')).toContainText('calibration 100%')

  // Diff-nya nyata: header a/<file> b/<file>, dan [d] membukanya.
  await expect(page.getByTestId('diff')).toBeVisible()
  await page.keyboard.press('d')
  await expect(page.getByTestId('diff')).toContainText(/diff --git a\/.+ b\/.+/)
  await expect(page.getByTestId('diff')).toContainText('+++ b/')
  await expect(page.getByTestId('diff')).not.toContainText('.simpang/runs')   // path working copy tidak bocor ke header
})

test('pangkasan terlambat tidak menguap: late -> [f] fork merevisi di working copy yang sama', async ({ page }) => {
  test.setTimeout(540_000)   // dua run agent berturut-turut: main run lalu fork
  await startRun(page)
  // Tunggu commit pertama (tool decide di tengah run, atau classifier di akhir),
  // lalu bunuh cabang yang SUDAH dimenangkan -> late, apa pun status run-nya.
  const won = page.locator('[data-state="won"]').first()
  await expect(won).toBeVisible({ timeout: 240_000 })
  const key = (await won.locator('span').first().textContent())!.trim()
  const code = /\d/.test(key) ? `Digit${key}` : key === '-' ? 'Minus' : 'Equal'
  const diffBefore = await page.getByTestId('diff').textContent().catch(() => '')
  await page.keyboard.press(code)
  await expect(page.getByTestId('toast')).toContainText('late')
  await expect(page.getByTestId('legend')).toContainText('[f] fork koreksi')

  await page.keyboard.press('f')
  await expect(page.getByTestId('toast')).toContainText('forking')
  // Fork adalah run agent kedua di working copy yang sama; selesainya ditandai toast + diff baru.
  await expect(page.getByTestId('toast')).toContainText('forked · diff diperbarui', { timeout: 240_000 })
  await expect(won).toHaveAttribute('data-state', 'lost')
  await expect(page.getByTestId('diff')).toBeVisible()
  expect(await page.getByTestId('diff').textContent()).not.toBe(diffBefore)
})

test('pohon multiplayer: [tab] mengambil run orang lain dan pangkasanmu masuk ke antrian mereka', async ({ browser, request }) => {
  const a = await browser.newPage()
  const b = await browser.newPage()
  await startRun(a, 'add rate limiting to the login endpoint')
  const theirsRes = await request.get('/api/others?exclude=none')
  const theirs = await theirsRes.json()
  expect(theirs, `others -> ${theirsRes.status()} ${JSON.stringify(theirs).slice(0, 200)}`).toHaveProperty('prompt', 'add rate limiting to the login endpoint')

  await startRun(b)
  await b.keyboard.press('Tab')
  await expect(b.getByTestId('helping')).toBeVisible()
  await expect(b.getByTestId('helping')).toContainText('add rate limiting')
  await b.keyboard.press('Digit1')
  await expect(b.getByTestId('toast')).toContainText(/killed|late/)

  const state = await request.get(`/api/others?runId=${theirs.runId}`).then((r) => r.json())
  expect(Object.keys(state.actions)).toHaveLength(1)
  await b.keyboard.press('Tab')
  await expect(b.getByTestId('helping')).toHaveCount(0)
  await a.close(); await b.close()
})

test('x402 lewat wallet sungguhan: [enter] -> 402 -> tanda tangan EIP-3009 valid -> facilitator memutuskan', async ({ page }) => {
  // Wallet EVM asli (kunci baru, saldo 0) disuntik sebagai window.ethereum. Tanda tangannya
  // sah secara kriptografi; facilitator x402.org menolak karena saldo, BUKAN karena tanda tangan.
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
  test.skip(!(await paywall.isVisible()), 'scan ini tidak menghasilkan divergensi terkunci')
  await expect(paywall).toContainText('[enter] bayar via x402')
  await expect(paywall).not.toContainText('butuh wallet')

  await page.keyboard.press('Enter')
  const toast = page.getByTestId('toast')
  await expect(toast).toContainText(/paid|✗/, { timeout: 60_000 })
  const text = (await toast.textContent()) ?? ''
  expect(text).not.toMatch(/butuh wallet|signature|unsupported|HTTP 402/i)
  // Saldo 0 -> facilitator menolak karena saldo; kunci berisi USDC testnet -> "paid".
  expect(text).toMatch(/paid|insufficient_balance/i)
})
