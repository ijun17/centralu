import { afterEach, describe, expect, it, vi } from 'vitest'
import { uxEngine } from '../e2e/ux/engine.js'

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); vi.resetModules() })

describe('the engine pnpm ux runs in (#2022)', () => {
  it.each([['darwin', 'webkit'], ['linux', 'webkit'], ['win32', 'chromium']] as const)(
    'defaults to the desktop app\'s on %s: %s',
    (platform, engine) => {
      expect(uxEngine({}, platform)).toBe(engine)
    },
  )

  it.each(['darwin', 'linux', 'win32'] as const)('takes the engine E2E_BROWSER names on %s', (platform) => {
    expect(uxEngine({ E2E_BROWSER: 'chromium' }, platform)).toBe('chromium')
    expect(uxEngine({ E2E_BROWSER: 'webkit' }, platform)).toBe('webkit')
  })

  it('puts the config in Chromium on Windows when nothing is named, where WebKit drops the drag types', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    vi.stubEnv('E2E_BROWSER', undefined)
    const { default: config } = await import('../e2e/ux/playwright.config.js')
    expect(config.use?.browserName).toBe('chromium')
  })
})
