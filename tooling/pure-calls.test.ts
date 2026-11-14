import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { build, type Rollup } from 'vite'
import { SLOW } from './test-timing.js'

/**
 * What ships holds no `console.debug` (tooling/pure-calls.ts): ext-apps' transport logs every app message with it, and
 * the console keeps the messages it logged, whole tool results included.
 */

const at = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url))

describe('console.debug is left out of what ships', () => {
  it("the app runtime's view script", () => {
    const view = readFileSync(at('packages/agent-host/app-template/runtime/mcp-app.js'), 'utf8')
    // Not vacuous: the transport is in it
    expect(view).toContain('postMessage')
    expect(view).not.toMatch(/console\.debug\(/)
  })

  it('the window bundle', async () => {
    const out = (await build({
      configFile: at('apps/desktop/vite.config.ts'),
      logLevel: 'silent',
      // Minified, as it ships: a comment that names console.debug is not a call
      build: { write: false, sourcemap: false, reportCompressedSize: false },
    })) as Rollup.RollupOutput | Rollup.RollupOutput[]
    const chunks = (Array.isArray(out) ? out : [out]).flatMap((o) =>
      o.output.filter((c): c is Rollup.OutputChunk => c.type === 'chunk'),
    )
    // Not vacuous: the app bridge, whose transport logs, is built
    expect(chunks.some((c) => c.moduleIds.some((id) => /ext-apps[/\\]dist[/\\]src[/\\]app-bridge\.js$/.test(id)))).toBe(true)
    const left = chunks.flatMap((c) => {
      const i = c.code.search(/console\.debug\(/)
      return i < 0 ? [] : [`${c.fileName}: …${c.code.slice(Math.max(0, i - 200), i + 100)}…`]
    })
    expect(left).toEqual([])
  }, 60_000 * SLOW)
})
