import { defineConfig } from '@playwright/test'
import { assertBrowserSandbox } from './browser-sandbox.js'

const port = Number(process.env.SECURITY_DIFF_E2E_PORT ?? '5197')
// Chromium, Playwright's default here; checked before the server starts as every config is (#592). The style
// snapshot's override does not apply to this spec, so it is not read.
assertBrowserSandbox('chromium', process.platform, { ...process.env, STYLE_SNAPSHOT_BROWSER: undefined })

export default defineConfig({
  testDir: '.',
  testMatch: /security-diff\.spec\.ts/,
  timeout: 45_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
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
