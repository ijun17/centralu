import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The WebKit twins in e2e/ (`<name>-webkit.spec.ts`).
 *
 * A twin runs its base spec's scenarios again in WebKit. CI runs the whole suite once per engine
 * (`E2E_BROWSER=webkit` and `=chromium`, e2e/playwright.config.ts), and both runs leave every twin
 * out: its base spec already runs in each engine. That is only safe while a twin adds nothing: a test that lived
 * only in a twin would run in no CI job at all. So a twin holds its base spec's lines and nothing
 * else, apart from its imports, its comments and the `test.use` that picks WebKit. A scenario that
 * only means something in WebKit goes in the shared fixture and skips itself elsewhere
 * (`liveTransparencyTest` in e2e/fixtures/app-theme.ts).
 */

const e2e = new URL('../e2e/', import.meta.url)
const WEBKIT_USE = "test.use({ browserName: 'webkit' })"

/** The statements of a spec, one per line, without comments, imports and blank lines */
function statements(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*import\s[\s\S]*?\sfrom\s+['"][^'"]+['"];?\s*$/gm, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line.length > 0)
}

const twins = readdirSync(e2e).filter((name) => name.endsWith('-webkit.spec.ts'))

describe('e2e WebKit twins repeat their base spec and add nothing', () => {
  it('there are twins to check', () => {
    expect(twins.length).toBeGreaterThan(0)
  })

  for (const twin of twins) {
    it(twin, () => {
      const base = twin.replace(/-webkit\.spec\.ts$/, '.spec.ts')
      expect(existsSync(new URL(base, e2e)), `${twin} has no base spec ${base}`).toBe(true)
      const own = statements(readFileSync(new URL(twin, e2e), 'utf8'))
      expect(own, `${twin} should pick WebKit with ${WEBKIT_USE}`).toContain(WEBKIT_USE)
      const inBase = new Set(statements(readFileSync(new URL(base, e2e), 'utf8')))
      const extra = own.filter((line) => line !== WEBKIT_USE && !inBase.has(line))
      expect(extra, `${twin} runs something ${base} does not, which no CI job would run`).toEqual([])
    })
  }
})
