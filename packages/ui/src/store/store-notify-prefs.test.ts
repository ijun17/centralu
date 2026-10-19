import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_NOTIFY_POLICY } from '@cc/core'
import { DEFAULT_UI_PREFERENCES } from '@cc/protocol'
// eslint-disable-next-line no-restricted-imports -- the runtime ui knows only ports, but tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import { useStore } from './store.js'
import { resetStore } from './store.test-helpers.js'

/**
 * The notification switches are the host's (#1306): the window reads them from the preferences, saves only the switches
 * that changed through them, hears a change another writer made (the orchestrator, another window), and falls back to the
 * workspace snapshot's copy only for a host that has none.
 */
const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => resetStore())

describe('the notification switches live in the host (#1306)', () => {
  it("take the host's record over the workspace snapshot's copy", async () => {
    const mock = new MockPlatform()
    mock.uiPrefs = { ...DEFAULT_UI_PREFERENCES, notifyPolicy: { ...DEFAULT_NOTIFY_POLICY, sound: false } }
    // An older window's snapshot says the opposite: the record, not the snapshot, is the source
    mock.workspaceSnapshot = { notifyPolicy: { ...DEFAULT_NOTIFY_POLICY, sound: true, approval: false } } as never
    await useStore.getState().attach(mock)
    await tick()
    expect(useStore.getState().notifyPolicy).toEqual({ ...DEFAULT_NOTIFY_POLICY, sound: false })
  })

  it("take the snapshot's copy from a host that answers without them, as before", async () => {
    const mock = new MockPlatform()
    mock.workspaceSnapshot = { notifyPolicy: { ...DEFAULT_NOTIFY_POLICY, done: false } } as never
    // A host from before the switches: its record has no such field and it never will, and it strips the one a save sends
    vi.spyOn(mock.prefs, 'load').mockResolvedValue({ ...DEFAULT_UI_PREFERENCES })
    const save = vi.spyOn(mock.prefs, 'save').mockResolvedValue({ ...DEFAULT_UI_PREFERENCES })
    await useStore.getState().attach(mock)
    await tick()
    expect(useStore.getState().notifyPolicy).toEqual({ ...DEFAULT_NOTIFY_POLICY, done: false })
    // A change is sent to the host (which drops it) and kept here, and a later reading from that host does not undo it
    useStore.getState().setNotifyPolicy({ ...useStore.getState().notifyPolicy, sound: false })
    await tick()
    expect(save).toHaveBeenCalledWith({ notifyPolicy: { sound: false } })
    await useStore.getState().refreshPrefs()
    expect(useStore.getState().notifyPolicy).toEqual({ ...DEFAULT_NOTIFY_POLICY, done: false, sound: false })
    expect((mock.workspaceSnapshot as { notifyPolicy?: unknown } | null)?.notifyPolicy).toEqual({ ...DEFAULT_NOTIFY_POLICY, done: false, sound: false })
  })

  it('save only the switches that changed, so another writer\'s change to a different one is not undone', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    await tick()
    const save = vi.spyOn(mock.prefs, 'save')
    useStore.getState().setNotifyPolicy({ ...useStore.getState().notifyPolicy, sound: false })
    await tick()
    expect(save).toHaveBeenCalledWith({ notifyPolicy: { sound: false } })
    // The snapshot's copy is still written, for a build that reads the switches there
    expect((mock.workspaceSnapshot as { notifyPolicy?: unknown } | null)?.notifyPolicy).toEqual({ ...DEFAULT_NOTIFY_POLICY, sound: false })
    // The orchestrator turned another one off meanwhile; this window turns a third off
    await mock.prefs.save({ notifyPolicy: { error: false } })
    await tick()
    useStore.getState().setNotifyPolicy({ ...useStore.getState().notifyPolicy, allDone: false })
    await tick()
    expect(mock.uiPrefs.notifyPolicy).toEqual({ ...DEFAULT_NOTIFY_POLICY, sound: false, error: false, allDone: false })
    // Nothing changed, nothing sent
    save.mockClear()
    useStore.getState().setNotifyPolicy({ ...useStore.getState().notifyPolicy })
    await tick()
    expect(save).not.toHaveBeenCalled()
  })

  it('follow a change another writer made, on prefs_changed; the snapshot\'s copy catches up with the next save', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    await tick()
    // The orchestrator's set_preferences: the host's record changes and every window is told
    await mock.prefs.save({ notifyPolicy: { whenFocused: true, approval: false } })
    await tick()
    await tick()
    expect(useStore.getState().notifyPolicy).toEqual({ ...DEFAULT_NOTIFY_POLICY, whenFocused: true, approval: false })
    expect(useStore.getState().prefs.notifyPolicy).toEqual({ ...DEFAULT_NOTIFY_POLICY, whenFocused: true, approval: false })
    // No window rewrites the snapshot because another writer changed a switch: the next save of the layout carries it
    expect((mock.workspaceSnapshot as { notifyPolicy?: unknown } | null)?.notifyPolicy).not.toEqual({ ...DEFAULT_NOTIFY_POLICY, whenFocused: true, approval: false })
    useStore.getState().setShowIgnored(false)
    await tick()
    expect((mock.workspaceSnapshot as { notifyPolicy?: unknown } | null)?.notifyPolicy).toEqual({ ...DEFAULT_NOTIFY_POLICY, whenFocused: true, approval: false })
  })

  it('also follow another setting the orchestrator changed (the theme), without a reload', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    await tick()
    await mock.prefs.save({ textSize: 1.25 })
    await tick()
    await tick()
    expect(useStore.getState().prefs.textSize).toBe(1.25)
  })

  it('do not take an older reading over this window\'s own change that is still on its way', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    await tick()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const realSave = mock.prefs.save
    vi.spyOn(mock.prefs, 'save').mockImplementation(async (patch) => {
      await gate
      return realSave(patch)
    })
    useStore.getState().setNotifyPolicy({ ...DEFAULT_NOTIFY_POLICY, sound: false })
    // A reading is asked for while the save waits (another change's event): it waits too, rather than putting an older record over the change
    const load = vi.spyOn(mock.prefs, 'load')
    await useStore.getState().refreshPrefs()
    expect(load).not.toHaveBeenCalled()
    expect(useStore.getState().notifyPolicy.sound).toBe(false)
    release()
    await tick()
    await tick()
    // ...and happens once the save is done, showing the record with the change in it
    expect(load).toHaveBeenCalledTimes(1)
    expect(useStore.getState().notifyPolicy.sound).toBe(false)
    expect(useStore.getState().prefs.notifyPolicy?.sound).toBe(false)
  })

  it('do not unfold a group folded meanwhile when the reading of an earlier fold arrives (#666)', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    await tick()
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const realSave = mock.prefs.save
    vi.spyOn(mock.prefs, 'save').mockImplementation(async (patch) => {
      await gate
      return realSave(patch)
    })
    const saving = useStore.getState().setPrefs({ foldedGroups: ['session:a'] })
    const savingTwo = useStore.getState().setPrefs({ foldedGroups: ['session:a', 'session:b'] })
    await useStore.getState().refreshPrefs()
    expect(useStore.getState().prefs.foldedGroups).toEqual([])
    release()
    await Promise.all([saving, savingTwo])
    await tick()
    expect(useStore.getState().prefs.foldedGroups).toEqual(['session:a', 'session:b'])
  })
})
