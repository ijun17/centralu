import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { build, type Rollup } from 'vite'

/**
 * What the window loads before its first frame (#364).
 *
 * The startup bundle was one 1.38 MB chunk with every screen in it, all fetched and parsed before
 * the first frame (docs/spikes/2026-10-memory-heavy-store.md §10.3). The screens below load on
 * first use instead (packages/ui/src/components/lazy.tsx). A static
 * import of any of them from a module on the startup path pulls it back in without a sound, so
 * this builds each entry and walks the chunks the entry imports statically.
 */

/** Modules no startup chunk may hold, each with the reason it can wait */
const LATER: [RegExp, string][] = [
  [/node_modules\/.*@xterm\//, 'xterm: only the terminal tab and the run-command window draw one'],
  [/features\/evidence\/Terminal\.tsx$/, 'the terminal tab'],
  [/features\/session\/CommandRunner\.tsx$/, 'the run-command window'],
  [/features\/settings\/Settings\.tsx$/, 'Settings'],
  [/features\/viewer\/CodeViewer\.tsx$/, 'the file viewer overlay'],
  [/features\/git\/GitPanel\.tsx$/, 'the diff overlay'],
]

const ENTRIES = {
  desktop: 'apps/desktop/vite.config.ts',
  web: 'apps/web/vite.config.ts',
}

async function chunks(config: string): Promise<Rollup.OutputChunk[]> {
  const out = (await build({
    configFile: fileURLToPath(new URL(`../${config}`, import.meta.url)),
    logLevel: 'silent',
    build: { write: false, sourcemap: false, minify: false, reportCompressedSize: false },
  })) as Rollup.RollupOutput | Rollup.RollupOutput[]
  return (Array.isArray(out) ? out : [out]).flatMap((o) =>
    o.output.filter((c): c is Rollup.OutputChunk => c.type === 'chunk'),
  )
}

/** The entry chunk and every chunk it reaches by static import: what loads before the first frame */
function startup(all: Rollup.OutputChunk[]): Rollup.OutputChunk[] {
  const byName = new Map(all.map((c) => [c.fileName, c] as const))
  const seen = new Set<string>()
  const walk = (name: string) => {
    if (seen.has(name)) return
    seen.add(name)
    for (const next of byName.get(name)?.imports ?? []) walk(next)
  }
  for (const c of all) if (c.isEntry && c.facadeModuleId?.endsWith('.html')) walk(c.fileName)
  return [...seen].map((n) => byName.get(n)!).filter(Boolean)
}

describe.each(Object.entries(ENTRIES))('the %s startup bundle', (_, config) => {
  it('leaves out the screens that are never on the first frame, and still builds them', async () => {
    const all = await chunks(config)
    const first = startup(all)
    expect(first.length, 'the entry chunk was not found').toBeGreaterThan(0)
    const atStartup = first.flatMap((c) => c.moduleIds)
    const anywhere = all.flatMap((c) => c.moduleIds)
    for (const [pattern, what] of LATER) {
      expect.soft(
        atStartup.filter((id) => pattern.test(id)),
        `${what} is in the startup bundle; load it with lazyComponent or a dynamic import`,
      ).toEqual([])
      // Not vacuous: the module is still built, into a chunk of its own
      expect.soft(anywhere.some((id) => pattern.test(id)), `${what} is not in the build at all`).toBe(true)
    }
  }, 60_000)
})
