/**
 * Store regression tests: the connection: reconnects, live events, linked machines and offline marks.
 *
 * Ports go through `MockPlatform` (no ad-hoc mocking, or the contract falls apart). The
 * `pendingEvents` holding pen is module state, so it cannot be cleared between tests — each test
 * uses a different session id instead. Shared fixtures are in store.test-helpers.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MachineInfo, NormalizedEvent } from '@cc/protocol'
// eslint-disable-next-line no-restricted-imports -- the runtime ui knows only ports, but tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import { PENDING_EVENTS_MAX, PENDING_EVENTS_MAX_AGE_MS, useStore } from './store.js'
import { delta, holdList, line, resetStore, sessionInfo } from './store.test-helpers.js'

beforeEach(resetStore)

describe('events arriving before session registration (U2)', () => {
  it('when attach registers the list, events held in the pen are replayed — a session that was already running before the app was opened', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('u2-s1', sessionInfo('u2-s1'))

    // The event arrived before registration (streaming from a session already running on the host)
    useStore.getState().dispatchEvent(delta('u2-s1', 'output that arrived first'))
    expect(useStore.getState().chat['u2-s1']).toBeUndefined()

    await useStore.getState().attach(mock)

    const chat = useStore.getState().chat['u2-s1']
    expect(chat).toHaveLength(1)
    expect(chat![0]).toMatchObject({ kind: 'assistant', text: 'output that arrived first' })
  })

  it('overlapping with the createSession path still applies it only once (cleared from the pen before replay)', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('u2-s2', sessionInfo('u2-s2'))
    useStore.getState().dispatchEvent(delta('u2-s2', 'once'))

    await useStore.getState().attach(mock)
    // Creating another session runs replayPendingEvents again — an event already replayed must never come back
    const p = await useStore.getState().addProject('/tmp/u2')
    await useStore.getState().createSession(p.id)

    expect(useStore.getState().chat['u2-s2']!.filter((i) => i.kind === 'assistant')).toHaveLength(1)
  })
})

describe('handling resync_required (U3)', () => {
  it('marks the connection as connected and runs a full resync', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('u3-s1', sessionInfo('u3-s1'))
    await useStore.getState().attach(mock)

    // A session was created on the host while disconnected, and event replay was reported as impossible
    mock.sessions.set('u3-s2', sessionInfo('u3-s2', { name: 'created during the disconnect' }))
    mock.setConnectionState('resync_required')

    // The label logic draws everything other than `connected` as 'Disconnected' — leaving this value set would be a lie
    expect(useStore.getState().connection).toBe('connected')
    await vi.waitFor(() => expect(useStore.getState().sessions['u3-s2']).toBeDefined())
    expect(useStore.getState().sessions['u3-s2']!.name).toBe('created during the disconnect')
  })

  it('a resync re-reads the conversation being viewed from the store (events from the gap never come again)', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('u3-s3', sessionInfo('u3-s3'))
    await useStore.getState().attach(mock)
    useStore.setState({ focusedSessionId: 'u3-s3' })

    const spy = vi.spyOn(useStore.getState(), 'loadHistory')
    mock.setConnectionState('resync_required')
    await vi.waitFor(() => expect(spy).toHaveBeenCalledWith('u3-s3'))
  })

  /*
   * #173: while a resync re-read only the focused session, another session's conversation was left
   * holding a gap, and opening it later did not re-read it either, since a cursor already existed —
   * the gap stayed unfilled until the app was reopened.
   */
  it('a resync also fills the gap from the store for other sessions holding a conversation', async () => {
    const mock = new MockPlatform()
    const rows = (id: string, from: number, to: number) =>
      Array.from({ length: to - from + 1 }, (_, i) => ({
        sessionId: id, seq: from + i, role: 'user' as const, kind: 'text' as const, payload: { text: `L${from + i}` }, ts: from + i,
      }))
    mock.sessions.set('u3-f', sessionInfo('u3-f', { lastSeq: 5, lastReadSeq: 5 }))
    mock.sessions.set('u3-g', sessionInfo('u3-g', { lastSeq: 5, lastReadSeq: 5 }))
    mock.messages.set('u3-f', rows('u3-f', 1, 5))
    mock.messages.set('u3-g', rows('u3-g', 1, 5))
    await useStore.getState().attach(mock)
    await useStore.getState().loadHistory('u3-g')
    useStore.getState().focusSession('u3-f')
    await vi.waitFor(() => expect(useStore.getState().history['u3-f']).toBeDefined())
    expect(useStore.getState().chat['u3-g']!.map(line)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5'])

    // Three more lines were stored for `g` while disconnected, and the host cannot replay those events
    mock.messages.get('u3-g')!.push(...rows('u3-g', 6, 8))
    mock.setConnectionState('resync_required')
    await vi.waitFor(() =>
      expect(useStore.getState().chat['u3-g']!.map(line)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8']),
    )
  })
})

/** Lets every pending promise and zero-delay timer run */
const settle = () => new Promise((r) => setTimeout(r, 0))

// #841 items 9 and 10: what the window could not read was dropped with no word
describe('what the window could not read is said', () => {
  it('a reconnect that cannot read the session list after its retries says so', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    await settle()
    mock.agents.listSessions = async () => {
      throw new Error('RPC timed out')
    }
    useStore.setState({ toast: null })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const done = useStore.getState().recoverAfterReconnect()
      await vi.advanceTimersByTimeAsync(1_000 + 5_000 + 30_000)
      await done
      expect(useStore.getState().toast).toBe('Could not catch up after reconnecting: the session list may be out of date until the next reconnect')
    } finally {
      vi.useRealTimers()
    }
  })

  it('startup reads that came up empty are named in one toast', async () => {
    const mock = new MockPlatform()
    mock.agents.grid = async () => {
      throw new Error('no')
    }
    mock.apps.list = async () => {
      throw new Error('no')
    }
    useStore.setState({ toast: null })
    await useStore.getState().attach(mock)
    const toast = useStore.getState().toast ?? ''
    expect(toast).toMatch(/^Could not read .*; shown empty or as defaults until read again$/)
    expect(toast).toContain('the grid layout')
    expect(toast).toContain('the app list')
  })

  it('a machine list that could not be read is said, while a host from before machines says nothing (#841 item 10)', async () => {
    const mock = new MockPlatform()
    mock.machines.list = async () => {
      throw new Error('RPC timed out')
    }
    useStore.setState({ toast: null })
    await useStore.getState().attach(mock)
    expect(useStore.getState().toast).toBe('Could not read the linked machines; shown empty or as defaults until read again')
    const older = new MockPlatform()
    older.machines.list = async () => {
      throw new Error('Unknown method: machines.list. This Centralu host does not have it; the window may be from another build.')
    }
    useStore.setState({ toast: null })
    await useStore.getState().attach(older)
    expect(useStore.getState().toast).toBeNull()
  })

  it('a folder watch the host refuses is said once, and again only after one worked (#841)', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    let refuse = true
    mock.fs.watch = async () => {
      if (refuse) throw new Error('too many open files')
      return { watched: 1 }
    }
    useStore.setState({ toast: null })
    await useStore.getState().watchProjectDirs('p-watch', [''])
    expect(useStore.getState().toast).toBe('The file tree will not follow changes made outside it: too many open files')
    useStore.setState({ toast: null })
    await useStore.getState().watchProjectDirs('p-watch', ['', 'src'])
    expect(useStore.getState().toast).toBeNull()
    refuse = false
    await useStore.getState().watchProjectDirs('p-watch', [''])
    refuse = true
    await useStore.getState().watchProjectDirs('p-watch', [''])
    expect(useStore.getState().toast).toBe('The file tree will not follow changes made outside it: too many open files')
  })

  it('a startup that read everything says nothing', async () => {
    useStore.setState({ toast: null })
    await useStore.getState().attach(new MockPlatform())
    expect(useStore.getState().toast).toBeNull()
  })
})

/**
 * A reconnect's recovery while the host keeps talking. The session list is read with a request, and live
 * events keep arriving until its answer does; the hub answers only once every linked machine has, so the
 * list can be older than them. The recovery used to apply the rows as they stood.
 */
describe('reconnect recovery against live events', () => {
  it('a relaunched window keeps re-attachment events when recovery overtakes its initial list (#640)', async () => {
    const mock = new MockPlatform()
    const id = 'swap-relaunched'
    mock.sessions.set(id, sessionInfo(id, { tool: 'codex', state: 'idle', live: false }))
    const list = holdList(mock)
    const attaching = useStore.getState().attach(mock)
    await list.asked
    // A connection recovery registers the row while attach is still waiting for its startup reads.
    await useStore.getState().recoverAfterReconnect(true)
    mock.sessions.get(id)!.state = 'working'
    mock.emit({ type: 'session_live', sessionId: id, live: true })
    mock.emit({ type: 'state_change', sessionId: id, state: 'working', reason: 'reattached' })
    list.release()
    await attaching
    expect(useStore.getState().sessions[id]).toMatchObject({ state: 'working', live: true })
  })

  it.each(['reattached', 'streaming'] as const)('keeps a mid-turn Codex session %s during a host swap over the stale startup list (#640)', async (signal) => {
    const mock = new MockPlatform()
    const id = `swap-${signal}`
    mock.sessions.set(id, sessionInfo(id, { tool: 'codex', projectId: 'background', state: 'working', live: true }))
    await useStore.getState().attach(mock)
    useStore.setState({ focusedProjectId: 'another-project' })
    mock.setConnectionState('disconnected')
    // The replacement host resets a session before its process has re-attached.
    mock.sessions.set(id, sessionInfo(id, { tool: 'codex', projectId: 'background', state: 'idle', live: false, name: 'renamed during swap' }))
    const list = holdList(mock)
    const recovery = useStore.getState().recoverAfterReconnect(true)
    await list.asked
    // These reaffirm the pre-swap values: a value comparison alone cannot see that they are newer.
    mock.sessions.get(id)!.state = 'working'
    mock.emit({ type: 'session_live', sessionId: id, live: true })
    mock.emit(signal === 'reattached'
      ? { type: 'state_change', sessionId: id, state: 'working', reason: 'reattached' }
      : delta(id, 'still running'))
    expect(useStore.getState().sessions[id]).toMatchObject({ state: 'working', live: true })
    list.release()
    await recovery
    expect(useStore.getState().sessions[id]).toMatchObject({ state: 'working', live: true, name: 'renamed during swap' })
    expect(useStore.getState().workingSince[id]).toBeDefined()
    expect(mock.resumeCalls).toEqual([])
  })

  const rows = (id: string, from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({
      sessionId: id, seq: from + i, role: 'user' as const, kind: 'text' as const, payload: { text: `L${from + i}` }, ts: from + i,
    }))

  it('a session created by a live event while the list is out is not treated as deleted', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('rl-a', sessionInfo('rl-a'))
    await useStore.getState().attach(mock)
    const list = holdList(mock)
    mock.setConnectionState('resync_required')
    await list.asked

    mock.sessions.set('rl-b', sessionInfo('rl-b'))
    mock.emit({ type: 'session_created', sessionId: 'rl-b', session: sessionInfo('rl-b') } as NormalizedEvent)
    expect(useStore.getState().sessions['rl-b']).toBeDefined()
    list.release()
    await settle()

    expect(Object.keys(useStore.getState().sessions).sort()).toEqual(['rl-a', 'rl-b'])
  })

  it('an approval, a state and a read position that changed while the list is out are not overwritten by its older row', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('rl-c', sessionInfo('rl-c', { name: 'before the gap', lastSeq: 4, lastReadSeq: 2 }))
    await useStore.getState().attach(mock)
    // Renamed during the gap: only the list knows
    mock.sessions.set('rl-c', sessionInfo('rl-c', { name: 'renamed in the gap', lastSeq: 4, lastReadSeq: 2 }))
    const list = holdList(mock)
    mock.setConnectionState('resync_required')
    await list.asked

    mock.emit({ type: 'approval_request', sessionId: 'rl-c', requestId: 'rq-1', detail: { kind: 'command', command: 'make' } } as never)
    await useStore.getState().markRead('rl-c')
    const live = useStore.getState().sessions['rl-c']!
    expect(live.pendingApproval).not.toBeNull()
    expect(live.state).toBe('waiting_approval')
    expect(live.lastReadSeq).toBe(4)
    list.release()
    await settle()

    const after = useStore.getState().sessions['rl-c']!
    expect(after.name).toBe('renamed in the gap')
    expect(after.pendingApproval).toEqual(live.pendingApproval)
    expect(after.state).toBe('waiting_approval')
    expect(after.lastReadSeq).toBe(4)
  })

  it('a session deleted by a live event while the list is out is not brought back by its older row', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('rl-d', sessionInfo('rl-d'))
    mock.sessions.set('rl-e', sessionInfo('rl-e'))
    await useStore.getState().attach(mock)
    const list = holdList(mock)
    mock.setConnectionState('resync_required')
    await list.asked

    mock.emit({ type: 'session_deleted', sessionId: 'rl-d' } as NormalizedEvent)
    expect(useStore.getState().sessions['rl-d']).toBeUndefined()
    list.release()
    await settle()

    expect(Object.keys(useStore.getState().sessions).sort()).toEqual(['rl-e'])
  })

  it('a session deleted during the gap, which no live event names, still leaves', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('rl-f', sessionInfo('rl-f'))
    mock.sessions.set('rl-g', sessionInfo('rl-g'))
    await useStore.getState().attach(mock)
    mock.sessions.delete('rl-f')
    mock.setConnectionState('resync_required')
    await vi.waitFor(() => expect(useStore.getState().sessions['rl-f']).toBeUndefined())
    expect(useStore.getState().sessions['rl-g']).toBeDefined()
  })

  it('a session list that fails to arrive is read again, so the gap is still recovered', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('rl-h', sessionInfo('rl-h'))
    await useStore.getState().attach(mock)
    mock.sessions.set('rl-i', sessionInfo('rl-i', { name: 'created during the disconnect' }))
    vi.spyOn(mock.agents, 'listSessions').mockRejectedValueOnce(Object.assign(new Error('RPC timed out'), { code: 'timeout' }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      mock.setConnectionState('resync_required')
      await vi.advanceTimersByTimeAsync(0)
      expect(useStore.getState().sessions['rl-i']).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(useStore.getState().sessions['rl-i']?.name).toBe('created during the disconnect')
    } finally {
      vi.useRealTimers()
    }
  })

  it('a conversation page a resync fails to read is read again, so its gap is filled', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('rl-j', sessionInfo('rl-j', { lastSeq: 3, lastReadSeq: 3 }))
    mock.messages.set('rl-j', rows('rl-j', 1, 3))
    await useStore.getState().attach(mock)
    await useStore.getState().loadHistory('rl-j')
    expect(useStore.getState().chat['rl-j']!.map(line)).toEqual(['L1', 'L2', 'L3'])

    // Two lines were stored while disconnected, and the first re-read times out
    mock.messages.get('rl-j')!.push(...rows('rl-j', 4, 5))
    vi.spyOn(mock.agents, 'loadMessages').mockRejectedValueOnce(Object.assign(new Error('RPC timed out'), { code: 'timeout' }))
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      mock.setConnectionState('resync_required')
      await vi.advanceTimersByTimeAsync(0)
      // Until it is read, nothing claims it was: opening the conversation reads it again too
      expect(useStore.getState().history['rl-j']).toBeUndefined()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(useStore.getState().chat['rl-j']!.map(line)).toEqual(['L1', 'L2', 'L3', 'L4', 'L5'])
      expect(useStore.getState().history['rl-j']).toBeDefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a resync that is the first word after a drop still does what a reconnect does', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.setConnectionState('connected')
    mock.setConnectionState('disconnected')
    const versions = vi.spyOn(useStore.getState(), 'checkAgentVersions')
    mock.setConnectionState('resync_required')
    expect(useStore.getState().connection).toBe('connected')
    expect(versions).toHaveBeenCalledWith(false)
  })
})

describe('merging the session list on reconnect (U4)', () => {
  it('a session created, renamed or deleted while disconnected is reflected on screen', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('u4-s1', sessionInfo('u4-s1'))
    mock.sessions.set('u4-gone', sessionInfo('u4-gone'))
    await useStore.getState().attach(mock)

    // While disconnected: one is deleted, one is renamed, one is newly created
    mock.sessions.delete('u4-gone')
    mock.sessions.get('u4-s1')!.name = 'changed name'
    mock.sessions.set('u4-new', sessionInfo('u4-new'))

    mock.setConnectionState('disconnected')
    mock.setConnectionState('connected')

    await vi.waitFor(() => {
      const s = useStore.getState().sessions
      expect(s['u4-new']).toBeDefined()
      expect(s['u4-gone']).toBeUndefined()
      expect(s['u4-s1']!.name).toBe('changed name')
    })
  })

  it('a session deleted while disconnected leaves nothing behind, the way a deletion does (#163)', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('u4-kept', sessionInfo('u4-kept'))
    mock.sessions.set('u4-vanished', sessionInfo('u4-vanished'))
    await useStore.getState().attach(mock)
    useStore.setState((s) => ({
      drafts: { ...s.drafts, 'u4-vanished': { text: 'unsent', attachments: [] } },
      history: { ...s.history, 'u4-vanished': { oldestSeq: 1, more: false, loading: false } },
      notices: [...s.notices, { sessionId: 'u4-vanished', kind: 'done', name: 'u4-vanished', at: 1 } as never],
    }))

    mock.sessions.delete('u4-vanished')
    mock.setConnectionState('disconnected')
    mock.setConnectionState('connected')

    await vi.waitFor(() => expect(useStore.getState().sessions['u4-vanished']).toBeUndefined())
    const st = useStore.getState()
    expect(st.drafts['u4-vanished']).toBeUndefined()
    expect(st.history['u4-vanished']).toBeUndefined()
    expect(st.notices.some((n) => n.sessionId === 'u4-vanished')).toBe(false)
  })

  it('local derived state (like preview) survives the merge', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('u4-s2', sessionInfo('u4-s2'))
    await useStore.getState().attach(mock)
    // Local derived state created by an event — a value the host's list does not carry
    useStore.getState().dispatchEvent(delta('u4-s2', 'reply that was in progress'))
    expect(useStore.getState().sessions['u4-s2']!.preview).not.toBe('')
    const preview = useStore.getState().sessions['u4-s2']!.preview

    mock.sessions.get('u4-s2')!.name = 'merge-complete marker'
    mock.setConnectionState('disconnected')
    mock.setConnectionState('connected')
    // The name update is the proof that "the merge actually ran" — preview preservation is checked on top of that
    await vi.waitFor(() => expect(useStore.getState().sessions['u4-s2']!.name).toBe('merge-complete marker'))

    expect(useStore.getState().sessions['u4-s2']!.preview).toBe(preview)
  })

  it('a deleted session that was focused also has its focus released', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('u4-s3', sessionInfo('u4-s3'))
    await useStore.getState().attach(mock)
    useStore.setState({ focusedSessionId: 'u4-s3' })

    mock.sessions.delete('u4-s3')
    mock.setConnectionState('disconnected')
    mock.setConnectionState('connected')

    await vi.waitFor(() => expect(useStore.getState().sessions['u4-s3']).toBeUndefined())
    expect(useStore.getState().focusedSessionId).toBeNull()
  })
})

/*
 * #173: if the socket drops, the client refuses an `agents.send` that never got an answer with
 * `connection_lost`. The host may already have received that message, but the screen used to raise a
 * failure toast and put the text back into the composer — sending it again then sends the same
 * instruction twice.
 */
describe('a message sent at the instant of disconnect (#173)', () => {
  async function sendingWhenTheLineDrops(delivered: boolean) {
    const mock = new MockPlatform()
    mock.sessions.set('cl-1', sessionInfo('cl-1'))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('cl-1')
    await vi.waitFor(() => expect(useStore.getState().history['cl-1']).toBeDefined())
    vi.spyOn(mock.agents, 'send').mockImplementationOnce(async (sessionId, text) => {
      // If the host received and stored it, it is in the store — the confirmation (`user_message`) vanished along with the dropped socket
      if (delivered) mock.messages.set(sessionId, [{ sessionId, seq: 1, role: 'user', kind: 'text', payload: { text }, ts: 1 }])
      mock.setConnectionState('disconnected')
      throw Object.assign(new Error('Connection lost'), { code: 'connection_lost', retryable: true })
    })
    await useStore.getState().send('cl-1', 'DO THE THING')
    return mock
  }

  it('a message the host received is settled after reconnecting — never reported as a failure, never put back', async () => {
    const mock = await sendingWhenTheLineDrops(true)
    // Unknown while disconnected — the bubble stays and the composer is empty
    expect(useStore.getState().chat['cl-1']!.map(line)).toEqual(['DO THE THING'])
    expect(useStore.getState().drafts['cl-1']?.text ?? '').toBe('')

    mock.setConnectionState('connected')
    await vi.waitFor(() => expect(useStore.getState().chat['cl-1']![0]).toMatchObject({ storedSeq: 1 }))
    await new Promise((r) => setTimeout(r, 0))
    const st = useStore.getState()
    expect(st.chat['cl-1']!.map(line)).toEqual(['DO THE THING'])
    expect(st.chat['cl-1']![0]).not.toMatchObject({ pending: true })
    expect(st.drafts['cl-1']?.text ?? '').toBe('')
    expect(st.toast ?? '').not.toContain('Could not send')
  })

  it('a message the host never received is put back into the composer after reconnecting, and the failure is reported', async () => {
    const mock = await sendingWhenTheLineDrops(false)
    mock.setConnectionState('connected')
    await vi.waitFor(() => expect(useStore.getState().drafts['cl-1']?.text).toBe('DO THE THING'))
    const st = useStore.getState()
    expect(st.chat['cl-1']!.map(line)).toEqual([])
    expect(st.toast).toBe('Could not send: Connection lost')
  })
})

/*
 * Linked machines (#82, docs/plans/remote-hub.md). The hub lists another machine's sessions with `machine` set and their
 * ids qualified; while that machine is away it answers from its mirror with `unreachable`. When the machine comes back it
 * sends `machine_resync`, and the UI recovers **that machine alone**: its rows, its open conversations, its wakes.
 */
describe('linked machines (#82)', () => {
  const box = (over: Partial<MachineInfo> = {}): MachineInfo => ({
    id: 'box', name: 'Box', sshTarget: 'me@box', shell: 'posix', wslDistro: null, command: null, status: 'connected',
    error: null, versions: null, lastConnectedAt: null, localPort: null, sameLocalPort: false, hostStarted: null, install: null, operation: null, autostart: null, elevated: null, asks: null, ...over,
  })

  it('machine_status replaces that machine\'s row whole', async () => {
    const mock = new MockPlatform()
    mock.machinesList = [box()]
    await useStore.getState().attach(mock)
    expect(useStore.getState().machines['box']?.status).toBe('connected')
    mock.emit({ type: 'machine_status', machine: box({ status: 'unreachable', error: 'ssh could not reach me@box: timed out' }) })
    expect(useStore.getState().machines['box']).toMatchObject({ status: 'unreachable', error: 'ssh could not reach me@box: timed out' })
  })

  it('an update from here replaces the row with the host’s answer, and a failure is a toast in the host’s words (plan §10.5)', async () => {
    const mock = new MockPlatform()
    const versions = { hub: { version: '2.0.0', protocolVersion: 1, dev: false }, remote: { version: '1.0.0', protocolVersion: 1, dev: false }, older: 'remote' as const, compatible: true, sameChannel: true, accepted: false }
    mock.machinesList = [box({ status: 'versions_differ', versions, install: { managed: true, current: { version: '1.0.0', node: '24' }, previous: null } })]
    await useStore.getState().attach(mock)
    expect(await useStore.getState().changeMachineInstall('box', 'update')).toBe(true)
    expect(useStore.getState().machines['box']).toMatchObject({ status: 'connected', install: { current: { version: '2.0.0' }, previous: { version: '1.0.0' } } })
    expect(await useStore.getState().machineActivity('box')).toMatchObject({ working: 1, terminals: 1 })
    mock.machines.update = async () => {
      throw new Error('Centralu 2.0.0 did not start on box (it did not answer within 30 s); it runs Centralu 1.0.0 again.')
    }
    expect(await useStore.getState().changeMachineInstall('box', 'update')).toBe(false)
    expect(useStore.getState().toast).toBe('Update failed: Centralu 2.0.0 did not start on box (it did not answer within 30 s); it runs Centralu 1.0.0 again.')
  })

  it('start at boot: the row follows what the machine answered, and a refusal is said and changes nothing', async () => {
    const mock = new MockPlatform()
    mock.machinesList = [box({ autostart: { on: false, how: 'systemd', linger: null } })]
    await useStore.getState().attach(mock)
    expect(await useStore.getState().setMachineAutostart('box', true)).toBe(true)
    expect(useStore.getState().machines['box']!.autostart).toEqual({ on: true, how: 'systemd', linger: true })
    mock.machines.autostart = async () => {
      throw new Error('Centralu on box could not stop starting at boot: Failed to connect to bus')
    }
    expect(await useStore.getState().setMachineAutostart('box', false)).toBe(false)
    expect(useStore.getState().toast).toBe('Could not turn off starting at boot: Centralu on box could not stop starting at boot: Failed to connect to bus')
    expect(useStore.getState().machines['box']!.autostart?.on).toBe(true)
  })

  it('a resync re-reads that machine\'s sessions and projects and leaves every other row as it was', async () => {
    const mock = new MockPlatform()
    mock.machinesList = [box()]
    const remote = await mock.projects.add('/srv/app', 'box')
    mock.sessions.set('mr-local', sessionInfo('mr-local'))
    mock.sessions.set('box.mr-a', sessionInfo('box.mr-a', { projectId: remote.id, machine: 'box' }))
    mock.sessions.set('box.mr-gone', sessionInfo('box.mr-gone', { projectId: remote.id, machine: 'box' }))
    await useStore.getState().attach(mock)
    const localBefore = useStore.getState().sessions['mr-local']
    useStore.setState((st) => ({ drafts: { ...st.drafts, 'box.mr-gone': { text: 'unsent', attachments: [] } } }))

    // On the machine: one session renamed, one deleted, one created. Here: a local rename the list would also carry
    mock.sessions.get('box.mr-a')!.name = 'renamed there'
    mock.sessions.delete('box.mr-gone')
    mock.sessions.set('box.mr-new', sessionInfo('box.mr-new', { projectId: remote.id, machine: 'box' }))
    mock.sessions.get('mr-local')!.name = 'renamed here, not announced'
    mock.emit({ type: 'machine_resync', machineId: 'box' })

    await vi.waitFor(() => expect(useStore.getState().sessions['box.mr-new']).toBeDefined())
    const s = useStore.getState().sessions
    expect(s['box.mr-a']!.name).toBe('renamed there')
    expect(s['box.mr-gone']).toBeUndefined()
    // What the deleted one held goes with it, as `session_deleted` would clear it (#163)
    expect(useStore.getState().drafts['box.mr-gone']).toBeUndefined()
    // Scoped: this computer's row is the very same object, not merged from the fresh list
    expect(s['mr-local']).toBe(localBefore)
    expect(useStore.getState().projects[remote.id]?.machine).toBe('box')
  })

  it('a resync keeps that machine\'s sessions a live event created or changed while the list was out', async () => {
    const mock = new MockPlatform()
    mock.machinesList = [box()]
    const remote = await mock.projects.add('/srv/app', 'box')
    mock.sessions.set('box.ml-a', sessionInfo('box.ml-a', { projectId: remote.id, machine: 'box' }))
    await useStore.getState().attach(mock)
    const list = holdList(mock)
    mock.emit({ type: 'machine_resync', machineId: 'box' })
    await list.asked

    const born = sessionInfo('box.ml-b', { projectId: remote.id, machine: 'box' })
    mock.emit({ type: 'session_created', sessionId: born.id, session: born } as NormalizedEvent)
    mock.emit({ type: 'approval_request', sessionId: 'box.ml-a', requestId: 'rq-m', detail: { kind: 'command', command: 'make' } } as never)
    list.release()
    await settle()

    const s = useStore.getState().sessions
    expect(s['box.ml-b']).toBeDefined()
    expect(s['box.ml-a']!.pendingApproval).toMatchObject({ requestId: 'rq-m' })
  })

  it('a resync wakes only that machine\'s sessions that were live and are not now', async () => {
    const mock = new MockPlatform()
    mock.machinesList = [box()]
    const remote = await mock.projects.add('/srv/app', 'box')
    mock.sessions.set('mw-local', sessionInfo('mw-local'))
    mock.sessions.set('box.mw-1', sessionInfo('box.mw-1', { projectId: remote.id, machine: 'box' }))
    mock.sessions.set('box.mw-idle', sessionInfo('box.mw-idle', { projectId: remote.id, machine: 'box', live: false }))
    await useStore.getState().attach(mock)
    const resume = vi.spyOn(mock.agents, 'resumeSession')

    // The remote host restarted without a keeper: its processes are gone. This computer's session died too, unannounced
    mock.sessions.get('box.mw-1')!.live = false
    mock.sessions.get('mw-local')!.live = false
    mock.emit({ type: 'machine_resync', machineId: 'box' })

    await vi.waitFor(() => expect(resume).toHaveBeenCalledWith('box.mw-1'))
    expect(resume.mock.calls.map(([id]) => id)).toEqual(['box.mw-1'])
  })

  it('a resync re-reads the open conversations of that machine only', async () => {
    const mock = new MockPlatform()
    mock.machinesList = [box()]
    const remote = await mock.projects.add('/srv/app', 'box')
    mock.sessions.set('mh-local', sessionInfo('mh-local'))
    mock.sessions.set('box.mh-1', sessionInfo('box.mh-1', { projectId: remote.id, machine: 'box' }))
    await useStore.getState().attach(mock)
    await useStore.getState().loadHistory('mh-local')
    await useStore.getState().loadHistory('box.mh-1')
    const load = vi.spyOn(mock.agents, 'loadMessages')

    mock.emit({ type: 'machine_resync', machineId: 'box' })

    await vi.waitFor(() => expect(load).toHaveBeenCalledWith('box.mh-1', expect.anything()))
    expect(load.mock.calls.map(([id]) => id)).not.toContain('mh-local')
  })

  it('a session of a machine that is away is never woken, not by focus and not by the reconnect recovery', async () => {
    const mock = new MockPlatform()
    mock.machinesList = [box({ status: 'unreachable' })]
    const remote = await mock.projects.add('/srv/app', 'box')
    // Listed from the hub's mirror: last heard dormant
    mock.sessions.set('box.ma-1', sessionInfo('box.ma-1', { projectId: remote.id, machine: 'box', live: false, unreachable: true }))
    mock.sessions.set('box.ma-2', sessionInfo('box.ma-2', { projectId: remote.id, machine: 'box', live: true }))
    await useStore.getState().attach(mock)
    const resume = vi.spyOn(mock.agents, 'resumeSession')

    useStore.getState().focusSession('box.ma-1')
    await useStore.getState().wake('box.ma-1')
    // The UI's own socket drops and comes back; the mirror still says ma-2 was live, but not that it is now
    mock.sessions.get('box.ma-2')!.live = false
    mock.sessions.get('box.ma-2')!.unreachable = true
    mock.setConnectionState('disconnected')
    mock.setConnectionState('connected')
    await vi.waitFor(() => expect(useStore.getState().sessions['box.ma-2']!.unreachable).toBe(true))
    await new Promise((r) => setTimeout(r, 20))

    expect(resume).not.toHaveBeenCalled()
  })

  it('a machine_status that arrives before the answer to machines.add is not overwritten by that answer', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    // The hub answers `connecting`, but its version check has already broadcast `versions_differ` (measured in e2e)
    vi.spyOn(mock.machines, 'add').mockImplementation(async () => {
      mock.emit({ type: 'machine_status', machine: box({ status: 'versions_differ', error: 'Box runs Centralu 0.1.0' }) })
      return box({ status: 'connecting' })
    })
    await useStore.getState().addMachine({ name: 'Box', sshTarget: 'me@box', shell: 'posix' })
    expect(useStore.getState().machines['box']?.status).toBe('versions_differ')
  })

  it('a project added on a machine is asked of that machine', async () => {
    const mock = new MockPlatform()
    mock.machinesList = [box()]
    await useStore.getState().attach(mock)
    const add = vi.spyOn(mock.projects, 'add')
    const p = await useStore.getState().addProject('/srv/other', 'box')
    expect(add).toHaveBeenCalledWith('/srv/other', 'box')
    expect(useStore.getState().projects[p.id]?.machine).toBe('box')
  })
})

/*
 * Last in the file: it replays thousands of events, and the render keys they take are module state that the
 * #79 cursor tests above measure from.
 */
describe('the pen for events before registration is bounded (#392)', () => {
  const call = (sessionId: string, i: number) =>
    ({ sessionId, type: 'tool_call', callId: `c${i}`, summary: { tool: 'Read', title: `read ${i}` } }) as NormalizedEvent

  it('holds at most PENDING_EVENTS_MAX events for one session, the newest, at every count around the cap', async () => {
    for (const n of [1, PENDING_EVENTS_MAX - 1, PENDING_EVENTS_MAX, PENDING_EVENTS_MAX + 1, 2 * PENDING_EVENTS_MAX + 1]) {
      const id = `pen-cap-${n}`
      for (let i = 1; i <= n; i++) useStore.getState().dispatchEvent(call(id, i))
      const mock = new MockPlatform()
      mock.sessions.set(id, sessionInfo(id))
      await useStore.getState().attach(mock)
      const rows = useStore.getState().chat[id]!.map(line)
      expect(rows.length).toBeLessThanOrEqual(PENDING_EVENTS_MAX)
      // Under the cap nothing is lost
      if (n <= PENDING_EVENTS_MAX) expect(rows.length).toBe(n)
      expect(rows.at(-1)).toBe(`read ${n}`)
    }
  })

  it('lets go of the events of a session that has not registered after ten minutes', async () => {
    const now = vi.spyOn(Date, 'now')
    try {
      now.mockReturnValue(1_000_000)
      // A late event for a session already deleted, or one the list never carries
      useStore.getState().dispatchEvent(call('pen-never', 1))
      now.mockReturnValue(1_000_000 + PENDING_EVENTS_MAX_AGE_MS + 1)
      useStore.getState().dispatchEvent(call('pen-later', 1))
    } finally {
      now.mockRestore()
    }
    const mock = new MockPlatform()
    mock.sessions.set('pen-never', sessionInfo('pen-never'))
    mock.sessions.set('pen-later', sessionInfo('pen-later'))
    await useStore.getState().attach(mock)
    expect(useStore.getState().chat['pen-never']).toBeUndefined()
    // A pen still inside the window is replayed as before
    expect(useStore.getState().chat['pen-later']!.map(line)).toEqual(['read 1'])
  })
})

describe('markRead offline (#842 item 14)', () => {
  it('a mark the host refuses resolves, says so, and the session stays unread', async () => {
    const platform = new MockPlatform()
    vi.spyOn(platform.agents, 'markRead').mockRejectedValue(new Error('offline'))
    useStore.setState({ platform, sessions: { m: sessionInfo('m', { lastSeq: 4, lastReadSeq: 1 }) as never } })

    await expect(useStore.getState().markRead('m')).resolves.toBeUndefined()
    expect(useStore.getState().sessions.m!.lastReadSeq).toBe(1)
    // Said, so a Done that changed nothing is not a mystery
    expect(useStore.getState().toast).toContain('offline')
  })
})
