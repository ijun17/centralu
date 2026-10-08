import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_UI_PREFERENCES } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'

/*
 * The screen preferences row is read and written by more than one build: an older host during a
 * swap, an older release after a person goes back (#384). Each test writes the row as another
 * build would have, then goes through this build's reader and writer.
 */
const KEY = 'ui_preferences'

function setup(stored?: string) {
  const store = new Store()
  if (stored !== undefined) store.setAppSetting(KEY, stored)
  const mgr = new SessionManager(store, new Map(), () => {})
  const row = () => JSON.parse(store.appSetting(KEY) ?? 'null') as Record<string, unknown>
  return { mgr, row }
}

afterEach(() => vi.restoreAllMocks())

describe('screen preferences across builds', () => {
  it('an older record (fields missing) reads with the defaults for what it lacks', () => {
    const { mgr } = setup(JSON.stringify({ sendWithModifierEnter: true }))
    expect(mgr.uiPreferences()).toEqual({ ...DEFAULT_UI_PREFERENCES, sendWithModifierEnter: true })
  })

  it('a newer record keeps what this build does not know through a change made here', () => {
    const { mgr, row } = setup(JSON.stringify({ textSize: 1, themeMode: 'sepia-of-the-future', laterField: { a: 1 } }))
    // This build cannot read the theme mode, so it shows its default
    expect(mgr.uiPreferences().themeMode).toBe(DEFAULT_UI_PREFERENCES.themeMode)
    const out = mgr.setUiPreferences({ sendWithModifierEnter: true })
    expect(out.sendWithModifierEnter).toBe(true)
    // ...but writing a different field leaves the newer build's choices where they were
    expect(row()).toEqual({ textSize: 1, themeMode: 'sepia-of-the-future', laterField: { a: 1 }, sendWithModifierEnter: true })
  })

  it('a broken row reads as the defaults, says so once with the row name, and the next change replaces it', () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { mgr, row } = setup('{"textSize": 1.1, ')
    expect(mgr.uiPreferences()).toEqual(DEFAULT_UI_PREFERENCES)
    mgr.uiPreferences()
    expect(said.mock.calls.filter(([line]) => String(line).includes(`app_settings.${KEY}`))).toHaveLength(1)
    mgr.setUiPreferences({ sessionTools: false })
    expect(row()).toEqual({ sessionTools: false })
  })
})
