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
     * **Tests do not write to the person's home directory.**
     *
     * Without this set, the orchestrator home and attachments folder would land under the
     * real `~/.centralu`. This actually happened: a single `pnpm verify` run created an empty
     * folder there, and that folder then blocked the data migration
     * (see `packages/agent-host/src/data-dir.ts`).
     */
    env: { CC_DATA_DIR: join(tmpdir(), 'centralu-test-data') },
    exclude: ['**/node_modules/**', 'spike/**', 'e2e/**'],
  },
})
