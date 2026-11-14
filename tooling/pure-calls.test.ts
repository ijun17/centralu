import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { build, type Rollup } from 'vite'
import { PURE_CALLS } from './pure-calls.mjs'
import { SLOW } from './test-timing.js'

/**
 * What ships holds none of the calls in tooling/pure-calls.mjs: ext-apps' transport logs every app message with
 * `console.debug`, and the console keeps the messages it logged, whole tool results included.
 */

const at = (p: string) => fileURLToPath(new URL(`../${p}`, import.meta.url))
/**
 * A call of one of them, also as `?.(` or `(0,…)(`. A reference is not one: the `debug` package keeps
 * `console.debug || console.log` to log through when someone turns it on.
 */
const calls = new RegExp(PURE_CALLS.map((c) => `${c.replace(/\./g, '\\.')}\\)?\\s*(\\?\\.)?\\(`).join('|'))

describe(`${PURE_CALLS.join(', ')} is left out of what ships`, () => {
  it("the app runtime's view script", () => {
    const view = readFileSync(at('packages/agent-host/app-template/runtime/mcp-app.js'), 'utf8')
    // Not vacuous: the transport is in it (its own error text, which stays)
    expect(view).toContain('Failed to parse message')
    expect(view).not.toMatch(calls)
  })

  it('the window bundle', async () => {
    const out = (await build({
      configFile: at('apps/desktop/vite.config.ts'),
      logLevel: 'silent',
      // Minified, as it ships: a comment that names a call is not one
      build: { write: false, sourcemap: false, reportCompressedSize: false },
    })) as Rollup.RollupOutput | Rollup.RollupOutput[]
    const chunks = (Array.isArray(out) ? out : [out]).flatMap((o) =>
      o.output.filter((c): c is Rollup.OutputChunk => c.type === 'chunk'),
    )
    // Not vacuous: the app bridge, whose transport logs, is built
    expect(chunks.some((c) => c.moduleIds.some((id) => /ext-apps[/\\]dist[/\\]src[/\\]app-bridge\.js$/.test(id)))).toBe(true)
    const left = chunks.flatMap((c) => {
      const i = c.code.search(calls)
      return i < 0 ? [] : [`${c.fileName}: …${c.code.slice(Math.max(0, i - 200), i + 100)}…`]
    })
    expect(left).toEqual([])
  }, 60_000 * SLOW)
})
