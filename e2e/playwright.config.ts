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

/**
 * The recovery suite (#82) runs the real web platform against a real host process, so its UI has
 * to be built with a token and a host address — the address of the TCP relay the spec puts in
 * front of the host (e2e/fixtures/real-host.ts), which lets the spec drop the page's socket and
 * restart the host behind it. Its own server for the same reason as the startup suite's: the
 * token and address are baked in when vite starts.
 */
const RECOVERY_PORT = 5177
const RECOVERY_URL = `http://127.0.0.1:${RECOVERY_PORT}`
// The older-host suite (#280) runs the same way: the real web platform, a real host, the relay on 5178
const RECOVERY_SPEC = /(recovery|older-host)\.spec\.ts/

/**
 * The linked-hosts suite (#82) runs the real web platform against two real hosts linked to each
 * other (e2e/fixtures/linked-hosts.ts), the page reaching the hub through a relay on 5180. Its own
 * server and one worker, for the same reasons as the recovery suite's.
 */
const LINKED_PORT = 5179
const LINKED_URL = `http://127.0.0.1:${LINKED_PORT}`
const LINKED_SPEC = /linked-hosts(-webkit)?\.spec\.ts/

/**
 * The engine the suite runs in. Unset (`pnpm e2e`), Chromium, with the scenarios that most depend
 * on the engine run a second time in WebKit by their `-webkit.spec.ts` twins. `E2E_BROWSER` names
 * one engine and runs every spec in it, which is what CI does, once per engine (the `e2e (webkit)`
 * and `e2e (chromium)` jobs in .github/workflows/build.yml): WebKit is the desktop app on macOS and
 * Linux (WKWebView, WebKitGTK), Chromium is the app on Windows (WebView2).
 *
 * A one-engine run leaves out what the other engine's run covers. A twin only repeats its base
 * spec in WebKit, so both runs leave it out (tooling/e2e-webkit-twins.test.ts holds every twin to
 * that). grid-ring.spec.ts is a WebKit scenario with no Chromium half, so the Chromium run leaves it
 * out too. Any other spec that picks WebKit itself fails the Chromium run, which installs no WebKit.
 */
const ENGINE = process.env.E2E_BROWSER
const BROWSER = ENGINE === 'webkit' ? 'webkit' : 'chromium'
const WEBKIT_TWIN = /-webkit\.spec\.ts/
const WEBKIT_ONLY = /grid-ring\.spec\.ts/
const leftOut = ENGINE === 'webkit' ? [WEBKIT_TWIN] : ENGINE === 'chromium' ? [WEBKIT_TWIN, WEBKIT_ONLY] : []

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
  // The engine's first page on a machine is slow (WebKit builds its caches): opened here, not in a test (warm-engine.ts)
  globalSetup: './warm-engine.ts',
  use: { baseURL: 'http://127.0.0.1:5174', trace: 'off', browserName: BROWSER },
  projects: [
    { name: 'app', testIgnore: [STARTUP_SPEC, RECOVERY_SPEC, LINKED_SPEC, ...leftOut] },
    { name: 'startup', testMatch: STARTUP_SPEC, use: { baseURL: STARTUP_URL } },
    // One worker: the relay port (5178) is baked into this project's UI build, so two of its
    // tests at once would collide on it (`--repeat-each 5` failed 4 of 5 with EADDRINUSE).
    { name: 'recovery', testMatch: RECOVERY_SPEC, use: { baseURL: RECOVERY_URL }, workers: 1 },
    { name: 'linked', testMatch: LINKED_SPEC, testIgnore: leftOut, use: { baseURL: LINKED_URL }, workers: 1 },
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
    {
      command: `pnpm --filter @cc/web exec vite --host 127.0.0.1 --port ${RECOVERY_PORT} --strictPort`,
      url: RECOVERY_URL,
      // Must match RECOVERY_TOKEN and RECOVERY_RELAY_PORT in e2e/fixtures/real-host.ts
      env: { VITE_HOST_TOKEN: 'e2e-recovery-token', VITE_HOST_URL: 'ws://127.0.0.1:5178' },
      reuseExistingServer: false,
      timeout: 60000,
    },
    {
      command: `pnpm --filter @cc/web exec vite --host 127.0.0.1 --port ${LINKED_PORT} --strictPort`,
      url: LINKED_URL,
      // Must match LINKED_TOKEN and LINKED_RELAY_PORT in e2e/fixtures/linked-hosts.ts
      env: { VITE_HOST_TOKEN: 'e2e-linked-token', VITE_HOST_URL: 'ws://127.0.0.1:5180' },
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
})
