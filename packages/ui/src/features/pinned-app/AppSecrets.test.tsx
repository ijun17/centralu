import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ExternalAppInfo } from '@cc/protocol'
import type { Platform } from '@cc/platform/ports'
import { PlatformProvider } from '../../app/PlatformProvider.jsx'
import type { ExternalCatalogApp } from '../../store/app-catalog.js'
import { AppSecrets } from './AppSecrets.jsx'

/*
 * An app's Secrets section when the saved secrets could not be read (#944): before, every value just showed missing,
 * which read as values never entered.
 */
const platform = {} as unknown as Platform
function app(info: Partial<ExternalAppInfo>): ExternalCatalogApp {
  return {
    kind: 'external',
    key: 'p1/keys',
    appId: 'keys',
    projectId: 'p1',
    title: 'Keys',
    info: { appId: 'keys', projectId: 'p1', secrets: [{ name: 'API_KEY', set: false }], ...info } as ExternalAppInfo,
    status: { kind: 'idle' } as unknown as ExternalCatalogApp['status'],
  }
}
const render = (a: ExternalCatalogApp) =>
  renderToStaticMarkup(
    <PlatformProvider platform={platform}>
      <AppSecrets app={a} />
    </PlatformProvider>,
  )

describe('the Secrets section when the saved secrets could not be read (#944)', () => {
  it('says nothing more while the file reads', () => {
    expect(render(app({}))).not.toContain('secrets-unreadable')
  })

  it('names the copy the file was moved to, and saving stays open', () => {
    const html = render(app({ secretsUnreadable: { movedTo: 'app-secrets.json.unreadable-1700000000000', at: 1 } }))
    expect(html).toContain('data-testid="secrets-unreadable"')
    expect(html).toContain('were moved to <span class="font-mono">app-secrets.json.unreadable-1700000000000</span>')
    expect(html).not.toMatch(/data-testid="secret-save"[^>]*title=/)
  })

  it('says why the file could not be read, moved aside or still in place, on the line and on the Save button', () => {
    const moved = render(app({ secretsUnreadable: { movedTo: 'app-secrets.json.unreadable-1', at: 1, reason: 'it is not valid JSON' } }))
    expect(moved).toContain('The saved secrets could not be read (it is not valid JSON) and were moved to')
    const stuck = render(app({ secretsUnreadable: { movedTo: null, at: 1, reason: 'Centralu may not read it (EACCES)' } }))
    expect(stuck).toContain('cannot be read: Centralu may not read it (EACCES). Nothing can be saved until it is fixed or removed')
    expect(stuck).toMatch(/title="The saved secrets file cannot be read \(Centralu may not read it \(EACCES\)\), so nothing is saved until it is fixed or removed"[^>]*data-testid="secret-save"/)
  })

  it('says a file still in place blocks saving, and the Save button says why', () => {
    const html = render(app({ secretsUnreadable: { movedTo: null, at: 1 } }))
    expect(html).toContain('Nothing can be saved until it is fixed or removed')
    expect(html).toMatch(/disabled=""[^>]*title="The saved secrets file cannot be read, so nothing is saved until it is fixed or removed"[^>]*data-testid="secret-save"/)
  })
})
