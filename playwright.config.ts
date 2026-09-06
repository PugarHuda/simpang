import { defineConfig } from '@playwright/test'

// E2E runs against REAL models (no mocks): scan on gpt-56-luna, main run on qwen3-coder
// (a cheap agent that obeys tool calls, ~$0.03 per run). Needs VENICE_API_KEY in .env.local.
// SIMPANG_FREE_BRANCHES=2 so the 3rd divergence is locked and the x402 gate is exercised too.
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
      SIMPANG_RUN_LIMIT: '60',   // this suite fires ~7 runs from one IP within an hour
    },
  },
})
