import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_UI_PREFERENCES, agentDepthOf } from '@cc/protocol'
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
  if (stored !== undefined) store.settings.setAppSetting(KEY, stored)
  const mgr = new SessionManager(store, new Map(), () => {})
  const row = () => JSON.parse(store.settings.appSetting(KEY) ?? 'null') as Record<string, unknown>
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

  it('the agent depth survives a restart; a record from before it, or with a value out of range, reads as 1 (#867)', () => {
    const store = new Store()
    store.settings.setAppSetting(KEY, JSON.stringify({ sendWithModifierEnter: true }))
    expect(agentDepthOf(new SessionManager(store, new Map(), () => {}).uiPreferences())).toBe(1)
    new SessionManager(store, new Map(), () => {}).setUiPreferences({ agentDepth: 3 })
    // A new manager over the same database: what a restarted host reads
    expect(new SessionManager(store, new Map(), () => {}).uiPreferences()).toMatchObject({ agentDepth: 3, sendWithModifierEnter: true })
    for (const bad of [0, 4, 2.5, '2', null]) {
      store.settings.setAppSetting(KEY, JSON.stringify({ agentDepth: bad }))
      expect(agentDepthOf(new SessionManager(store, new Map(), () => {}).uiPreferences())).toBe(1)
    }
  })

  it('a broken row reads as the defaults, says so once with the row name, and the next change replaces it', () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { mgr, row } = setup('{"textSize": 1.1, ')
    // "Allow auto from a linked computer" alone reads as off from a damaged record (#1273 review), and is written so
    expect(mgr.uiPreferences()).toEqual({ ...DEFAULT_UI_PREFERENCES, hubAuto: false })
    mgr.uiPreferences()
    expect(said.mock.calls.filter(([line]) => String(line).includes(`app_settings.${KEY}`))).toHaveLength(1)
    mgr.setUiPreferences({ sessionTools: false })
    expect(row()).toEqual({ sessionTools: false, hubAuto: false })
  })

  // #1273 review: an unrelated change over a damaged record dropped the switch, and absent reads as on
  it('keeps a damaged "Allow auto from a linked computer" off when another setting is saved over it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken = setup('{"hubAuto": false, "textSize": 1.1, ')
    expect(broken.mgr.setUiPreferences({ textSize: 1 }).hubAuto).toBe(false)
    expect(broken.row()).toMatchObject({ hubAuto: false })
    expect(broken.mgr.uiPreferences().hubAuto).toBe(false)
    const odd = setup(JSON.stringify({ hubAuto: 'no' }))
    odd.mgr.setUiPreferences({ textSize: 1 })
    expect(odd.row()).toMatchObject({ hubAuto: false })
    // The person's own choice over a damaged record is what is written
    const chosen = setup('{"textSize": 1.1, ')
    chosen.mgr.setUiPreferences({ hubAuto: true })
    expect(chosen.mgr.uiPreferences().hubAuto).toBe(true)
  })

  /*
   * Reading is not a change (#384): the text size moves out of an old workspace snapshot once, on the first read that
   * finds no `textSize` in the record. A broken row has no field either, so that read wrote `{ textSize }` over it,
   * before the person had changed anything, and the next build to read it found every other choice gone.
   */
  it('a broken row is not written over by reading it, even with an old text size to move', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = new Store()
    store.settings.saveWorkspace({ textScale: 3 })
    store.settings.setAppSetting(KEY, '{"textSize": 1.1, ')
    const mgr = new SessionManager(store, new Map(), () => {})
    expect(mgr.uiPreferences()).toEqual({ ...DEFAULT_UI_PREFERENCES, hubAuto: false })
    expect(store.settings.appSetting(KEY)).toBe('{"textSize": 1.1, ')
  })
})
