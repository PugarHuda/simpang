import { defineConfig } from '@playwright/test'

// The pure logic, run with no browser and no server. Playwright is already a dependency and its
// runner resolves TypeScript and tsconfig paths, which is the only reason these tests can import
// from lib/ at all — node's own type stripping refuses extensionless imports.
export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.unit\.ts/,
  reporter: [['list']],
  timeout: 10_000,
})
