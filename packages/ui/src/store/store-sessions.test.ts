/**
 * Store regression tests: sessions: their facts, waking, deleting and the session archive.
 *
 * Ports go through `MockPlatform` (no ad-hoc mocking, or the contract falls apart). The
 * `pendingEvents` holding pen is module state, so it cannot be cleared between tests — each test
 * uses a different session id instead. Shared fixtures are in store.test-helpers.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent, SessionInfo } from '@cc/protocol'
import { sessionGridPanel } from '@cc/core'
// eslint-disable-next-line no-restricted-imports -- the runtime ui knows only ports, but tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import { newSessionProjectOf, useStore } from './store.js'
import { resetStore, sessionInfo } from './store.test-helpers.js'
import { archiveAsksOf, archiveNeedsAsk } from './sessions/lifecycle.js'

beforeEach(resetStore)

/*
 * The while-alive facts (approval, questions, activity, limit, usage) have the host's memory as their
 * source of truth. If the value carried in the list on reconnect or restart is not inherited, a
 * session can sit at state=waiting_approval with no card payload, and the approval never appears on
 * screen (measured after a restart).
 */
describe('inheriting while-alive facts', () => {
  const approval = {
    requestId: 'req-9',
    detail: { kind: 'command' as const, command: 'rm -rf node_modules', cwd: '/tmp' },
  }

  it('attach carries the host\'s pendingApproval into the session summary', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('lf-s1', sessionInfo('lf-s1', { state: 'waiting_approval', pendingApproval: approval }))

    await useStore.getState().attach(mock)

    const s = useStore.getState().sessions['lf-s1']!
    expect(s.state).toBe('waiting_approval')
    expect(s.pendingApproval).toEqual(approval)
  })

  it('the reconnect merge treats the host\'s approval state as the source of truth — a resolved one is cleared', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('lf-s2', sessionInfo('lf-s2', { state: 'waiting_approval', pendingApproval: approval }))
    await useStore.getState().attach(mock)
    expect(useStore.getState().sessions['lf-s2']!.pendingApproval).toEqual(approval)

    // The approval was resolved from another window while disconnected — it is no longer in the host's list
    const resolved = { ...mock.sessions.get('lf-s2')!, state: 'idle' as const, pendingApproval: null }
    mock.sessions.set('lf-s2', resolved)
    mock.setConnectionState('disconnected')
    mock.setConnectionState('connected')

    await vi.waitFor(() => expect(useStore.getState().sessions['lf-s2']!.pendingApproval).toBeNull())
  })
})

/*
 * Settings survive a restart on screen, not only in the database (issue #37).
 *
 * Reported as "model, effort and permissions do not save": the database held the chosen
 * values the whole time and the host read them back, but the store's cold-start path took
 * only `effort` off the list and let initialSession's defaults fill the rest — so the button
 * under the composer said "Default · Normal" and every restart looked like a loss.
 * A stored value must come from the session, never from what the startup path bothered to
 * name, so this checks all of them at once.
 */
describe('inheriting stored session settings (issue #37)', () => {
  const stored = {
    model: 'claude-fable-5[1m]',
    effort: 'high',
    permissionPreset: 'auto' as const,
    worktree: { path: '/tmp/wt/feature', branch: 'feature' },
  }

  it('reopening the app leaves the model, effort, permissions and worktree the host gave untouched', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('ss-s1', sessionInfo('ss-s1', stored))

    await useStore.getState().attach(mock)

    expect(useStore.getState().sessions['ss-s1']).toMatchObject(stored)
  })

  it('the reconnect merge yields the same values — both paths build the same summary', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)

    // A session created in another window while disconnected — the merge registers it for the first time
    mock.sessions.set('ss-s2', sessionInfo('ss-s2', stored))
    mock.setConnectionState('disconnected')
    mock.setConnectionState('connected')

    await vi.waitFor(() => expect(useStore.getState().sessions['ss-s2']).toMatchObject(stored))
  })
})

/*
 * A rename must never fail while only the screen reports success (issue #5). This store has been
 * burned by this class of bug more than once, so a failure must always surface where a person can see
 * it (a toast).
 */
describe('renaming a session (issue #5)', () => {
  it('a success changes the name and locks auto-naming', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('rn-s1', sessionInfo('rn-s1'))
    await useStore.getState().attach(mock)

    await useStore.getState().rename('rn-s1', '  Guard MCP  ')

    expect(useStore.getState().sessions['rn-s1']).toMatchObject({ name: 'Guard MCP', autoNamed: false })
    expect(useStore.getState().toast).toBeNull()
  })

  it('a failure leaves the name untouched and reports it as a toast', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('rn-s2', sessionInfo('rn-s2', { name: 'old name' }))
    await useStore.getState().attach(mock)
    // The host refuses — the actual path is renaming after the session has already disappeared
    mock.sessions.delete('rn-s2')

    await useStore.getState().rename('rn-s2', 'new name')

    expect(useStore.getState().sessions['rn-s2']!.name).toBe('old name')
    expect(useStore.getState().toast).toMatch(/Could not rename/)
  })

  it('an empty name is never sent, and is reported right there', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('rn-s3', sessionInfo('rn-s3', { name: 'old name' }))
    await useStore.getState().attach(mock)

    await useStore.getState().rename('rn-s3', '   ')

    expect(useStore.getState().sessions['rn-s3']!.name).toBe('old name')
    expect(useStore.getState().toast).toMatch(/empty/i)
  })
})

describe('wake — silently waking along the focus path', () => {
  it('wakes a sleeping session and marks it live', async () => {
    const platform = new MockPlatform()
    const s = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'normal' })
    useStore.setState({ platform, sessions: { [s.id]: { ...s, live: false } as never } })

    await useStore.getState().wake(s.id)
    expect(useStore.getState().sessions[s.id]?.live).toBe(true)
    expect(useStore.getState().toast).toBeNull()
  })

  it('a wake failure is left in wakeError, not raised as a toast', async () => {
    const platform = new MockPlatform()
    const s = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'normal' })
    platform.unresumable.add(s.id)
    useStore.setState({ platform, sessions: { [s.id]: { ...s, live: false } as never } })

    await useStore.getState().wake(s.id)
    expect(useStore.getState().toast).toBeNull()
    expect(useStore.getState().sessions[s.id]?.live).toBe(false)
    expect(useStore.getState().wakeError[s.id]).toBeTruthy()
  })

  it('does nothing at all if it is already alive', async () => {
    const platform = new MockPlatform()
    const s = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'normal' })
    const spy = vi.spyOn(platform.agents, 'resumeSession')
    useStore.setState({ platform, sessions: { [s.id]: { ...s, live: true } as never } })

    await useStore.getState().wake(s.id)
    expect(spy).not.toHaveBeenCalled()
  })
})

/**
 * Sleeping sessions are woken by use, not by being seen (#568). The host puts idle sessions to sleep after 15 minutes;
 * waking every grid panel at startup, or every session the person clicks through, would start processes nobody types
 * to. Before #568 the grid's panels were woken one by one as the app came up, and selecting a session woke it.
 */
describe('waking a sleeping session (#568)', () => {
  it('the grid\'s sleeping panels stay asleep when the app comes up', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('warm-a', sessionInfo('warm-a', { live: false }))
    mock.sessions.set('warm-b', sessionInfo('warm-b', { live: false }))
    await mock.agents.setGridView(['warm-a', 'warm-b'].map(sessionGridPanel))
    await useStore.getState().attach(mock)
    await new Promise((r) => setTimeout(r, 50))
    expect(mock.resumeCalls).toEqual([])
    expect(useStore.getState().sessions['warm-a']!.live).toBe(false)
  })

  it('selecting a sleeping session shows it without waking it; its composer taking the keyboard does (wake)', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('nap', sessionInfo('nap', { live: false }))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('nap')
    await new Promise((r) => setTimeout(r, 50))
    expect(mock.resumeCalls).toEqual([])
    await useStore.getState().wake('nap')
    expect(mock.resumeCalls).toEqual(['nap'])
    expect(useStore.getState().sessions['nap']!.live).toBe(true)
  })

  it('a message to a sleeping session reads as waking until the host has resumed it, then live', async () => {
    const mock = new MockPlatform()
    mock.wakeDelayMs = 60
    mock.sessions.set('nap', sessionInfo('nap', { live: false }))
    await useStore.getState().attach(mock)
    const sent = useStore.getState().send('nap', 'hello again')
    expect(useStore.getState().resuming['nap']).toBe(true)
    await sent
    expect(useStore.getState().resuming['nap']).toBeUndefined()
    expect(useStore.getState().sessions['nap']!.live).toBe(true)
  })

  it('the host putting a session to sleep, or waking it for someone else, reaches every window', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('s', sessionInfo('s'))
    await useStore.getState().attach(mock)
    mock.emit({ type: 'session_live', sessionId: 's', live: false, reason: 'asleep' })
    await vi.waitFor(() => expect(useStore.getState().sessions['s']!.live).toBe(false))
    mock.emit({ type: 'session_live', sessionId: 's', live: true })
    await vi.waitFor(() => expect(useStore.getState().sessions['s']!.live).toBe(true))
  })
})

describe('the command run ledger (#60, moved into the terminal panel)', () => {
  it('runCommand records a run under its project and command, and an exit event records the outcome', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const p = await useStore.getState().addProject('/tmp/cmd')

    await useStore.getState().runCommand(p.id, 'pnpm dev')
    let r = useStore.getState().commandRuns[p.id]!['pnpm dev']!
    expect(r.running).toBe(true)

    // The dev server dies — the runId rides in the terminalId slot and the exit arrives
    mock.exitCommand(p.id, 'pnpm dev', 1)
    r = useStore.getState().commandRuns[p.id]!['pnpm dev']!
    expect(r.running).toBe(false)
    expect(r.exitCode).toBe(1)
  })

  it('a shell terminal\'s exit never touches the ledger — only a known runId is recorded as an outcome', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const p = await useStore.getState().addProject('/tmp/cmd2')
    await useStore.getState().runCommand(p.id, 'pnpm dev')

    // An unknown terminalId (a shell terminal dying)
    mock.emitTerminalExit('shell-1', 0)
    expect(useStore.getState().commandRuns[p.id]!['pnpm dev']!.running).toBe(true)

    // A **known** runId arriving through the same channel records the outcome — proof that the ignore above is not empty
    mock.emitTerminalExit(useStore.getState().commandRuns[p.id]!['pnpm dev']!.runId, 0)
    expect(useStore.getState().commandRuns[p.id]!['pnpm dev']!.running).toBe(false)
  })

  it('loadCommandRuns projects the host\'s ledger — a running command stays visible even after a UI reload', async () => {
    const mock = new MockPlatform()
    // A run already running on the host, unbeknownst to the UI (the store)
    const p0 = await mock.projects.add('/tmp/cmd3')
    await mock.commands.run(p0.id, 'pnpm dev', 80, 24)

    await useStore.getState().attach(mock)
    expect(useStore.getState().commandRuns[p0.id]).toBeUndefined()
    await useStore.getState().loadCommandRuns(p0.id)
    expect(useStore.getState().commandRuns[p0.id]!['pnpm dev']!.running).toBe(true)
  })

  // #841 item 11: runCommand toasted a failure and stopCommand swallowed it
  it('a stop that fails says so, as a run that fails does', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const p = await useStore.getState().addProject('/tmp/cmd-stop-fail')
    mock.commands.stop = async () => {
      throw new Error('the process is gone')
    }
    await useStore.getState().stopCommand(p.id, 'pnpm dev')
    expect(useStore.getState().toast).toBe('Could not stop: the process is gone')
  })

  it('stopCommand\'s outcome also comes back as an exit event (130 = the SIGINT convention)', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const p = await useStore.getState().addProject('/tmp/cmd4')
    await useStore.getState().runCommand(p.id, 'pnpm dev')

    await useStore.getState().stopCommand(p.id, 'pnpm dev')
    const r = useStore.getState().commandRuns[p.id]!['pnpm dev']!
    expect(r.running).toBe(false)
    expect(r.exitCode).toBe(130)
  })
})

/**
 * A session deleted while awaited (#163). A post-await `set` spreading `{ ...s.sessions[id]!, … }`
 * revived a nearly empty row if `session_deleted` arrived in that window — code that iterates every
 * session broke on that row.
 */
describe('a session deleted while awaited is never revived (#163)', () => {
  function stalled<T>() {
    let resolve!: (v: T) => void
    const p = new Promise<T>((r) => (resolve = r))
    return { p, resolve }
  }

  it('if deleted while waking, the wake response never recreates the row', async () => {
    const platform = new MockPlatform()
    const s = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'normal' })
    const wake = stalled<{ session: SessionInfo; resumed: boolean; reason?: string }>()
    vi.spyOn(platform.agents, 'resumeSession').mockReturnValue(wake.p as never)
    useStore.setState({ platform, sessions: { [s.id]: { ...s, live: false } as never } })

    const waking = useStore.getState().wake(s.id)
    useStore.getState().dispatchEvent({ type: 'session_deleted', sessionId: s.id } as NormalizedEvent)
    wake.resolve({ session: s, resumed: false, reason: 'The session was deleted while waking' })
    await waking

    expect(useStore.getState().sessions[s.id]).toBeUndefined()
    expect(useStore.getState().wakeError[s.id]).toBeUndefined()
  })

  it('a deletion while waiting for the mark-as-read call never throws and never creates a row', async () => {
    const platform = new MockPlatform()
    const s = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'normal' })
    const mark = stalled<void>()
    vi.spyOn(platform.agents, 'markRead').mockReturnValue(mark.p as never)
    useStore.setState({ platform, sessions: { [s.id]: { ...s, lastSeq: 5, lastReadSeq: 0 } as never } })

    const marking = useStore.getState().markRead(s.id)
    useStore.getState().dispatchEvent({ type: 'session_deleted', sessionId: s.id } as NormalizedEvent)
    mark.resolve()
    await marking

    expect(useStore.getState().sessions[s.id]).toBeUndefined()
  })

  it('a deleted session\'s notification card and per-session baggage disappear along with it', () => {
    const id = 'del-163'
    useStore.setState({
      sessions: { [id]: { ...sessionInfo(id) } as never },
      notices: [{ sessionId: id, kind: 'done', name: id, at: 1 }, { sessionId: 'other', kind: 'done', name: 'other', at: 2 }],
      history: { [id]: { oldestSeq: 1, more: false, loading: false } },
      drafts: { [id]: { text: 'text being written' } as never },
      stickToBottom: { [id]: true },
      wakeError: { [id]: 'x' },
      wakeLocked: { [id]: true },
    })
    useStore.getState().dispatchEvent({ type: 'session_deleted', sessionId: id } as NormalizedEvent)

    const st = useStore.getState()
    expect(st.notices.map((n) => n.sessionId)).toEqual(['other'])
    expect([st.history[id], st.drafts[id], st.stickToBottom[id], st.wakeError[id], st.wakeLocked[id]]).toEqual([
      undefined, undefined, undefined, undefined, undefined,
    ])
  })

  // #378 review: the host deletes an app's agent session once its run is over, and the draft went with it
  it('a draft with words in it survives its session\'s deletion, to be copied', () => {
    const id = 'del-draft-378'
    useStore.setState({
      sessions: { [id]: { ...sessionInfo(id, { name: 'Notes · agent 10:02', appId: 'notes' }) } as never, empty: { ...sessionInfo('empty') } as never },
      drafts: { [id]: { text: 'and also check the\nsecond list', attachments: [] }, empty: { text: '   ', attachments: [] } },
    })
    useStore.getState().dispatchEvent({ type: 'session_deleted', sessionId: id } as NormalizedEvent)
    useStore.getState().dispatchEvent({ type: 'session_deleted', sessionId: 'empty' } as NormalizedEvent)

    expect(useStore.getState().drafts[id]).toBeUndefined()
    expect(useStore.getState().keptDrafts).toEqual([{ sessionId: id, name: 'Notes · agent 10:02', text: 'and also check the\nsecond list' }])
    useStore.getState().dismissKeptDraft(id)
    expect(useStore.getState().keptDrafts).toEqual([])
  })

  it('a message that failed to send and went back to the draft survives the session\'s deletion', async () => {
    const s = 'del-sent-378'
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s, { appId: 'notes' }))
    await useStore.getState().attach(mock)
    vi.spyOn(mock.agents, 'send').mockRejectedValue(new Error('The session was deleted'))

    await useStore.getState().send(s, 'a sentence that must not be lost')
    expect(useStore.getState().drafts[s]?.text).toBe('a sentence that must not be lost')
    useStore.getState().dispatchEvent({ type: 'session_deleted', sessionId: s } as NormalizedEvent)

    expect(useStore.getState().keptDrafts.map((d) => d.text)).toEqual(['a sentence that must not be lost'])
  })
})

/*
 * An app's agent session the person opens stays theirs (#378 review). The host hears "opened" through markRead, which
 * the window skipped with nothing unread: the app's request is read as it arrives, so a fresh app-agent session opened
 * that way told the host nothing, and a short run deleted it under the person's eyes.
 */
describe('an app-agent session on screen', () => {
  it('tells the host it is open even with nothing unread, without moving the read position', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('open-378', sessionInfo('open-378', { appId: 'notes', lastSeq: 1, lastReadSeq: 1 }))
    mock.sessions.set('plain-378', sessionInfo('plain-378', { lastSeq: 1, lastReadSeq: 1 }))
    await useStore.getState().attach(mock)
    const marked = vi.spyOn(mock.agents, 'markRead')

    await useStore.getState().markOpened('open-378')
    await useStore.getState().markOpened('plain-378')

    expect(marked.mock.calls).toEqual([['open-378', 1]])
  })
})

/*
 * A lock found after a slow background resume had already handed the session back (#168, item 5).
 * It used to arrive as adapter_crashed: the session stayed "live" on screen and the fork offer,
 * drawn only from the wake result, never appeared.
 */
describe('a late lock error offers the fork (#168)', () => {
  it('the session turns dormant with the reason and the fork offer, and the marker does not speak of a turn', () => {
    const id = 'late-lock-168'
    useStore.setState({ sessions: { [id]: { ...sessionInfo(id), live: true } as never }, chat: {}, wakeError: {}, wakeLocked: {} })
    useStore.getState().dispatchEvent({
      type: 'error',
      sessionId: id,
      seq: 7,
      error: { code: 'conversation_locked', message: 'This conversation is already open elsewhere', retryable: true },
    } as NormalizedEvent)

    const st = useStore.getState()
    expect(st.sessions[id]!.live).toBe(false)
    expect(st.wakeLocked[id]).toBe(true)
    expect(st.wakeError[id]).toBe('This conversation is already open elsewhere')
    expect(st.chat[id]!.map((i) => (i as { text?: string }).text)).toEqual([
      'Could not open this conversation — This conversation is already open elsewhere',
    ])
  })

  it('any other error leaves the session live and offers no fork', () => {
    const id = 'other-error-168'
    useStore.setState({ sessions: { [id]: { ...sessionInfo(id), live: true } as never }, chat: {}, wakeError: {}, wakeLocked: {} })
    useStore.getState().dispatchEvent({
      type: 'error',
      sessionId: id,
      seq: 3,
      error: { code: 'internal', message: 'boom', retryable: true },
    } as NormalizedEvent)

    const st = useStore.getState()
    expect(st.sessions[id]!.live).toBe(true)
    expect(st.wakeLocked[id]).toBeUndefined()
  })
})

/*
 * A newer host's session (#384). `sessions.list` reads it tolerantly (`parseTolerant`): a value this build does not
 * know costs that value only. `session_created`, the only word about a session the host made on its own, parsed it
 * strictly, so one new word left the session out of the sidebar until a reconnect listed it.
 */
describe('a session a newer host created', () => {
  it('is added from session_created even with a value this build does not know, as the session list would', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const newer = { ...sessionInfo('newer-made'), permissionPreset: 'plan-only', laterField: { a: 1 } }
    useStore.getState().dispatchEvent({ type: 'session_created', sessionId: newer.id, session: newer } as unknown as NormalizedEvent)
    expect(useStore.getState().sessions['newer-made']).toMatchObject({ id: 'newer-made', name: newer.name })
  })

  it('is not added from a session_created that carries no session', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    useStore.getState().dispatchEvent({ type: 'session_created', sessionId: 'no-record', session: 'not a session' } as unknown as NormalizedEvent)
    expect(useStore.getState().sessions['no-record']).toBeUndefined()
  })
})

/*
 * A handoff moves the original's live children to the session that took over (#693); the host says so with
 * `session_owner`, and the sidebar hangs the child under its new owner without waiting for a reconnect.
 */
describe('a child that changed owner (#693)', () => {
  it('takes the owner the host names', async () => {
    const mock = new MockPlatform()
    const p = await mock.projects.add('/tmp/owner-a')
    await useStore.getState().attach(mock)
    const child = await mock.agents.createSession({ projectId: p.id, cwd: p.path, tool: 'claude', permissionPreset: 'normal' })
    useStore.getState().dispatchEvent({ type: 'session_created', sessionId: child.id, session: child } as NormalizedEvent)
    useStore.setState((st) => ({ sessions: { ...st.sessions, [child.id]: { ...st.sessions[child.id]!, askedBy: 'old-parent', parentSessionId: 'old-parent' } } }))
    expect(useStore.getState().sessions[child.id]).toMatchObject({ askedBy: 'old-parent', parentSessionId: 'old-parent' })
    useStore.getState().dispatchEvent({ type: 'session_owner', sessionId: child.id, askedBy: 'heir', parentSessionId: null } as NormalizedEvent)
    expect(useStore.getState().sessions[child.id]).toMatchObject({ askedBy: 'heir', parentSessionId: null })
    // A session this window does not know is not created by it
    useStore.getState().dispatchEvent({ type: 'session_owner', sessionId: 'unknown', askedBy: 'heir', parentSessionId: null } as NormalizedEvent)
    expect(useStore.getState().sessions.unknown).toBeUndefined()
  })
})

/*
 * A session the host moved into a project (#1141: a user-folder app's builder, once its folder became a project) is
 * said again with session_created; a window that holds it moves it, and keeps the rest of its row as it had it.
 */
describe('a session moved into a project (#1141)', () => {
  it('session_created for a session this window holds takes its new project and nothing else', async () => {
    const mock = new MockPlatform()
    const p = await mock.projects.add('/tmp/app-project')
    await useStore.getState().attach(mock)
    const s = await mock.agents.createSession({ projectId: p.id, cwd: p.path, tool: 'claude', permissionPreset: 'normal' })
    useStore.getState().dispatchEvent({ type: 'session_created', sessionId: s.id, session: { ...s, projectId: null } } as NormalizedEvent)
    useStore.setState((st) => ({ sessions: { ...st.sessions, [s.id]: { ...st.sessions[s.id]!, projectId: null, name: 'Mine · builder' } } }))
    useStore.getState().dispatchEvent({ type: 'session_created', sessionId: s.id, session: { ...s, name: 'From the host' } } as NormalizedEvent)
    expect(useStore.getState().sessions[s.id]).toMatchObject({ projectId: p.id, name: 'Mine · builder' })
  })
})

/*
 * The session archive (#204) from the screen's side. Deleting says where the session went; restoring puts it back in the
 * sidebar, and a project its restore registered again arrives with it — the screen has not heard of that project,
 * and a session row under a project the sidebar does not have is drawn nowhere.
 */
describe('the session archive (#204)', () => {
  it('deleting says where the session went, and restoring brings it and its registered project back', async () => {
    const mock = new MockPlatform()
    const p = await mock.projects.add('/tmp/trash-a')
    await useStore.getState().attach(mock)
    const s = await mock.agents.createSession({ projectId: p.id, cwd: p.path, tool: 'claude', permissionPreset: 'normal' })
    useStore.getState().dispatchEvent({ type: 'session_created', sessionId: s.id, session: s } as NormalizedEvent)

    await useStore.getState().deleteSession(s.id)
    expect(useStore.getState().sessions[s.id]).toBeUndefined()
    expect(useStore.getState().toast).toBe(`Archived ${s.name} · Settings → Archive keeps it`)
    expect(useStore.getState().toastAction?.label).toBe('Undo')

    await mock.projects.remove(p.id)
    useStore.setState((st) => ({ projects: Object.fromEntries(Object.entries(st.projects).filter(([id]) => id !== p.id)) }))
    expect(await useStore.getState().restoreFromTrash(s.id)).toBeNull()
    const st = useStore.getState()
    expect(st.projects[p.id]?.path).toBe('/tmp/trash-a')
    expect(st.sessions[s.id]?.projectId).toBe(p.id)
    // Registered again is added again: it is asked about trust as a new project is
    expect(st.trustAsk).toBe(p.id)
    expect(await useStore.getState().restoreFromTrash(s.id)).toMatch(/Not in the session archive/)
  })
})

describe('Undo on the archive toast (#1512)', () => {
  it('brings the archived session back, and the next toast does not carry the old Undo', async () => {
    const mock = new MockPlatform()
    const p = await mock.projects.add('/tmp/undo-a')
    await useStore.getState().attach(mock)
    const s = await mock.agents.createSession({ projectId: p.id, cwd: p.path, tool: 'claude', permissionPreset: 'normal' })
    useStore.getState().dispatchEvent({ type: 'session_created', sessionId: s.id, session: s })

    await useStore.getState().deleteSession(s.id, false, true)
    expect(useStore.getState().sessions[s.id]).toBeUndefined()
    useStore.getState().toastAction?.run()
    await vi.waitFor(() => expect(useStore.getState().sessions[s.id]).toBeDefined())
    expect(useStore.getState().toast).toBe(`Restored: ${s.name}`)
    // Restored has no Undo of its own: a toast says its own action or none
    expect(useStore.getState().toastAction).toBeNull()
  })

  it('says nothing of Undo when a toast is said with no action, and clears it when put away', () => {
    useStore.getState().setToast('Archived x', { label: 'Undo', run: () => {} })
    expect(useStore.getState().toastAction?.label).toBe('Undo')
    useStore.getState().setToast('Could not do that')
    expect(useStore.getState().toastAction).toBeNull()
    useStore.getState().setToast('Archived y', { label: 'Undo', run: () => {} })
    useStore.getState().setToast(null)
    expect(useStore.getState().toastAction).toBeNull()
  })

  it('asks first only for a session the archive would cut short', () => {
    const idle = { state: 'idle', pendingApproval: null, pendingQuestions: [], backgroundTasks: [] } as const
    expect(archiveNeedsAsk(idle as never)).toBe(false)
    expect(archiveNeedsAsk({ ...idle, state: 'working' } as never)).toBe(true)
    expect(archiveNeedsAsk({ ...idle, pendingApproval: { requestId: 'r', detail: {} } } as never)).toBe(true)
    expect(archiveNeedsAsk({ ...idle, pendingQuestions: [{ requestId: 'q', questions: [] }] } as never)).toBe(true)
    expect(archiveNeedsAsk({ ...idle, backgroundTasks: [{ id: 'dev', kind: 'shell', description: 'npm run dev', status: 'running' }] } as never)).toBe(true)
    expect(archiveNeedsAsk({ ...idle, backgroundTasks: [{ id: 'dev', kind: 'shell', description: 'npm run dev', status: 'completed' }] } as never)).toBe(false)
    // What only the host knows (a report owed, a wait on it, a mail thread) is not read here: archiveSession asks the host
    expect(archiveNeedsAsk({ ...idle, askedBy: 'orchestrator-1' } as never)).toBe(false)
  })

  async function oneSession(path: string) {
    const mock = new MockPlatform()
    const p = await mock.projects.add(path)
    await useStore.getState().attach(mock)
    const s = await mock.agents.createSession({ projectId: p.id, cwd: p.path, tool: 'claude', permissionPreset: 'normal' })
    useStore.getState().dispatchEvent({ type: 'session_created', sessionId: s.id, session: s })
    return { mock, p, s }
  }

  it('archives an idle session at once when the host finds nothing it holds would be lost', async () => {
    const { s } = await oneSession('/tmp/undo-host-a')
    expect(await useStore.getState().archiveSession(s.id)).toBeNull()
    expect(useStore.getState().sessions[s.id]).toBeUndefined()
    expect(useStore.getState().toastAction?.label).toBe('Undo')
  })

  it('asks instead when the host says the archive would lose something, and archives nothing', async () => {
    const { mock, s } = await oneSession('/tmp/undo-host-b')
    const lines = ['A session it started owes it a report; it will not be told, and the report is dropped.']
    vi.spyOn(mock.agents, 'archiveIfAtRest').mockResolvedValue({ archived: false, asks: lines })
    expect(await useStore.getState().archiveSession(s.id)).toEqual(lines)
    expect(archiveAsksOf(s.id)).toEqual(lines)
    expect(useStore.getState().sessions[s.id]).toBeDefined()
    expect(useStore.getState().toast).toBeNull()
  })

  it('asks first of a host that predates the check, and when the window itself sees a reason', async () => {
    const { mock, s } = await oneSession('/tmp/undo-host-c')
    vi.spyOn(mock.agents, 'archiveIfAtRest').mockRejectedValue(new Error('Unknown method: agents.archiveIfAtRest'))
    expect(await useStore.getState().archiveSession(s.id)).toEqual([])
    expect(useStore.getState().sessions[s.id]).toBeDefined()
    useStore.setState((st) => ({ sessions: { ...st.sessions, [s.id]: { ...st.sessions[s.id]!, state: 'working' } } }))
    const asked = vi.spyOn(mock.agents, 'archiveIfAtRest')
    asked.mockClear()
    expect(await useStore.getState().archiveSession(s.id)).toEqual([])
    expect(asked).not.toHaveBeenCalled()
  })

  it('asks for a worktree with uncommitted changes, which the old dialog showed', async () => {
    const { mock, s } = await oneSession('/tmp/undo-host-d')
    useStore.setState((st) => ({ sessions: { ...st.sessions, [s.id]: { ...st.sessions[s.id]!, worktree: { path: '/tmp/wt', branch: 'b' } } } }))
    vi.spyOn(mock.agents, 'worktreeStatus').mockResolvedValue({ path: '/tmp/wt', branch: 'b', dirty: true, changedFiles: 2 })
    expect(await useStore.getState().archiveSession(s.id)).toEqual([])
    expect(useStore.getState().sessions[s.id]).toBeDefined()
  })

  it('Undo puts the unsent draft back in the composer and the session back in its place in the grid', async () => {
    const { mock, p, s } = await oneSession('/tmp/undo-place')
    const other = await mock.agents.createSession({ projectId: p.id, cwd: p.path, tool: 'claude', permissionPreset: 'normal' })
    useStore.getState().dispatchEvent({ type: 'session_created', sessionId: other.id, session: other })
    const panels = [`session:${other.id}`, `session:${s.id}`, 'app:x']
    useStore.setState((st) => ({
      drafts: { ...st.drafts, [s.id]: { text: 'half a sentence', attachments: [] } },
      projectPanels: { ...st.projectPanels, [p.id]: { panels, order: panels, hidden: [] } },
    }))

    expect(await useStore.getState().archiveSession(s.id)).toBeNull()
    expect(useStore.getState().drafts[s.id]).toBeUndefined()
    expect(useStore.getState().projectPanels[p.id]?.panels).toEqual([`session:${other.id}`, 'app:x'])

    useStore.getState().toastAction?.run()
    await vi.waitFor(() => expect(useStore.getState().sessions[s.id]).toBeDefined())
    await vi.waitFor(() => expect(useStore.getState().drafts[s.id]?.text).toBe('half a sentence'))
    expect(useStore.getState().keptDrafts.some((d) => d.sessionId === s.id)).toBe(false)
    expect(useStore.getState().projectPanels[p.id]?.panels).toEqual(panels)
  })

  it('Undo does not overwrite what was typed after the archive', async () => {
    const { s } = await oneSession('/tmp/undo-place-b')
    useStore.setState((st) => ({ drafts: { ...st.drafts, [s.id]: { text: 'old words', attachments: [] } } }))
    expect(await useStore.getState().archiveSession(s.id)).toBeNull()
    useStore.setState((st) => ({ drafts: { ...st.drafts, [s.id]: { text: 'new words', attachments: [] } } }))
    useStore.getState().toastAction?.run()
    await vi.waitFor(() => expect(useStore.getState().sessions[s.id]).toBeDefined())
    expect(useStore.getState().drafts[s.id]?.text).toBe('new words')
  })
})

/** Where the palette's "New session" starts one (#529): where the person is, then where they were */
describe('newSessionProjectOf (#529)', () => {
  const projects = { p1: { id: 'p1' } as never, p2: { id: 'p2' } as never, p3: { id: 'p3' } as never }
  const sessions = { a: { id: 'a', projectId: 'p2' } as never, orch: { id: 'orch', projectId: null } as never }
  const base = { view: 'focus' as const, focusedSessionId: null, focusedProjectId: null, focusedApp: null, projects, sessions }

  it("is the open session's project, the project screen's, or the open app's", () => {
    expect(newSessionProjectOf({ ...base, focusedSessionId: 'a', focusedProjectId: 'p3' })).toBe('p2')
    expect(newSessionProjectOf({ ...base, focusedProjectId: 'p3' })).toBe('p3')
    expect(newSessionProjectOf({ ...base, view: 'app', focusedApp: { projectId: 'p3', appId: 'x' } })).toBe('p3')
  })

  it("on the grid, the focused panel's project; with a coordinator open, the project looked at last", () => {
    expect(newSessionProjectOf({ ...base, view: 'grid', focusedSessionId: 'a', focusedProjectId: 'p3' })).toBe('p2')
    expect(newSessionProjectOf({ ...base, view: 'orchestrator', focusedSessionId: 'orch', focusedProjectId: 'p3' })).toBe('p3')
  })

  it('falls back to the first project, and is null only with none', () => {
    expect(newSessionProjectOf({ ...base, view: 'orchestrator', focusedSessionId: 'orch' })).toBe('p1')
    expect(newSessionProjectOf({ ...base, focusedProjectId: 'gone' })).toBe('p1')
    expect(newSessionProjectOf({ ...base, projects: {} })).toBeNull()
  })
})

/*
 * The preset a new session starts with (#1525): `edits` in a trusted project, `normal` in an untrusted one, and the
 * person's own choice always wins. The window sends the preset itself, so a client that names none (a script, the
 * limited credential) still gets `normal` from the host.
 */
describe('the preset a new session starts with (#1525)', () => {
  async function started(trusted: boolean, opts?: { permissionPreset?: 'safe' | 'normal' | 'edits' | 'auto' }, machine?: string) {
    const mock = new MockPlatform()
    const p = await mock.projects.add('/tmp/preset-project')
    await mock.projects.setTrusted(p.id, trusted)
    await useStore.getState().attach(mock)
    if (machine) useStore.setState((st) => ({ projects: { ...st.projects, [p.id]: { ...st.projects[p.id]!, machine } } }))
    const created = await useStore.getState().createSession(p.id, { tool: 'claude', ...opts })
    return { sent: useStore.getState().sessions[created.id]!.permissionPreset, shown: created.permissionPreset }
  }

  it('a trusted project starts accepting edits inside the project', async () => {
    expect(await started(true)).toEqual({ sent: 'edits', shown: 'edits' })
  })

  it('an untrusted project keeps normal', async () => {
    expect(await started(false)).toEqual({ sent: 'normal', shown: 'normal' })
  })

  it('an explicit choice wins in a trusted project, normal included, and is never raised', async () => {
    expect((await started(true, { permissionPreset: 'normal' })).sent).toBe('normal')
    expect((await started(true, { permissionPreset: 'safe' })).sent).toBe('safe')
    expect((await started(false, { permissionPreset: 'edits' })).sent).toBe('edits')
  })

  it('a project on a linked machine keeps normal: that machine may not know edits yet', async () => {
    expect((await started(true, undefined, 'other-machine')).sent).toBe('normal')
  })
})
