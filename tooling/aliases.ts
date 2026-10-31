import { fileURLToPath } from 'node:url'

const REPO = new URL('../', import.meta.url)
const r = (p: string) => fileURLToPath(new URL(p, REPO))

/**
 * The `@cc/*` aliases of the Vite builds (`apps/web`, `apps/desktop`) and of vitest: one map, so a new package entry is
 * added once. A vite config runs in Node, so this file imports nothing from the repository.
 *
 * Aliases match **by prefix** — a longer one has to come before its shorter one, or `mock/demo` would resolve as
 * `mock/index.ts/demo`. `extra` is where an entry point adds its own, such as `apps/web`'s `mock/demo`: it is put in
 * front of the shared ones, so it is tried first. A key in both takes the shared path.
 */
export function aliases(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, r(v)])),
    '@cc/protocol/client': r('packages/protocol/src/client.ts'),
    '@cc/protocol': r('packages/protocol/src/index.ts'),
    '@cc/core': r('packages/core/src/index.ts'),
    '@cc/platform/ports': r('packages/platform/src/ports/index.ts'),
    '@cc/platform/web': r('packages/platform/src/web/index.ts'),
    '@cc/platform/mock': r('packages/platform/src/mock/index.ts'),
    '@cc/ui': r('packages/ui/src/index.ts'),
  }
}
