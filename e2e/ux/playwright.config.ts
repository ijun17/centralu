import { defineConfig } from '@playwright/test'

/**
 * The task-cost suite (#518, docs/ux-metrics.md): `pnpm ux`.
 *
 * Its own config and server, apart from `pnpm e2e`: the tasks are `*.task.ts`, which the main
 * suite does not match, and they run in one engine, WebKit by default, the desktop app on macOS
 * and Linux. Geometry is part of the numbers (Fitts's law reads the boxes on screen), so the window
 * is the desktop app's default size (apps/desktop/src-tauri/tauri.conf.json) and the engine is
 * fixed: a baseline and a run are only comparable in the same engine and size. Its own port, never
 * attaching to a dev server already up, so the numbers are always this checkout's.
 */
const port = Number(process.env.UX_PORT ?? '5196')
const engine = process.env.E2E_BROWSER === 'chromium' ? 'chromium' : 'webkit'

export default defineConfig({
  testDir: '.',
  testMatch: /\.task\.ts$/,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['./reporter.ts']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'off',
    browserName: engine,
    viewport: { width: 1280, height: 840 },
  },
  webServer: {
    command: `pnpm --filter @cc/web exec vite --host 127.0.0.1 --port ${port} --strictPort`,
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
})
