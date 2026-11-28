import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { DevTab } from '@cc/protocol/client'
import type { Platform } from '@cc/platform/ports'
import type { Load } from '../../app/useLoad.js'
import { PlatformProvider } from '../../app/PlatformProvider.jsx'

/*
 * The trusted dev browser tabs under Settings → Permissions (#2469). A static render runs no effect, so the read's
 * outcome is given through `useLoad`.
 */
let shown: Partial<Load<DevTab[]>> = {}
vi.mock('../../app/useLoad.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../app/useLoad.js')>()),
  useLoad: () => ({ data: undefined, error: null, loading: false, reload: async () => {}, ...shown }),
}))

const { DevTabsSection } = await import('./DevTabsSection.jsx')
const platform = { requests: {} } as unknown as Platform
const render = () =>
  renderToStaticMarkup(
    <PlatformProvider platform={platform}>
      <DevTabsSection />
    </PlatformProvider>,
  )

describe('the trusted browser tabs', () => {
  it('shows nothing while none is trusted', () => {
    shown = { data: [] }
    expect(render()).toBe('')
  })

  it('lists each with its take-back', () => {
    shown = { data: [{ id: 'ab12cd34', origin: 'http://127.0.0.1:5174', grantedAt: 1, expiresAt: 2 }] }
    const html = render()
    expect(html).toContain('http://127.0.0.1:5174')
    expect(html).toContain('data-testid="revoke-dev-tab-ab12cd34"')
  })

  it('says it could not read them instead of hiding the group (#841)', () => {
    shown = { error: 'RPC timed out' }
    expect(render()).toContain('data-testid="dev-tabs-failed"')
  })
})
