import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_NOTIFY_POLICY, DEFAULT_UI_PREFERENCES, agentDepthOf, nudgeShares, type UiPreferencesPatch } from '@cc/protocol'
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
  const events: string[] = []
  const mgr = new SessionManager(store, new Map(), (e) => events.push(e.type))
  const row = () => JSON.parse(store.settings.appSetting(KEY) ?? 'null') as Record<string, unknown>
  return { mgr, row, events, store }
}

afterEach(() => vi.restoreAllMocks())

describe('screen preferences across builds', () => {
  it('an older record (fields missing) reads with the defaults for what it lacks', () => {
    const { mgr } = setup(JSON.stringify({ sendWithModifierEnter: true }))
    // The notification switches are carried into the record on the first read (#1306): from the defaults, with no snapshot
    expect(mgr.uiPreferences()).toEqual({ ...DEFAULT_UI_PREFERENCES, sendWithModifierEnter: true, notifyPolicy: DEFAULT_NOTIFY_POLICY })
  })

  it('a newer record keeps what this build does not know through a change made here', () => {
    const { mgr, row } = setup(JSON.stringify({ textSize: 1, themeMode: 'sepia-of-the-future', laterField: { a: 1 } }))
    // This build cannot read the theme mode, so it shows its default
    expect(mgr.uiPreferences().themeMode).toBe(DEFAULT_UI_PREFERENCES.themeMode)
    const out = mgr.setUiPreferences({ sendWithModifierEnter: true })
    expect(out.sendWithModifierEnter).toBe(true)
    // ...but writing a different field leaves the newer build's choices where they were
    expect(row()).toEqual({ textSize: 1, themeMode: 'sepia-of-the-future', laterField: { a: 1 }, sendWithModifierEnter: true, notifyPolicy: DEFAULT_NOTIFY_POLICY })
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

  it("the auto-compact setting (#1376) reads as on at 60% for an older record, merges field by field, and an older build's write keeps it", () => {
    const { mgr, row } = setup(JSON.stringify({ textSize: 1 }))
    // Not in the record until chosen: an older record reads as the default through autoCompactOf, and nothing is written for it
    expect(mgr.uiPreferences().autoCompact).toBeUndefined()
    expect(mgr.setUiPreferences({ autoCompact: { share: 0.5 } }).autoCompact).toEqual({ controlled: true, share: 0.5, idleShare: 0.3, nudge: true, nudgeFirst: 0.3, nudgeSecond: null })
    // One field at a time: the share stays when the control is turned off
    expect(mgr.setUiPreferences({ autoCompact: { controlled: false } }).autoCompact).toEqual({ controlled: false, share: 0.5, idleShare: 0.3, nudge: true, nudgeFirst: 0.3, nudgeSecond: null })
    // The record keeps the two fields every build knows; the resting share is beside it, not inside (#1451)
    expect(row().autoCompact).toEqual({ controlled: false, share: 0.5 })
    expect(row().autoCompactIdleShare).toBeUndefined()
    // An older build writing another field keeps what it does not know (#384)
    mgr.setUiPreferences({ sendWithModifierEnter: true })
    expect(row().autoCompact).toEqual({ controlled: false, share: 0.5 })
  })

  it('the resting share (#1451) is stored beside the auto-compact record, so an older build saving autoCompact cannot erase it', () => {
    const { mgr, store, row } = setup(JSON.stringify({ textSize: 1 }))
    expect(mgr.setUiPreferences({ autoCompact: { idleShare: 0.45, nudge: true, nudgeFirst: 0.3, nudgeSecond: null } }).autoCompact).toEqual({ controlled: true, share: 0.6, idleShare: 0.45, nudge: true, nudgeFirst: 0.3, nudgeSecond: null })
    expect(row().autoCompactIdleShare).toBe(0.45)
    expect(row().autoCompact).toBeUndefined()
    expect(mgr.uiPreferences().autoCompact).toEqual({ controlled: true, share: 0.6, idleShare: 0.45, nudge: true, nudgeFirst: 0.3, nudgeSecond: null })
    // The previous build's save: its merge knows two fields and writes the record back over what it did not read
    const older = { ...row(), autoCompact: { controlled: true, share: 0.7 } }
    store.settings.setAppSetting(KEY, JSON.stringify(older))
    expect(mgr.uiPreferences().autoCompact).toEqual({ controlled: true, share: 0.7, idleShare: 0.45, nudge: true, nudgeFirst: 0.3, nudgeSecond: null })
    // And this build writing the other fields leaves it
    mgr.setUiPreferences({ autoCompact: { share: 0.5 } })
    expect(row().autoCompactIdleShare).toBe(0.45)
  })

  it('the notices’ settings (#1492) are stored beside the record too, and an older build’s save of autoCompact cannot erase them', () => {
    const { mgr, store, row } = setup(JSON.stringify({ textSize: 1 }))
    const set = mgr.setUiPreferences({ autoCompact: { nudge: false, nudgeFirst: 0.4, nudgeSecond: 0.5 } }).autoCompact
    expect(set).toEqual({ controlled: true, share: 0.6, idleShare: 0.3, nudge: false, nudgeFirst: 0.4, nudgeSecond: 0.5 })
    // Nothing of them inside the record an older build rewrites; each has its own field of the row
    expect(row().autoCompact).toBeUndefined()
    expect(row()).toMatchObject({ autoCompactNudge: false, autoCompactNudgeFirst: 0.4, autoCompactNudgeSecond: 0.5 })
    // The previous build's save: autoCompact written back as the two fields it knows, over the row it read
    store.settings.setAppSetting(KEY, JSON.stringify({ ...row(), autoCompact: { controlled: true, share: 0.7 } }))
    expect(mgr.uiPreferences().autoCompact).toEqual({ controlled: true, share: 0.7, idleShare: 0.3, nudge: false, nudgeFirst: 0.4, nudgeSecond: 0.5 })
    // Back to the default second share: null is stored, and it follows the share again
    expect(mgr.setUiPreferences({ autoCompact: { nudgeSecond: null } }).autoCompact).toMatchObject({ share: 0.7, nudgeSecond: null })
    expect(mgr.uiPreferences().autoCompact).toMatchObject({ nudgeSecond: null })
    expect(row().autoCompactNudgeFirst).toBe(0.4)
  })

  it('refuses a second share at or above the share agents compact at, judging a patch that moves both on the new share (#1492)', () => {
    const { mgr } = setup(JSON.stringify({ textSize: 1 }))
    // The share is 60% unless changed
    expect(() => mgr.setUiPreferences({ autoCompact: { nudgeSecond: 0.6 } })).toThrow(/at least 5 points below the share agents compact at \(60%\)/)
    expect(() => mgr.setUiPreferences({ autoCompact: { nudgeSecond: 0.7 } })).toThrow(/must be at least 5 points below/)
    expect(() => mgr.setUiPreferences({ autoCompact: { nudgeSecond: 0.58 } })).toThrow(/must be at least 5 points below/)
    expect(mgr.uiPreferences().autoCompact).toBeUndefined()
    expect(mgr.setUiPreferences({ autoCompact: { nudgeSecond: 0.55 } }).autoCompact?.nudgeSecond).toBe(0.55)
    // The new share counts when the patch carries both
    expect(() => mgr.setUiPreferences({ autoCompact: { share: 0.5, nudgeSecond: 0.55 } })).toThrow(/\(50%\)/)
    expect(mgr.setUiPreferences({ autoCompact: { share: 0.7, nudgeSecond: 0.65 } }).autoCompact).toMatchObject({ share: 0.7, nudgeSecond: 0.65 })
    // Nothing of the refused change was written
    expect(mgr.uiPreferences().autoCompact).toMatchObject({ share: 0.7, nudgeSecond: 0.65 })
    // A share lowered under a second share chosen before takes it down: the setting stays one that can be saved again whole
    expect(mgr.setUiPreferences({ autoCompact: { share: 0.5 } }).autoCompact).toMatchObject({ share: 0.5, nudgeSecond: 0.45 })
    expect(nudgeShares(mgr.uiPreferences().autoCompact!).second).toBe(0.45)
  })

  it('judges the whole setting that results, so what prefs.get gives can always be sent back whole (#1504 review)', () => {
    const { mgr, store, row } = setup(JSON.stringify({ textSize: 1 }))
    mgr.setUiPreferences({ autoCompact: { nudgeSecond: 0.55 } })
    // The share alone is lowered under the stored second: accepted, and the second goes down with it (read back as saved)
    const lowered = mgr.setUiPreferences({ autoCompact: { share: 0.4 } }).autoCompact
    expect(lowered).toMatchObject({ share: 0.4, nudgeSecond: 0.35 })
    expect(row().autoCompactNudgeSecond).toBe(0.35)
    // What a hub pushes to a linked machine (`offerAutoCompact`): the whole setting, as prefs.get reads it
    const pushed = mgr.uiPreferences().autoCompact
    expect(() => mgr.setUiPreferences({ autoCompact: { ...pushed } })).not.toThrow()
    // A share moved by an older build under the stored second (it saves the record's two fields only) reads held, and sends whole
    store.settings.setAppSetting(KEY, JSON.stringify({ ...row(), autoCompactNudgeSecond: 0.55, autoCompact: { controlled: true, share: 0.4 } }))
    expect(mgr.uiPreferences().autoCompact).toMatchObject({ share: 0.4, nudgeSecond: 0.35 })
    expect(() => mgr.setUiPreferences({ autoCompact: { ...mgr.uiPreferences().autoCompact } })).not.toThrow()
    // A share lowered so far that the second cannot stay above the first goes back to the default, which follows the share
    expect(mgr.setUiPreferences({ autoCompact: { share: 0.3 } }).autoCompact).toMatchObject({ share: 0.3, nudgeFirst: 0.3, nudgeSecond: null })
    expect(row().autoCompactNudgeSecond).toBeNull()
    expect(() => mgr.setUiPreferences({ autoCompact: { ...mgr.uiPreferences().autoCompact } })).not.toThrow()
  })

  it('refuses a first share that is not below the chosen second, as an input refusal and not an internal error (#1504 review)', () => {
    const { mgr } = setup(JSON.stringify({ textSize: 1 }))
    const refused = (patch: UiPreferencesPatch) => {
      try {
        mgr.setUiPreferences(patch)
      } catch (err) {
        return err as Error & { code?: string; data?: unknown; retryable?: boolean }
      }
      throw new Error('was not refused')
    }
    const both = refused({ autoCompact: { nudgeFirst: 0.5, nudgeSecond: 0.3 } })
    expect(both.message).toMatch(/second reminder \(30%\) must be above the first \(50%\)/)
    expect(both).toMatchObject({ code: 'refused', retryable: false, data: { reason: 'bad_value' } })
    // Each alone, judged against the other as stored
    mgr.setUiPreferences({ autoCompact: { nudgeSecond: 0.4 } })
    expect(refused({ autoCompact: { nudgeFirst: 0.45 } }).message).toMatch(/must be above the first \(45%\)/)
    expect(refused({ autoCompact: { nudgeSecond: 0.3 } }).message).toMatch(/must be above the first \(30%\)/)
    // The second share above the tool's: the same refusal, with the code
    expect(refused({ autoCompact: { nudgeSecond: 0.7 } })).toMatchObject({ code: 'refused', data: { reason: 'bad_value' } })
    expect(mgr.uiPreferences().autoCompact).toMatchObject({ nudgeFirst: 0.3, nudgeSecond: 0.4 })
    // The default second share (null) has no such order: a first share over it is only never told (`nudgeShares`)
    expect(mgr.setUiPreferences({ autoCompact: { nudgeSecond: null, nudgeFirst: 0.55 } }).autoCompact).toMatchObject({ nudgeFirst: 0.55, nudgeSecond: null })
  })

  it('a broken row reads as the defaults, says so once with the row name, and the next change replaces it', () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { mgr, row } = setup('{"textSize": 1.1, ')
    // "Allow auto from a linked computer" alone reads as off from a damaged record (#1273 review), and is written so
    expect(mgr.uiPreferences()).toEqual({ ...DEFAULT_UI_PREFERENCES, hubAuto: false })
    mgr.uiPreferences()
    expect(said.mock.calls.filter(([line]) => String(line).includes(`app_settings.${KEY}`))).toHaveLength(1)
    mgr.setUiPreferences({ textSize: 1 })
    expect(row()).toEqual({ textSize: 1, hubAuto: false })
  })

  /*
   * Owner decision 2026-10-20: "Let sessions look at other sessions" is always on. The field stays in the record for
   * older builds; a false one stored before is not read, and one an older window sends is not stored
   */
  it('reads the session tools as on whatever the record holds, and does not store an "off" an older window sends', () => {
    const { mgr, row } = setup(JSON.stringify({ sessionTools: false, textSize: 1.1 }))
    expect(mgr.uiPreferences().sessionTools).toBe(true)
    expect(mgr.setUiPreferences({ sessionTools: false, sendWithModifierEnter: true }).sessionTools).toBe(true)
    expect(row()).toMatchObject({ sessionTools: false, sendWithModifierEnter: true })
    expect(mgr.uiPreferences().sessionTools).toBe(true)
    const fresh = setup(JSON.stringify({}))
    fresh.events.length = 0
    fresh.mgr.setUiPreferences({ sessionTools: false })
    // Nothing changed, so no window is told to read again
    expect(fresh.events).not.toContain('prefs_changed')
    expect(fresh.row()).not.toHaveProperty('sessionTools')
    expect(fresh.mgr.uiPreferences().sessionTools).toBe(true)
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
  /*
   * The notification switches moved from the workspace snapshot into this record (#1306), as the text size did. The first read
   * that finds none takes the snapshot's, field by field, and writes the record once; after that the record is the source.
   */
  describe('the notification switches (#1306)', () => {
    const snapshot = { approval: false, error: true, done: true, allDone: true, whenFocused: false, sound: 'loud', volume: 11 }

    it("come across from the workspace snapshot once, a switch it lacks or holds wrongly taking its default, and the move keeps the text size's", () => {
      const store = new Store()
      store.settings.saveWorkspace({ textScale: 4, notifyPolicy: snapshot })
      store.settings.setAppSetting(KEY, JSON.stringify({ laterField: 1 }))
      const mgr = new SessionManager(store, new Map(), () => {})
      expect(mgr.uiPreferences().notifyPolicy).toEqual({ ...DEFAULT_NOTIFY_POLICY, approval: false })
      // Both moves happened in the one read, and what another build wrote stayed
      expect(JSON.parse(store.settings.appSetting(KEY)!)).toEqual({ laterField: 1, textSize: 1.25, notifyPolicy: { ...DEFAULT_NOTIFY_POLICY, approval: false } })
    })

    it('are the record\'s from then on: a snapshot an older window writes later does not override a switch chosen since', () => {
      const store = new Store()
      store.settings.saveWorkspace({ notifyPolicy: snapshot })
      const mgr = new SessionManager(store, new Map(), () => {})
      mgr.setUiPreferences({ notifyPolicy: { sound: false } })
      store.settings.saveWorkspace({ notifyPolicy: { ...DEFAULT_NOTIFY_POLICY, approval: true, sound: true } })
      expect(mgr.uiPreferences().notifyPolicy).toEqual({ ...DEFAULT_NOTIFY_POLICY, approval: false, sound: false })
    })

    it('are merged one by one: a patch carrying one switch leaves the others, and the answer is the record after the write', () => {
      const { mgr, row } = setup(JSON.stringify({ notifyPolicy: { ...DEFAULT_NOTIFY_POLICY, error: false } }))
      const out = mgr.setUiPreferences({ notifyPolicy: { whenFocused: true } })
      expect(out.notifyPolicy).toEqual({ ...DEFAULT_NOTIFY_POLICY, error: false, whenFocused: true })
      expect(row().notifyPolicy).toEqual({ ...DEFAULT_NOTIFY_POLICY, error: false, whenFocused: true })
    })

    it('are announced to every window with prefs_changed, and a read announces nothing', () => {
      const events: string[] = []
      const mgr = new SessionManager(new Store(), new Map(), (e) => events.push(e.type))
      mgr.uiPreferences()
      expect(events).toEqual([])
      mgr.setUiPreferences({ notifyPolicy: { sound: false } })
      mgr.setUiPreferences({})
      expect(events).toEqual(['prefs_changed'])
    })

    it("start from the snapshot's switches when the row is broken, so one change does not reset the others", () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const store = new Store()
      store.settings.saveWorkspace({ notifyPolicy: { ...DEFAULT_NOTIFY_POLICY, approval: false } })
      store.settings.setAppSetting(KEY, '{"notifyPolicy": ')
      const mgr = new SessionManager(store, new Map(), () => {})
      const out = mgr.setUiPreferences({ notifyPolicy: { sound: false } })
      // The window showed the snapshot's switches; the change keeps them, as the replaced row now holds
      expect(out.notifyPolicy).toEqual({ ...DEFAULT_NOTIFY_POLICY, approval: false, sound: false })
      expect(JSON.parse(store.settings.appSetting(KEY)!).notifyPolicy).toEqual({ ...DEFAULT_NOTIFY_POLICY, approval: false, sound: false })
    })

    it('are not written over a broken row by reading it, and a switch a build does not know is dropped on reading', () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const store = new Store()
      store.settings.saveWorkspace({ notifyPolicy: snapshot })
      store.settings.setAppSetting(KEY, '{"notifyPolicy": ')
      const mgr = new SessionManager(store, new Map(), () => {})
      expect(mgr.uiPreferences().notifyPolicy).toBeUndefined()
      expect(store.settings.appSetting(KEY)).toBe('{"notifyPolicy": ')
      const { mgr: mgr2 } = setup(JSON.stringify({ notifyPolicy: { ...DEFAULT_NOTIFY_POLICY, volume: 11, sound: 'loud' } }))
      expect(mgr2.uiPreferences().notifyPolicy).toEqual({ approval: true, error: true, done: true, allDone: true, whenFocused: false, sound: true })
    })
  })

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
