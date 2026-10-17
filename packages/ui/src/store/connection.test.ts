import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent, SessionInfo, ThemeFileEntry } from '@cc/protocol'
import { DEFAULT_UI_PREFERENCES, sessionLiveDefaults } from '@cc/protocol'
// eslint-disable-next-line no-restricted-imports -- the runtime ui knows only ports, but tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import { useStore, type ChatItem } from './store.js'
import { goodThemes, RECOVERY_RETRY_MS } from './connection.js'

/**
 * The store's link to the host (connection.ts): attaching to a platform, what a drop and a return
 * do to the state, and the recovery's retries. The saved-workspace writer and the resync merge have
 * their own scenarios in store.test.ts; these are the rules that had none.
 *
 * The subscriptions and the recovery's generation are module state, shared by every test here, so
 * each test uses session ids of its own.
 */

function sessionInfo(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id, projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: id, autoNamed: true,
    state: 'idle', lastReadSeq: 0, lastSeq: 0, createdAt: 0,
    waitingSince: null, live: true, model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal',
    importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null,
    appId: null, ...sessionLiveDefaults(), ...over,
  }
}

const delta = (sessionId: string, text: string) =>
  ({ sessionId, type: 'message_delta', role: 'assistant', text }) as NormalizedEvent
const texts = (id: string) => (useStore.getState().chat[id] ?? []).map((i: ChatItem) => ('text' in i ? i.text : i.kind))
const timedOut = () => Object.assign(new Error('RPC timed out'), { code: 'timeout' })

beforeEach(() => {
  useStore.setState({
    platform: null,
    connection: 'connecting',
    sessions: {},
    chat: {},
    history: {},
    resuming: {},
    wakeError: {},
    toast: null,
    foldedProjects: [],
    focusedSessionId: null,
    machines: {},
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('attaching to a platform', () => {
  /*
   * A subscription is a fresh closure each time, so attaching again without dropping the old one
   * applied every event once per attach: streamed text arrived doubled (dogfooding, x2 and x3).
   */
  it('attaching again applies each event once, not once per attach', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('att-1', sessionInfo('att-1'))
    await useStore.getState().attach(mock)
    await useStore.getState().attach(mock)
    await useStore.getState().attach(mock)

    mock.emit(delta('att-1', 'the host is'))

    expect(texts('att-1')).toEqual(['the host is'])
  })

  it('a platform attached before is no longer listened to', async () => {
    const before = new MockPlatform()
    before.sessions.set('att-2', sessionInfo('att-2'))
    await useStore.getState().attach(before)
    const after = new MockPlatform()
    after.sessions.set('att-2', sessionInfo('att-2'))
    await useStore.getState().attach(after)

    before.emit(delta('att-2', 'from the old host'))
    before.setConnectionState('disconnected')

    expect(texts('att-2')).toEqual([])
    expect(useStore.getState().connection).toBe('connected')
  })

  it('comes up connected with the lists it could read when the optional reads fail', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('att-3', sessionInfo('att-3'))
    vi.spyOn(mock.agents, 'grid').mockRejectedValue(timedOut())
    vi.spyOn(mock.agents, 'detect').mockRejectedValue(timedOut())
    vi.spyOn(mock.prefs, 'load').mockRejectedValue(timedOut())
    vi.spyOn(mock.apps, 'list').mockRejectedValue(timedOut())
    vi.spyOn(mock.themes, 'list').mockRejectedValue(timedOut())
    vi.spyOn(mock.machines, 'list').mockRejectedValue(timedOut())

    await useStore.getState().attach(mock)

    const s = useStore.getState()
    expect(s.connection).toBe('connected')
    expect(Object.keys(s.sessions)).toEqual(['att-3'])
    // The composer reads Enter from these: an unreadable value is the default, never a missing one
    expect(s.prefs).toEqual(DEFAULT_UI_PREFERENCES)
    expect(s.gridPanels).toEqual([])
    expect(s.externalApps).toEqual([])
    expect(s.themeFiles).toEqual([])
  })

  it('a save the previous platform could not store is not sent to the next one', async () => {
    const before = new MockPlatform()
    await useStore.getState().attach(before)
    vi.spyOn(before.workspace, 'save').mockRejectedValue(timedOut())
    before.setConnectionState('disconnected')
    useStore.getState().toggleProjectFold('att-folded-on-the-old-host')

    const after = new MockPlatform()
    const saved = vi.spyOn(after.workspace, 'save')
    await useStore.getState().attach(after)
    after.setConnectionState('disconnected')
    after.setConnectionState('connected')

    expect(saved).not.toHaveBeenCalled()
  })
})

describe('the connection label', () => {
  it('a drop reads as disconnected, and the return as connected', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.setConnectionState('disconnected')
    expect(useStore.getState().connection).toBe('disconnected')
    mock.setConnectionState('connected')
    expect(useStore.getState().connection).toBe('connected')
  })

  it('only a return from a drop runs the recovery; a repeated connected does not', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const recover = vi.spyOn(useStore.getState(), 'recoverAfterReconnect')
    mock.setConnectionState('connected')
    expect(recover).not.toHaveBeenCalled()

    mock.setConnectionState('disconnected')
    mock.setConnectionState('connected')
    expect(recover).toHaveBeenCalledTimes(1)
  })
})

/*
 * A host that died and was brought back knows none of the agent processes that were alive: they
 * died with it. The window knows which were running and wakes those, and only those.
 */
describe('reviving after a reconnect', () => {
  it('wakes what was running before the drop and the new host does not run, and nothing else', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('rv-running', sessionInfo('rv-running', { live: true }))
    mock.sessions.set('rv-asleep', sessionInfo('rv-asleep', { live: false }))
    mock.sessions.set('rv-still', sessionInfo('rv-still', { live: true }))
    await useStore.getState().attach(mock)

    mock.setConnectionState('disconnected')
    // The new host came up with only one of the two processes still attached
    mock.sessions.get('rv-running')!.live = false
    mock.setConnectionState('connected')

    await vi.waitFor(() => expect(mock.resumeCalls).toEqual(['rv-running']))
    expect(useStore.getState().toast).toBe('Reconnected — resuming 1 session')
    await vi.waitFor(() => expect(useStore.getState().sessions['rv-running']!.live).toBe(true))
    expect(useStore.getState().sessions['rv-asleep']!.live).toBe(false)
  })

  it('a session the new host no longer lists is not woken', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('rv-gone', sessionInfo('rv-gone', { live: true }))
    mock.sessions.set('rv-kept', sessionInfo('rv-kept', { live: true }))
    await useStore.getState().attach(mock)

    mock.setConnectionState('disconnected')
    mock.sessions.delete('rv-gone')
    mock.sessions.get('rv-kept')!.live = false
    mock.setConnectionState('connected')

    await vi.waitFor(() => expect(mock.resumeCalls).toEqual(['rv-kept']))
    expect(useStore.getState().toast).toBe('Reconnected — resuming 1 session')
    await vi.waitFor(() => expect(useStore.getState().sessions['rv-kept']!.live).toBe(true))
    expect(useStore.getState().sessions['rv-gone']).toBeUndefined()
  })
})

describe('the recovery\'s retries', () => {
  it('a newer recovery ends the retries of an older one', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const list = vi.spyOn(mock.agents, 'listSessions')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    list.mockRejectedValueOnce(timedOut())
    const older = useStore.getState().recoverAfterReconnect()
    await vi.advanceTimersByTimeAsync(0)
    await useStore.getState().recoverAfterReconnect()
    expect(list).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(RECOVERY_RETRY_MS[0])
    await older
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('a drop ends the retries; the return recovers on its own', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const list = vi.spyOn(mock.agents, 'listSessions')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    list.mockRejectedValueOnce(timedOut())
    const recovery = useStore.getState().recoverAfterReconnect()
    await vi.advanceTimersByTimeAsync(0)
    mock.setConnectionState('disconnected')
    await vi.advanceTimersByTimeAsync(RECOVERY_RETRY_MS[0])
    await recovery
    expect(list).toHaveBeenCalledTimes(1)
  })

  it('stops after its last step instead of asking a failing host forever', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const list = vi.spyOn(mock.agents, 'listSessions').mockRejectedValue(timedOut())
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    const recovery = useStore.getState().recoverAfterReconnect()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await recovery
    expect(list).toHaveBeenCalledTimes(RECOVERY_RETRY_MS.length + 1)
  })
})

describe('goodThemes: the last clean read of each theme file', () => {
  const theme = (id: string, over: Partial<ThemeFileEntry> = {}): ThemeFileEntry => ({
    id, path: `/themes/${id}.json`, name: id, base: 'dark', tokens: { '--color-ink': '#eee' }, problems: [], broken: false, ...over,
  })

  it('a clean read replaces the last one', () => {
    const next = theme('t1', { tokens: { '--color-ink': '#fff' } })
    expect(goodThemes({ t1: theme('t1') }, [next])).toEqual({ t1: next })
  })

  it('a file broken mid-edit keeps its last clean read', () => {
    const clean = theme('t1')
    expect(goodThemes({ t1: clean }, [theme('t1', { broken: true, tokens: {} })])).toEqual({ t1: clean })
  })

  it('a file broken from the start has nothing to keep, and a deleted file is forgotten', () => {
    expect(goodThemes({ gone: theme('gone') }, [theme('t2', { broken: true })])).toEqual({})
  })
})
