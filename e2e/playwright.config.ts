import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  timeout: 20000,
  expect: { timeout: 5000 },
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5174', trace: 'off' },
  webServer: {
    command: 'pnpm --filter @cc/web exec vite --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: true,
    timeout: 60000,
  },
})
