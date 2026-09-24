import { defineConfig } from '@playwright/test'

/**
 * 시작 화면 시험만 **자기 서버**에서 돈다.
 *
 * startup.spec.ts가 보는 것은 "토큰 없이 띄우면 무슨 일이 생기는가"인데, 그 토큰은
 * dev 서버가 뜰 때 박힌다. CONTRIBUTING이 시키는 대로 `VITE_HOST_TOKEN=... pnpm dev`를
 * 띄워 둔 사람은 5174에 **토큰이 있는** 서버를 갖고 있고, reuseExistingServer가 거기
 * 붙으면 시험은 자기가 무엇을 재는지 모르는 채 실패했다. 그래서 이 한 벌만 다른 포트에
 * 재사용 없이 새로 띄우고, 토큰은 명시적으로 비운다.
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
  // 로컬에서 test.only를 남긴 채 밀어도 CI가 "전부 통과"로 속지 않게 막는다
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
      // 로컬에서는 떠 있는 dev 서버를 재사용하되, CI에서는 남의 서버에 붙으면
      // 무엇을 테스트했는지 알 수 없으므로 항상 새로 띄운다
      reuseExistingServer: !process.env.CI,
      timeout: 60000,
    },
    {
      command: `pnpm --filter @cc/web exec vite --host 127.0.0.1 --port ${STARTUP_PORT} --strictPort`,
      url: STARTUP_URL,
      // 빈 값이면 bootstrap이 '없음'으로 판정한다 — 셸에 토큰을 export해 둔 사람도 같은 시험을 본다
      env: { VITE_HOST_TOKEN: '' },
      reuseExistingServer: false,
      timeout: 60000,
    },
  ],
})
