import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FullConfig } from '@playwright/test'
import { assertBrowserSandbox } from '../e2e/browser-sandbox.js'
import warmEngine from '../e2e/warm-engine.js'
import config from '../e2e/playwright.config.js'

const root = fileURLToPath(new URL('..', import.meta.url))
const message = 'WebKit cannot run in this sandbox; run E2E_BROWSER=chromium with pnpm e2e, pnpm ux or pnpm perf; CI runs WebKit'
const sandbox = { platform: 'darwin' as const, env: { CODEX_SANDBOX: 'seatbelt', CI: '1' } }

describe('WebKit in the macOS Codex sandbox (#592)', () => {
  it.each(['webkit', 'mixed'])('refuses %s even with CI=1, before either browser can launch', async (engine) => {
    const launch = vi.fn()
    const engines = { chromium: { launch }, webkit: { launch } } as never
    const full = {
      projects: [{ use: { browserName: engine === 'webkit' ? 'webkit' : 'chromium' } }],
      metadata: { e2eBrowser: engine },
    } as unknown as FullConfig
    await expect(warmEngine(full, engines, sandbox)).rejects.toThrow(message)
    expect(launch).not.toHaveBeenCalled()
  })

  it('the runner declares mixed mode when E2E_BROWSER is unset, so twins cannot bypass the guard', () => {
    expect(config.metadata?.e2eBrowser).toBe(process.env.E2E_BROWSER ?? 'mixed')
  })

  it('catches a project that selects WebKit despite Chromium metadata', async () => {
    const launch = vi.fn()
    const full = { projects: [{ use: { browserName: 'webkit' } }], metadata: { e2eBrowser: 'chromium' } } as unknown as FullConfig
    await expect(warmEngine(full, { chromium: { launch }, webkit: { launch } } as never, sandbox)).rejects.toThrow(message)
    expect(launch).not.toHaveBeenCalled()
  })

  it('catches the style snapshot override even in a Chromium run', () => {
    expect(() => assertBrowserSandbox('chromium', 'darwin', { ...sandbox.env, STYLE_SNAPSHOT_BROWSER: 'webkit' })).toThrow('unset STYLE_SNAPSHOT_BROWSER=webkit')
  })

  it.each(['darwin', 'linux', 'win32'] as const)('allows Chromium on %s with or without a sandbox', (platform) => {
    for (const env of [{}, sandbox.env]) expect(() => assertBrowserSandbox('chromium', platform, env)).not.toThrow()
  })

  it.each(['webkit', 'mixed'])('allows %s on macOS outside seatbelt, and on Linux and Windows including CI', (engine) => {
    for (const env of [{}, { CI: '1' }, { CODEX_SANDBOX: 'other', CI: '1' }]) {
      expect(() => assertBrowserSandbox(engine, 'darwin', env)).not.toThrow()
    }
    for (const platform of ['linux', 'win32'] as const) {
      expect(() => assertBrowserSandbox(engine, platform, sandbox.env)).not.toThrow()
    }
  })
})

describe('the Playwright configs of their own (#592)', () => {
  const platform = process.platform
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform })
    vi.unstubAllEnvs()
    vi.resetModules()
  })

  it('the style snapshot config refuses STYLE_SNAPSHOT_BROWSER=webkit in the sandbox as it loads, before its server starts', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    vi.stubEnv('CODEX_SANDBOX', 'seatbelt')
    vi.stubEnv('STYLE_SNAPSHOT_BROWSER', 'webkit')
    vi.resetModules()
    await expect(import('../e2e/style-snapshot.config.js')).rejects.toThrow('unset STYLE_SNAPSHOT_BROWSER=webkit')
  })

  it('the style snapshot and security diff configs load in Chromium in the sandbox', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    vi.stubEnv('CODEX_SANDBOX', 'seatbelt')
    vi.stubEnv('STYLE_SNAPSHOT_BROWSER', '')
    vi.resetModules()
    await expect(import('../e2e/style-snapshot.config.js')).resolves.toBeDefined()
    await expect(import('../e2e/security-diff.config.js')).resolves.toBeDefined()
  })

  // A new config of its own (as style-snapshot and security-diff were) checks the sandbox too, at load or in its warm-up
  it('every Playwright config under e2e checks the sandbox before it starts anything', () => {
    const configs = execFileSync('git', ['ls-files', 'e2e/*.config.ts', 'e2e/**/*.config.ts'], { cwd: root, encoding: 'utf8' }).trim().split('\n')
    expect(configs).toEqual(expect.arrayContaining(['e2e/playwright.config.ts', 'e2e/security-diff.config.ts', 'e2e/style-snapshot.config.ts', 'e2e/ux/playwright.config.ts']))
    const unchecked = configs.filter((f) => !/assertBrowserSandbox\(|globalSetup: '\.\/warm-engine\.ts'/.test(readFileSync(join(root, f), 'utf8')))
    expect(unchecked).toEqual([])
  })
})
