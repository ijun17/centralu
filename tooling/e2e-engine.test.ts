import { afterEach, describe, expect, it, vi } from 'vitest'
import { e2eEngine } from '../e2e/engine.js'

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules() })

describe('the engine pnpm e2e runs in (#2022)', () => {
  it.each([['darwin', undefined], ['linux', undefined], ['win32', 'chromium']] as const)(
    'with nothing named, on %s: %s (undefined is the mixed run)',
    (platform, engine) => {
      expect(e2eEngine({}, platform)).toBe(engine)
    },
  )

  it.each(['darwin', 'linux', 'win32'] as const)('takes the engine E2E_BROWSER names on %s', (platform) => {
    expect(e2eEngine({ E2E_BROWSER: 'chromium' }, platform)).toBe('chromium')
    expect(e2eEngine({ E2E_BROWSER: 'webkit' }, platform)).toBe('webkit')
  })

  it('the Windows config runs Chromium alone, with every WebKit twin left out', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('E2E_BROWSER', undefined)
    const { default: config } = await import('../e2e/playwright.config.js')
    expect(config.use?.browserName).toBe('chromium')
    expect(config.metadata?.e2eBrowser).toBe('chromium')
    const app = config.projects?.find((p) => p.name === 'app')
    expect(app?.testIgnore).toEqual(expect.arrayContaining([/-webkit\.spec\.ts/]))
  })
})
