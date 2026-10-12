import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { agentFrame } from '../packages/agent-host/src/sessions/start-agent.js'

vi.mock('../e2e/browser-sandbox.js', async (load) => {
  const actual = await load<typeof import('../e2e/browser-sandbox.js')>()
  return { assertBrowserSandbox: (engine: string) => actual.assertBrowserSandbox(engine, 'darwin', process.env) }
})

afterEach(() => { vi.unstubAllEnvs(); vi.resetModules() })

describe('repository runner guidance stays out of Centralu children', () => {
  it('is in AGENTS.md and never in the generic child task frame', () => {
    expect(agentFrame('parent', 'task')).not.toContain('E2E_BROWSER')
    const instructions = readFileSync(new URL('../AGENTS.md', import.meta.url), 'utf8')
    expect(instructions).toContain('`pnpm e2e`, `pnpm ux` and `pnpm perf`')
    expect(instructions).toContain('`E2E_BROWSER=chromium` only; CI runs WebKit')
  })
})

describe('UX checks the sandbox when its config loads, without launching a browser', () => {
  it.each([undefined, 'webkit'])('refuses E2E_BROWSER=%s in seatbelt, including CI=1', async (engine) => {
    vi.stubEnv('CODEX_SANDBOX', 'seatbelt')
    vi.stubEnv('CI', '1')
    vi.stubEnv('E2E_BROWSER', engine)
    await expect(import('../e2e/ux/playwright.config.js')).rejects.toThrow('pnpm ux')
  })

  it('allows the explicit Chromium runner', async () => {
    vi.stubEnv('CODEX_SANDBOX', 'seatbelt')
    vi.stubEnv('E2E_BROWSER', 'chromium')
    vi.stubEnv('STYLE_SNAPSHOT_BROWSER', undefined)
    const { default: config } = await import('../e2e/ux/playwright.config.js')
    expect(config.use?.browserName).toBe('chromium')
  })
})

describe('perf respects the explicitly selected engine', () => {
  it.each(['idle', 'typing'])('%s declares Chromium when E2E_BROWSER=chromium', async (spec) => {
    const use = vi.fn()
    vi.doMock('@playwright/test', () => ({
      expect: {}, test: Object.assign(() => {}, { use, describe: { configure: () => {} }, beforeEach: () => {}, skip: () => {} }),
    }))
    vi.stubEnv('E2E_BROWSER', 'chromium')
    await import(`../e2e/perf-${spec}.spec.ts`)
    expect(use).toHaveBeenCalledWith({ browserName: 'chromium' })
    vi.doUnmock('@playwright/test')
  })
})
