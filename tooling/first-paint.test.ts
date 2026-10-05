import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { THEME_PRESETS } from '../packages/ui/src/app/theme.js'

/**
 * The first-paint script in index.html (#340).
 *
 * Theme step 3 (#329) stopped forcing the desktop window to Dark so System mode could follow the OS,
 * and from then on WKWebView painted its own default, white under a light appearance, until the CSS
 * bundle loaded: the cached-theme bootstrap runs from main.tsx, after the bundle. The script runs
 * before any stylesheet or module and paints the last theme's floor. These check the parts of it
 * that a browser cannot: that the desktop CSP lets it run, that both pages carry the same one, and
 * that its floors are the stylesheet's. e2e/first-paint.spec.ts checks it in a page.
 */

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

function inlineScript(page: string): string {
  const scripts = [...read(page).matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!)
  expect(scripts, `${page} should carry exactly one inline script`).toHaveLength(1)
  return scripts[0]!
}

function scriptSrc(): string[] {
  const conf = JSON.parse(read('apps/desktop/src-tauri/tauri.conf.json')) as { app: { security: { csp: string } } }
  const directive = conf.app.security.csp
    .split(';')
    .map((d) => d.trim().split(/\s+/))
    .find(([name]) => name === 'script-src')
  return directive!.slice(1)
}

type Cache = { mode: string; dark: Record<string, unknown>; light: Record<string, unknown> } | string | null

/** Runs the script against a stand-in page and answers what it left on <html> */
function firstPaint(cache: Cache, systemDark = true): { backgroundColor?: string; colorScheme?: string } {
  const style: { backgroundColor?: string; colorScheme?: string } = {}
  runInNewContext(inlineScript('apps/desktop/index.html'), {
    localStorage: { getItem: (k: string) => (k === 'cc-theme' && cache !== null ? (typeof cache === 'string' ? cache : JSON.stringify(cache)) : null) },
    matchMedia: (q: string) => ({ matches: q === '(prefers-color-scheme: dark)' ? systemDark : false }),
    CSS: { supports: (_p: string, v: string) => /^#[0-9a-f]{3,8}$/i.test(v) },
    document: { documentElement: { style } },
  })
  return style
}

const side = (id: string, base: string, tokens: Record<string, string> = {}) => ({ id, name: id, base, preset: id, tokens, accent: null })
const choice = (mode: string, dark = side('dark', 'dark'), light = side('light', 'light')) => ({ mode, dark, light })

describe('the first paint (#340)', () => {
  it('is allowed by the desktop CSP: script-src is our own files plus this one inline script, by hash', () => {
    const hash = `'sha256-${createHash('sha256').update(inlineScript('apps/desktop/index.html')).digest('base64')}'`
    // A mismatch means the script changed: put this hash in tauri.conf.json's script-src
    expect(scriptSrc()).toEqual(["'self'", hash])
  })

  it('is the same script on the desktop and the web page', () => {
    expect(inlineScript('apps/web/index.html')).toBe(inlineScript('apps/desktop/index.html'))
  })

  it('knows every preset, with the floor the stylesheet gives it', () => {
    const css = read('packages/ui/src/styles/index.css')
    const floorIn = (block: RegExp) => new RegExp(`${block.source}[^}]*?--color-surface-floor:\\s*(#[0-9a-f]+)`, 'i').exec(css)?.[1]
    const fromCss: Record<string, string | undefined> = { dark: floorIn(/@theme\s*\{/) }
    for (const p of THEME_PRESETS.filter((p) => p.id !== 'dark')) fromCss[p.id] = floorIn(new RegExp(`\\[data-theme='${p.id}'\\]\\s*\\{`))
    const floors = /var floors = (\{[^}]*\})/.exec(inlineScript('apps/desktop/index.html'))![1]!
    expect(runInNewContext(`(${floors})`)).toEqual(fromCss)
  })

  it('paints the dark floor when nothing is cached, or the cache is unreadable', () => {
    expect(firstPaint(null)).toEqual({ backgroundColor: '#141414', colorScheme: 'dark' })
    expect(firstPaint('{not json')).toEqual({ backgroundColor: '#141414', colorScheme: 'dark' })
    // Nothing cached is the stylesheet's Dark even on a light OS: no theme has been chosen yet
    expect(firstPaint(null, false)).toEqual({ backgroundColor: '#141414', colorScheme: 'dark' })
  })

  it('paints the light floor for a cached light theme', () => {
    expect(firstPaint(choice('light'))).toEqual({ backgroundColor: '#e8e8e8', colorScheme: 'light' })
  })

  it('in System mode, picks the side the OS shows, as applyCachedTheme does', () => {
    expect(firstPaint(choice('system'), false)).toEqual({ backgroundColor: '#e8e8e8', colorScheme: 'light' })
    expect(firstPaint(choice('system'), true)).toEqual({ backgroundColor: '#141414', colorScheme: 'dark' })
  })

  it("paints a high-contrast preset's floor and a custom theme's own floor", () => {
    expect(firstPaint(choice('dark', side('hc-dark', 'dark')))).toEqual({ backgroundColor: '#000000', colorScheme: 'dark' })
    const custom = { ...side('mine', 'light', { '--color-surface-floor': '#fdf6e3' }), preset: 'light' }
    expect(firstPaint(choice('light', undefined, custom))).toEqual({ backgroundColor: '#fdf6e3', colorScheme: 'light' })
    // A value the browser cannot use falls back to the preset's floor
    const broken = { ...side('mine', 'light', { '--color-surface-floor': 'url(x)' }), preset: 'light' }
    expect(firstPaint(choice('light', undefined, broken))).toEqual({ backgroundColor: '#e8e8e8', colorScheme: 'light' })
  })
})
