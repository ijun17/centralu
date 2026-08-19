import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@cc/protocol': r('./packages/protocol/src/index.ts'),
      '@cc/core': r('./packages/core/src/index.ts'),
      '@cc/platform/ports': r('./packages/platform/src/ports/index.ts'),
      '@cc/platform/web': r('./packages/platform/src/web/index.ts'),
      '@cc/platform/mock': r('./packages/platform/src/mock/index.ts'),
      '@cc/ui': r('./packages/ui/src/index.ts'),
    },
  },
  test: {
    include: ['packages/**/*.test.{ts,tsx}', 'tooling/**/*.test.ts'],
    /*
     * **테스트는 사용자의 홈에 쓰지 않는다.**
     *
     * 이걸 안 걸어두면 오케스트레이터 홈·첨부 폴더가 진짜 `~/.centralu` 아래에 생긴다.
     * 실제로 `pnpm verify` 한 번에 빈 폴더가 생겼고, 그 폴더가 데이터 이사를 막았다
     * (`packages/agent-host/src/data-dir.ts` 참조).
     */
    env: { CC_DATA_DIR: join(tmpdir(), 'centralu-test-data') },
    exclude: ['**/node_modules/**', 'spike/**', 'e2e/**'],
  },
})
