import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: '.',
  timeout: 20000,
  expect: { timeout: 5000 },
  fullyParallel: true,
  // 로컬에서 test.only를 남긴 채 밀어도 CI가 "전부 통과"로 속지 않게 막는다
  forbidOnly: !!process.env.CI,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:5174', trace: 'off' },
  webServer: {
    command: 'pnpm --filter @cc/web exec vite --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174',
    // 로컬에서는 떠 있는 dev 서버를 재사용하되, CI에서는 남의 서버에 붙으면
    // 무엇을 테스트했는지 알 수 없으므로 항상 새로 띄운다
    reuseExistingServer: !process.env.CI,
    timeout: 60000,
  },
})
