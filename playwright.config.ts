import { defineConfig } from '@playwright/test'

// E2E jalan melawan model SUNGGUHAN (tanpa mock): scan gpt-56-luna, main run qwen3-coder
// (agent murah yang patuh tool call, ~$0.03 per run). Butuh VENICE_API_KEY di .env.local.
// SIMPANG_FREE_BRANCHES=2 supaya divergensi ke-3 terkunci dan gerbang x402 ikut teruji.
const PORT = 3101

export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.ts/,
  timeout: 300_000,
  expect: { timeout: 30_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: `http://localhost:${PORT}`, headless: true, trace: 'retain-on-failure' },
  webServer: {
    command: `npx next dev -p ${PORT}`,
    url: `http://localhost:${PORT}`,
    timeout: 90_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      SIMPANG_MAIN_MODEL: process.env.SIMPANG_TEST_MAIN_MODEL ?? 'qwen3-coder-480b-a35b-instruct-turbo',
      SIMPANG_FREE_BRANCHES: '2',
    },
  },
})
