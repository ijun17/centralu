import { defineConfig } from '@playwright/test'

/**
 * Only the startup-screen test runs on its **own** server.
 *
 * What startup.spec.ts checks is "what happens when the app comes up with no token", and that
 * token is baked in when the dev server starts. A person who followed CONTRIBUTING and started
 * `VITE_HOST_TOKEN=... pnpm dev` has a server on 5174 that **does** have a token, and if
 * reuseExistingServer attaches to that one, the test fails without knowing what it was even
 * measuring. So this one suite alone starts fresh on a different port, with no reuse, and the
 * token is explicitly emptied out.
 */
const STARTUP_PORT = 5176
const STARTUP_URL = `http://127.0.0.1:${STARTUP_PORT}`
const STARTUP_SPEC = /startup\.spec\.ts/

export default defineConfig({
  testDir: '.',
  // Keep security-diff.spec.ts in the default `pnpm e2e` suite; the separate config is only for isolated local reruns.
  testMatch: /.*\.spec\.ts/,
  timeout: 20000,
  expect: { timeout: 5000 },
  fullyParallel: true,
  // Stops CI from being fooled into "all passed" if a `test.only` was left in and pushed locally
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5174', trace: 'off' },
  projects: [
    { name: 'app', testIgnore: STARTUP_SPEC },
    { name: 'startup', testMatch: STARTUP_SPEC, use: { baseURL: STARTUP_URL } },
  ],
  webServer: [
    {
      command: 'pnpm --filter @cc/web exec vite --port 5174 --strictPort',
      url: 'http://127.0.0.1:5174',
      // Reuse a dev server already running locally, but always start a fresh one in CI, since
      // attaching to someone else's server there would leave it unclear what was tested
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      command: `pnpm --filter @cc/web exec vite --host 127.0.0.1 --port ${STARTUP_PORT} --strictPort`,
      url: STARTUP_URL,
      // An empty value makes bootstrap treat it as 'absent' — this way even a person who has
      // exported a token in their shell gets the same test
      env: { VITE_HOST_TOKEN: '' },
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
})
