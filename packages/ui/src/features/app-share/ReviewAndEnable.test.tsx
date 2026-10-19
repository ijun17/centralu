import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ExternalAppInfo } from '@cc/protocol'
import type { Platform } from '@cc/platform/ports'
import { PlatformProvider } from '../../app/PlatformProvider.jsx'
import type { ExternalCatalogApp } from '../../store/app-catalog.js'
import { ReviewAndEnable } from './ReviewAndEnable.jsx'

/*
 * The review in an app's pinned slot. An app held because the record of imports could not be read (#1172) has no
 * import mark: it may be the person's own, so it must not say it was imported, and the host's reason says why it asks.
 */
const platform = { apps: { review: () => new Promise(() => {}) } } as unknown as Platform
function app(info: Partial<ExternalAppInfo>): ExternalCatalogApp {
  return {
    kind: 'external',
    key: '_user/mine',
    appId: 'mine',
    projectId: null,
    title: 'Mine',
    info: { appId: 'mine', projectId: null, status: 'unconfirmed', error: null, ...info } as ExternalAppInfo,
    status: { kind: 'idle' } as unknown as ExternalCatalogApp['status'],
  }
}
const render = (a: ExternalCatalogApp) =>
  renderToStaticMarkup(
    <PlatformProvider platform={platform}>
      <ReviewAndEnable app={a} />
    </PlatformProvider>,
  )

describe('the review of an app waiting to be enabled', () => {
  it('says the app was imported only when it carries an import mark; without one it shows the reason naming the file', () => {
    const marked = render(app({ imported: { source: '/src/mine', at: 1, confirmedAt: null }, error: 'This app was imported and is not enabled yet' }))
    expect(marked).toContain('This app was imported. Review it before it runs.')
    expect(marked).not.toContain('pinned-review-reason')

    const reason = 'Centralu could not read /data/app-imports.json and moved it to /data/app-imports.json.unreadable-1, so it cannot tell whether this app was imported'
    const held = render(app({ error: reason }))
    expect(held).not.toContain('This app was imported')
    expect(held).toContain('Review this app before it runs.')
    expect(held).toContain('data-testid="pinned-review-reason"')
    expect(held).toContain('/data/app-imports.json.unreadable-1')
  })
})
