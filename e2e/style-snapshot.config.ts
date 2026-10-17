import { defineConfig } from '@playwright/test'
import { assertBrowserSandbox } from './browser-sandbox.js'

/**
 * Its own server for style-snapshot.spec.ts. A before/after comparison is only worth something if
 * both runs record this checkout, so it never attaches to a dev server that is already up (which
 * could be another worktree's), and its port stays clear of the ones `pnpm e2e` uses.
 */
const port = Number(process.env.STYLE_SNAPSHOT_PORT ?? '5198')
// The spec picks WebKit with STYLE_SNAPSHOT_BROWSER=webkit: refused inside the macOS sandbox before the server starts (#592)
assertBrowserSandbox(process.env.STYLE_SNAPSHOT_BROWSER === 'webkit' ? 'webkit' : 'chromium')

export default defineConfig({
  testDir: '.',
  testMatch: /style-snapshot\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, trace: 'off' },
  webServer: {
    command: `pnpm --filter @cc/web exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
