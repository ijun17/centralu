import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalAppInfo, NormalizedEvent, SessionInfo } from '@cc/protocol'
import { sessionLiveDefaults } from '@cc/protocol'
import { DEFAULT_NOTIFY_POLICY, sessionGridPanel, type NotifyPolicy } from '@cc/core'
// eslint-disable-next-line no-restricted-imports -- the runtime ui knows only ports, but tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import {
  appliedVersionsText,
  composerTarget,
  droppedQuestionsText,
  externalAppKey,
  gridAppViewKey,
  gridScreenAppKeys,
  handoffPrompt,
  inlineViewsFromHistory,
  messagesToChat,
  projectScreenSessions,
  registerPinnedFrame,
  useStore,
  type ChatItem,
} from './store.js'

/**
 * Store regression tests — ports go through `MockPlatform` (no ad-hoc mocking, or the contract falls
 * apart). The `pendingEvents` holding pen is module state, so it cannot be cleared between tests —
 * each test uses a different session id instead.
 */

/**
 * Pretends the predecessor wrote its note **as a reply** (#142) — the host (mocked) places the file at
 * the note's spot in the data folder. What is returned is that location. The path is keyed to the
 * departing session's id (#104).
 */
function mockNote(mock: MockPlatform, sessionId: string, text: string): string {
  mock.emit({ type: 'message_delta', sessionId, role: 'assistant', text } as NormalizedEvent)
  return notePathOf(mock, sessionId)
}
const notePathOf = (mock: MockPlatform, sessionId: string) =>
  `/mock-data/handoff/${mock.sessions.get(sessionId)!.projectId}/${sessionId}.md`

/**
 * A note a pre-#142 handoff left in the user's repository — an old successor session still holds this
 * path. The app never reads it, overwrites it, or clears it away.
 */
function oldRepoNote(mock: MockPlatform, sessionId: string): string {
  const path = `.centralu/handoff/${sessionId}.md`
  mock.placeFile(path, 'note from the old spot')
  return path
}

/** Traces of a handoff file being newly placed or cleared from the user's repository (#142) — there must be nothing but the old note */
const repoHandoffTraces = (mock: MockPlatform, old: string) => [
  ...Object.keys(mock.fsState.files).filter((p) => p.includes('handoff') && p !== old),
  ...(mock.fsState.files[old] === 'note from the old spot' ? [] : [`${old} changed`]),
  ...mock.trashed.filter((p) => p.includes('handoff')),
]

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

/** Turns one conversation row into human-readable text — a tool's title, an image's kind */
const line = (i: ChatItem): string =>
  i.kind === 'tool' ? i.title : i.kind === 'image' ? `image:${i.mime}` : i.kind === 'approval' ? i.summary : i.text

/**
 * Reads back as far as a person could — once history stands, keeps pressing "earlier conversation"
 * until there is no more (#79). A wrong cursor shows up here: a gap in the middle (the cursor is too
 * low) or the same row appended twice (too high).
 */
async function readAll(id: string): Promise<string[]> {
  await vi.waitFor(() => expect(useStore.getState().history[id]).toBeDefined())
  for (let i = 0; i < 50 && useStore.getState().history[id]!.more; i++) await useStore.getState().loadOlder(id)
  return useStore.getState().chat[id]!.map(line)
}

beforeEach(() => {
  useStore.setState({
    platform: null,
    connection: 'connecting',
    projects: {},
    sessions: {},
    chat: {},
    drafts: {},
    stickToBottom: {},
    workingSince: {},
    expandedDirs: {},
    showIgnored: true,
    foldedProjects: [],
    projectPanels: {},
    focusedSessionId: null,
    focusedProjectId: null,
    view: 'focus',
    history: {},
    subagentSteps: {},
    resuming: {},
    wakeError: {},
    wakeLocked: {},
    notices: [],
    toast: null,
    approvalsInFlight: {},
    commandRuns: {},
    notifyPolicy: DEFAULT_NOTIFY_POLICY,
    externalAppChanges: {},
    externalAppRunChanges: {},
    externalAppChangedBy: {},
    externalApps: [],
    trustAsk: null,
    pinnedViews: [],
    focusedApp: null,
  })
})

describe('picking a project', () => {
  it('picking a project while viewing one of its sessions releases the session and goes to the project screen', () => {
    useStore.setState({
      projects: { p1: { id: 'p1', path: '/tmp/p1', name: 'p1' } as never, p2: { id: 'p2', path: '/tmp/p2', name: 'p2' } as never },
      sessions: { 'pf-s1': { ...sessionInfo('pf-s1') } as never },
      focusedProjectId: 'p1',
      focusedSessionId: 'pf-s1',
      view: 'focus',
    })
    useStore.getState().focusProject('p1')
    expect(useStore.getState()).toMatchObject({ focusedProjectId: 'p1', focusedSessionId: null, view: 'focus' })
  })

  it('picking the project of a panel chosen from the grid also brings up the project screen', () => {
    useStore.setState({
      projects: { p1: { id: 'p1', path: '/tmp/p1', name: 'p1' } as never },
      sessions: { 'pf-s2': { ...sessionInfo('pf-s2') } as never },
      focusedProjectId: 'p1',
      focusedSessionId: 'pf-s2',
      view: 'grid',
    })
    useStore.getState().focusProject('p1')
    expect(useStore.getState()).toMatchObject({ focusedProjectId: 'p1', focusedSessionId: null, view: 'focus' })
  })
})

/*
 * Sidebar folding (#205). A fold is remembered per project and survives a restart — carried in the
 * workspace snapshot. Because a picked session must be shown, the inbox, palette, notification card
 * and new-session all unfold that project, and what gets unfolded is remembered too. Exactly two
 * doors never unfold: restoring a snapshot, and clicking a grid panel.
 */
describe('sidebar folding (#205)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const folds = (mock: MockPlatform) => (mock.workspaceSnapshot as { foldedProjects?: string[] } | null)?.foldedProjects

  it('a fold is carried in the snapshot and survives a restart', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/fold-a')
    const b = await mock.projects.add('/tmp/fold-b')
    await useStore.getState().attach(mock)

    useStore.getState().toggleProjectFold(a.id)
    await tick()
    expect(folds(mock)).toEqual([a.id])
    useStore.getState().toggleProjectFold(b.id)
    useStore.getState().toggleProjectFold(a.id)
    await tick()
    expect(folds(mock)).toEqual([b.id])

    // Simulates reopening the app — feeds the same snapshot to a store reset back to the default (nothing folded)
    useStore.setState({ foldedProjects: [] })
    await useStore.getState().attach(mock)
    expect(useStore.getState().foldedProjects).toEqual([b.id])
  })

  it('a revived session leaves its folded project folded, and a save mid-revival does not erase the fold', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/fold-restore')
    mock.sessions.set('fold-r1', sessionInfo('fold-r1', { projectId: a.id }))
    mock.workspaceSnapshot = { focusedSessionId: 'fold-r1', foldedProjects: [a.id] } as never

    await useStore.getState().attach(mock)
    await tick()

    expect(useStore.getState().focusedSessionId).toBe('fold-r1')
    expect(useStore.getState().foldedProjects).toEqual([a.id])
    expect(folds(mock)).toEqual([a.id])
  })

  it('going to a session, as the inbox or palette does, unfolds its project and remembers the unfold', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/fold-go')
    const b = await mock.projects.add('/tmp/fold-stay')
    mock.sessions.set('fold-g1', sessionInfo('fold-g1', { projectId: a.id }))
    await useStore.getState().attach(mock)
    useStore.getState().toggleProjectFold(a.id)
    useStore.getState().toggleProjectFold(b.id)

    useStore.getState().focusSession('fold-g1', { preferGrid: true })
    await tick()

    // Never touches another project's fold
    expect(useStore.getState().foldedProjects).toEqual([b.id])
    expect(folds(mock)).toEqual([b.id])
  })

  it('a pick made by clicking a grid panel (reveal: false) does not unfold a folded project', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/fold-grid')
    mock.sessions.set('fold-q1', sessionInfo('fold-q1', { projectId: a.id }))
    await useStore.getState().attach(mock)
    useStore.getState().toggleProjectFold(a.id)

    useStore.getState().focusSession('fold-q1', { preferGrid: true, reveal: false })

    expect(useStore.getState().focusedSessionId).toBe('fold-q1')
    expect(useStore.getState().foldedProjects).toEqual([a.id])
  })

  it('creating a new session in a folded project unfolds it', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const p = await useStore.getState().addProject('/tmp/fold-new')
    useStore.getState().toggleProjectFold(p.id)

    await useStore.getState().createSession(p.id)

    expect(useStore.getState().foldedProjects).toEqual([])
  })

  it('folding every other project leaves only this one unfolded', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/fold-o1')
    const b = await mock.projects.add('/tmp/fold-o2')
    const c = await mock.projects.add('/tmp/fold-o3')
    await useStore.getState().attach(mock)
    useStore.getState().toggleProjectFold(b.id)

    useStore.getState().foldOtherProjects(b.id)
    await tick()

    expect([...useStore.getState().foldedProjects].sort()).toEqual([a.id, c.id].sort())
    expect([...(folds(mock) ?? [])].sort()).toEqual([a.id, c.id].sort())
  })

  it('a deleted project leaves no fold behind', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/fold-gone')
    await useStore.getState().attach(mock)
    useStore.getState().toggleProjectFold(a.id)

    await useStore.getState().deleteProject(a.id, false)

    expect(useStore.getState().foldedProjects).toEqual([])
  })
})

/*
 * The project screen's arrangement (#203): per project, in the workspace snapshot, next to the fold. The panels are
 * derived from what the project has; only the order the person dragged and what they hid are kept.
 */
describe('project screen arrangement (#203)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const stored = (mock: MockPlatform) =>
    (mock.workspaceSnapshot as { projectPanels?: Record<string, unknown> } | null)?.projectPanels

  it('is written to the snapshot per project and read back on the next launch', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/arr-a')
    const b = await mock.projects.add('/tmp/arr-b')
    await useStore.getState().attach(mock)

    useStore.getState().arrangeProject(a.id, { order: ['session:x', 'session:y'], hidden: ['app:z'] })
    await tick()
    expect(stored(mock)).toEqual({ [a.id]: { order: ['session:x', 'session:y'], hidden: ['app:z'] } })
    expect(stored(mock)?.[b.id]).toBeUndefined()

    useStore.setState({ projectPanels: {} })
    await useStore.getState().attach(mock)
    expect(useStore.getState().projectPanels).toEqual({ [a.id]: { order: ['session:x', 'session:y'], hidden: ['app:z'] } })
  })

  it('no save made while restoring writes an empty arrangement over the stored one', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/arr-restore')
    mock.sessions.set('arr-r1', sessionInfo('arr-r1', { projectId: a.id }))
    const saved = { [a.id]: { order: ['session:arr-r1'], hidden: [] } }
    mock.workspaceSnapshot = { focusedSessionId: 'arr-r1', projectPanels: saved } as never
    /*
     * Restoring the focused session used to save the snapshot midway, and a crash right after must not find the
     * arrangement gone. Saves are now held off for the whole restore (`restoringWorkspace`), so the stronger thing
     * holds: the restore writes nothing, and the stored arrangement is exactly what it was.
     */
    const written: unknown[] = []
    const save = mock.workspace.save
    mock.workspace.save = async (snap) => {
      written.push((snap as { projectPanels?: unknown }).projectPanels)
      return save(snap)
    }

    await useStore.getState().attach(mock)
    await tick()

    expect(useStore.getState().focusedSessionId).toBe('arr-r1')
    expect(written).toEqual([])
    expect((mock.workspaceSnapshot as { projectPanels?: unknown }).projectPanels).toEqual(saved)
  })

  it('leaves with its project', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/arr-gone')
    const b = await mock.projects.add('/tmp/arr-stays')
    await useStore.getState().attach(mock)
    useStore.getState().arrangeProject(a.id, { order: ['session:x'], hidden: [] })
    useStore.getState().arrangeProject(b.id, { order: ['session:y'], hidden: [] })

    await useStore.getState().deleteProject(a.id, false)
    await tick()

    expect(Object.keys(useStore.getState().projectPanels)).toEqual([b.id])
    expect(Object.keys(stored(mock) ?? {})).toEqual([b.id])
  })

  it('the project screen puts its sessions on screen, less the hidden ones, and only while no session is picked', () => {
    useStore.setState({
      projects: { p1: { id: 'p1', path: '/tmp/p1', name: 'p1' } as never, p2: { id: 'p2', path: '/tmp/p2', name: 'p2' } as never },
      sessions: {
        s1: { ...sessionInfo('s1', { projectId: 'p1' }) } as never,
        s2: { ...sessionInfo('s2', { projectId: 'p1' }) } as never,
        s3: { ...sessionInfo('s3', { projectId: 'p2' }) } as never,
      },
      projectPanels: { p1: { order: [], hidden: ['session:s2'] } },
      focusedProjectId: 'p1',
      focusedSessionId: null,
      view: 'focus',
    })
    expect(projectScreenSessions(useStore.getState())).toEqual(['s1'])
    useStore.setState({ focusedSessionId: 's1' })
    expect(projectScreenSessions(useStore.getState())).toEqual([])
    useStore.setState({ focusedSessionId: null, view: 'grid' })
    expect(projectScreenSessions(useStore.getState())).toEqual([])
  })

  it('an app the project screen shows gets a pinned view without leaving the screen, and one entry however often it asks', () => {
    useStore.setState({ view: 'focus', focusedSessionId: null, focusedProjectId: 'p1' })
    useStore.getState().ensurePinnedView('p1', 'slider')
    useStore.getState().ensurePinnedView('p1', 'slider')
    expect(useStore.getState().pinnedViews.map((p) => p.key)).toEqual(['p1/slider'])
    expect(useStore.getState()).toMatchObject({ view: 'focus', focusedApp: null })
  })
})

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

/**
 * Reading back further (dogfooding, 2026-09-09: "older conversation does not load above").
 *
 * The conversation the screen holds and the history cursor **must move together.** If they fall out
 * of sync, "earlier conversation" either prepends a range that does not connect to the screen, or the
 * way to load it disappears entirely.
 */
describe('history cursor', () => {
  const many = (id: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      sessionId: id, seq: i + 1, role: 'user' as const, kind: 'text' as const,
      payload: { text: `line ${i + 1}` }, ts: i + 1,
    }))

  it('leaving a session while shrinking the window also moves the cursor to the trim point', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('h1', sessionInfo('h1'))
    mock.sessions.set('h2', sessionInfo('h2'))
    mock.messages.set('h1', many('h1', 120))
    await useStore.getState().attach(mock)

    await useStore.getState().focusSession('h1')
    await vi.waitFor(() => expect(useStore.getState().chat['h1']?.length).toBe(100))

    await useStore.getState().focusSession('h2')

    const chat = useStore.getState().chat['h1']!
    const info = useStore.getState().history['h1']!
    expect(chat.length).toBe(50)
    // The cursor is at the same spot as the top of the screen — that is what makes the next page line up
    expect(info.oldestSeq).toBe(chat[0]!.seq)
    expect(info.more).toBe(true)
  })

  /*
   * The old assertion was `oldestSeq === chat[0].seq`. It passed while a bug remained: since that
   * `seq` was the render key, `loadOlder` still started reading from the wrong place (#79) even
   * though the cursor was at "the same spot" as the screen. So the actual outcome is checked instead.
   */
  it('a conversation built only from events still has every stored row exactly once when read back to the end', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('h3', sessionInfo('h3'))
    mock.messages.set('h3', many('h3', 120))
    await useStore.getState().attach(mock)

    // The event arrived before the screen was opened — only `chat` exists, with no cursor
    mock.emit({ sessionId: 'h3', type: 'message_delta', role: 'assistant', text: 'message that arrived first' } as never)
    await vi.waitFor(() => expect(useStore.getState().chat['h3']).toBeDefined())
    expect(useStore.getState().history['h3']).toBeUndefined()

    await useStore.getState().focusSession('h3')

    expect(await readAll('h3')).toEqual([...Array.from({ length: 120 }, (_, i) => `line ${i + 1}`), 'message that arrived first'])
  })
})

/**
 * The history cursor is set only by the stored number (#79).
 *
 * A live row's `seq` is the render key shared across every session; the `seq` on a row read from
 * history is the number the host assigned within that session. In a session where an event arrives
 * before the screen, if the cursor took the render key instead: a key lower than the stored number
 * leaves a gap in the middle (A), and a key higher appends the newest page a second time (A2). An
 * event arriving mid-read used to discard the page just fetched (B). Measured (2026-09-25): opening
 * the session for an app's requested agent for the first time showed the prompt and the Read/Write
 * cards twice.
 */
describe('the cursor for a session where an event arrives before history (#79)', () => {
  const rows = (id: string, n: number, from = 1) =>
    Array.from({ length: n }, (_, i) => ({
      sessionId: id, seq: from + i, role: 'user' as const, kind: 'text' as const,
      payload: { text: `L${from + i}` }, ts: from + i,
    }))
  const L = (n: number) => Array.from({ length: n }, (_, i) => `L${i + 1}`)

  /** Reads another session's large history first — makes the render key far larger than the stored number (the measured condition) */
  async function openBigFirst(mock: MockPlatform, id: string) {
    mock.sessions.set(id, sessionInfo(id))
    mock.messages.set(id, rows(id, 1000))
    useStore.getState().focusSession(id)
    await vi.waitFor(() => expect(useStore.getState().history[id]).toBeDefined())
  }

  it.each([
    ['the first page', 50],
    ['an older page', 200],
  ])('A: no gap in the middle even when the render key is lower than the stored number — the key overlapping %s\'s number still leaves the viewed row\'s key untouched', async (_where, over) => {
    const mock = new MockPlatform()
    mock.sessions.set('a79-probe', sessionInfo('a79-probe'))
    mock.sessions.set('a79', sessionInfo('a79'))
    await useStore.getState().attach(mock)
    // Measures the next render key and creates a session 200 lines longer than that — the key lands inside the middle of the stored numbers
    mock.emit({ sessionId: 'a79-probe', type: 'tool_call', callId: 'p', summary: { tool: 'Read', title: 'probe', readOnly: true } } as never)
    const n = useStore.getState().chat['a79-probe']![0]!.seq + over
    mock.messages.set('a79', rows('a79', n))

    mock.emit(delta('a79', 'LIVE-D'))
    const key = useStore.getState().chat['a79']![0]!.seq
    expect(key).toBeLessThan(n) // Condition confirmed: the key is inside the stored range
    useStore.getState().focusSession('a79')

    expect(await readAll('a79')).toEqual([...L(n), 'LIVE-D'])
    const chat = useStore.getState().chat['a79']!
    // The screen's row is not redrawn during the merge (same key) — a stored row with the same number steps around it
    expect(chat.find((i) => line(i) === 'LIVE-D')!.seq).toBe(key)
    expect(new Set(chat.map((i) => i.seq)).size).toBe(chat.length)
  })

  it('A2: the newest page is not appended twice even when the render key is higher than the stored number', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('a2-79', sessionInfo('a2-79'))
    mock.messages.set('a2-79', rows('a2-79', 20))
    await useStore.getState().attach(mock)
    await openBigFirst(mock, 'a2-big')

    mock.emit(delta('a2-79', 'LIVE-S'))
    expect(useStore.getState().chat['a2-79']![0]!.seq).toBeGreaterThan(21)
    useStore.getState().focusSession('a2-79')

    expect(await readAll('a2-79')).toEqual([...L(20), 'LIVE-S'])
  })

  it('B: a message arriving mid-read never causes the fetched page to be discarded', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('b79', sessionInfo('b79'))
    mock.messages.set('b79', rows('b79', 250))
    await useStore.getState().attach(mock)

    // Like the host: reads the page as of the moment the request was received, and the answer arrives later than an event that came in after it
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = mock.agents.loadMessages.bind(mock.agents)
    mock.agents.loadMessages = async (...args: Parameters<typeof real>) => {
      const page = real(...args)
      await gate
      return page
    }
    useStore.getState().focusSession('b79')
    mock.emit(delta('b79', 'LIVE'))
    release()
    mock.agents.loadMessages = real

    expect(await readAll('b79')).toEqual([...L(250), 'LIVE'])
  })

  it("an app's requested agent's session: created in the background and opened for the first time only after it finished still shows everything exactly once (reproducing the measured incident)", async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    await openBigFirst(mock, 'app79-big')

    // The host creates the session in the background (D-1), the app's request enters as the first message, and the agent reads, writes and replies
    const info = sessionInfo('app79', { appId: 'notes' })
    mock.sessions.set('app79', info)
    mock.emit({ type: 'session_created', sessionId: 'app79', session: info } as never)
    const fromApp = { appId: 'notes', projectId: 'p1', name: 'Notes' }
    mock.emit({ type: 'user_message', sessionId: 'app79', seq: 0, text: 'Make a note', fromApp } as never)
    mock.emit({ type: 'tool_call', sessionId: 'app79', callId: 'r', summary: { tool: 'Read', title: 'Read note.md', readOnly: true } } as never)
    mock.emit({ type: 'tool_result', sessionId: 'app79', callId: 'r', ok: true, summary: 'empty' } as never)
    mock.emit({ type: 'tool_call', sessionId: 'app79', callId: 'w', summary: { tool: 'Write', title: 'Write note.md', readOnly: false } } as never)
    mock.emit({ type: 'tool_result', sessionId: 'app79', callId: 'w', ok: true, summary: 'written' } as never)
    mock.emit(delta('app79', 'Done.'))
    mock.emit({ type: 'turn_complete', sessionId: 'app79' } as never)
    expect(useStore.getState().history['app79']).toBeUndefined()
    const key = useStore.getState().chat['app79']!.find((i) => line(i) === 'Write note.md')!.seq

    useStore.getState().focusSession('app79')

    expect(await readAll('app79')).toEqual(['Make a note', 'Read note.md', 'Write note.md', 'Done.'])
    // The card being viewed keeps the same key even after merging with history — it is not redrawn, and the read position (scrollAnchor) stays anchored to that key
    const write = useStore.getState().chat['app79']!.find((i) => line(i) === 'Write note.md')
    expect(write).toMatchObject({ seq: key, result: 'written', ok: true })
  })

  it('events replayed by the initial connection each appear exactly once, in their proper place, even overlapping the page', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('r79', sessionInfo('r79'))
    const approval = { type: 'approval_request', sessionId: 'r79', seq: 30, requestId: 'old', detail: { kind: 'command', command: 'old command' } }
    const resolved = { type: 'approval_resolved', sessionId: 'r79', seq: 31, requestId: 'old', decision: 'allow' }
    const stored = rows('r79', 150).map((r) =>
      r.seq === 148 || r.seq === 150 ? { ...r, role: 'assistant' as const, payload: { text: `L${r.seq}` } }
      : r.seq === 30 || r.seq === 31 ? { ...r, role: 'system' as const, kind: 'approval' as const, payload: r.seq === 30 ? approval : resolved }
      : r,
    )
    mock.messages.set('r79', stored as never)

    // The host replays its buffer to a freshly attached UI — held before the session is registered,
    // then replayed during attach. An old message (21), messages inside the page, and the last reply
    // whose earlier part was pushed out of the buffer (only '150' remains)
    // History never draws approval rows — an approval older than the page has nowhere to find its place, so it is left out
    const replay = [
      { type: 'user_message', sessionId: 'r79', seq: 21, text: 'L21' },
      approval,
      resolved,
      { type: 'message_delta', sessionId: 'r79', seq: 148, role: 'assistant', text: 'L148' },
      { type: 'user_message', sessionId: 'r79', seq: 149, text: 'L149' },
      { type: 'message_delta', sessionId: 'r79', seq: 150, role: 'assistant', text: '150' },
    ]
    for (const e of replay) useStore.getState().dispatchEvent(e as NormalizedEvent)
    await useStore.getState().attach(mock)
    expect(useStore.getState().chat['r79']!.map(line)).toEqual(['L21', 'old command', 'L148', 'L149', '150'])

    useStore.getState().focusSession('r79')

    expect(await readAll('r79')).toEqual(L(150).filter((t) => t !== 'L30' && t !== 'L31'))
  })

  it('history stands first, and an event for the same row that follows is never drawn twice', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('q79', sessionInfo('q79'))
    mock.messages.set('q79', [
      ...rows('q79', 8),
      { sessionId: 'q79', seq: 9, role: 'system', kind: 'tool_call', payload: { callId: 'c9', summary: { tool: 'Read', title: 'T9', readOnly: true } }, ts: 9 },
      { sessionId: 'q79', seq: 10, role: 'system', kind: 'marker', payload: { type: 'compaction', sessionId: 'q79', failed: false }, ts: 10 },
    ])
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('q79')
    await vi.waitFor(() => expect(useStore.getState().history['q79']).toBeDefined())

    // An event for the same row, held in the pen, was replayed later than the page
    for (const e of [
      { type: 'user_message', sessionId: 'q79', seq: 8, text: 'L8' },
      { type: 'tool_call', sessionId: 'q79', seq: 9, callId: 'c9', summary: { tool: 'Read', title: 'T9', readOnly: true } },
      { type: 'compaction', sessionId: 'q79', seq: 10, failed: false },
    ]) useStore.getState().dispatchEvent(e as NormalizedEvent)

    expect(useStore.getState().chat['q79']!.map(line)).toEqual([...L(8), 'T9', 'Earlier messages were compacted here'])
  })

  it('a streaming message is never truncated by merging with history — the screen version is longer than the stored text', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('s79', sessionInfo('s79'))
    mock.messages.set('s79', rows('s79', 10))
    await useStore.getState().attach(mock)
    mock.emit(delta('s79', 'Hel'))

    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = mock.agents.loadMessages.bind(mock.agents)
    mock.agents.loadMessages = async (...args: Parameters<typeof real>) => {
      const page = real(...args)
      await gate
      return page
    }
    useStore.getState().focusSession('s79')
    // A chunk that arrived after the page was read — the store's own version of that message is still 'Hel'
    mock.emit(delta('s79', 'lo'))
    release()
    mock.agents.loadMessages = real

    expect(await readAll('s79')).toEqual([...L(10), 'Hello'])
  })

  it('an unnumbered tail (a sent message, an image, an error) already in history shows only once, and an approval row stays in its own place', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('e79', sessionInfo('e79'))
    mock.sessions.set('e79-other', sessionInfo('e79-other'))
    mock.messages.set('e79', rows('e79', 5))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('e79-other')

    // Before this session is opened: a command that went through approval, a human message (a mock
    // never sends the confirmation — so it has no number), an agent's image (its event carries no
    // number), a failed turn (the schema strips the number, #161)
    mock.emit({ type: 'approval_request', sessionId: 'e79', requestId: 'q1', detail: { kind: 'command', command: 'rm -rf build' } } as never)
    mock.emit({ type: 'approval_resolved', sessionId: 'e79', requestId: 'q1', decision: 'allow' } as never)
    await useStore.getState().send('e79', 'Hi')
    mock.emit({ type: 'message_image', sessionId: 'e79', mime: 'image/png', data: 'aWJs' } as never)
    const error = { type: 'error', sessionId: 'e79', error: { code: 'internal', message: 'boom', retryable: false } }
    mock.messages.get('e79')!.push({ sessionId: 'e79', seq: 10, role: 'system', kind: 'marker', payload: error, ts: 10 })
    useStore.getState().dispatchEvent(error as NormalizedEvent)
    expect(useStore.getState().chat['e79']!.map((i) => i.storedSeq)).toEqual([6, undefined, undefined, undefined])

    useStore.getState().focusSession('e79')

    expect(await readAll('e79')).toEqual([
      ...L(5), 'rm -rf build', 'Hi', 'image:image/png', 'The agent could not finish this turn — boom',
    ])
  })

  it('a session restored by importing also has each row exactly once when read back to the end — a number already on screen is never appended a second time', async () => {
    const mock = new MockPlatform()
    mock.externalHistory.set('ext-79', Array.from({ length: 150 }, (_, i) => ({ role: 'user' as const, text: `L${i + 1}` })))
    await useStore.getState().attach(mock)
    const p = await useStore.getState().addProject('/tmp/imp79')
    const info = await useStore.getState().createSession(p.id, { resumeExternalId: 'ext-79', importHistory: true })

    expect(await readAll(info.id)).toEqual(L(150))
  })

  it('a message that started with an unstored, unnumbered empty chunk still receives the stored number of the chunk that follows — it is never duplicated when merging', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('d79', sessionInfo('d79'))
    mock.messages.set('d79', rows('d79', 3))
    await useStore.getState().attach(mock)

    // The host never stores an empty chunk and sends it with no number (codex's trailing ""). The chunk that follows starts row 4
    useStore.getState().dispatchEvent(delta('d79', ''))
    mock.emit(delta('d79', 'Answer'))
    useStore.getState().focusSession('d79')

    expect(await readAll('d79')).toEqual([...L(3), 'Answer'])
  })

  it('when trimming the window, the cursor is still the stored number even if the top row is a live one', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('t79', sessionInfo('t79'))
    mock.sessions.set('t79-other', sessionInfo('t79-other'))
    mock.messages.set('t79', rows('t79', 120))
    await useStore.getState().attach(mock)
    await openBigFirst(mock, 't79-big')
    useStore.getState().focusSession('t79')
    await vi.waitFor(() => expect(useStore.getState().history['t79']).toBeDefined())

    // 60 tool calls follow while it is being viewed — all 50 rows left when leaving are live rows
    for (let i = 121; i <= 180; i++) {
      mock.emit({ sessionId: 't79', type: 'tool_call', callId: `c${i}`, summary: { tool: 'Read', title: `L${i}`, readOnly: true } } as never)
    }
    useStore.getState().focusSession('t79-other')
    expect(useStore.getState().chat['t79']).toHaveLength(50)
    expect(useStore.getState().history['t79']!.oldestSeq).toBe(131)

    useStore.getState().focusSession('t79')
    expect(await readAll('t79')).toEqual(L(180))
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
 * When the current turn started (issue #23).
 *
 * The "Waiting for response" line counted up from its own mount, so any remount put a
 * three-minute turn back at zero. The instant lives here now and the count is derived from
 * it — which only helps if the instant itself holds still while a turn streams, and is let
 * go when the turn ends. Both are what these check.
 *
 * It is deliberately not `waitingSince`: that one is when a session started waiting for a
 * *human*, and the reducer nulls it the moment a session goes back to working.
 */
describe('the instant a turn started (issue #23)', () => {
  it('the instant does not move while streaming continues — elapsed time is derived from it', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('ws-s1', sessionInfo('ws-s1'))
    await useStore.getState().attach(mock)

    useStore.getState().dispatchEvent(delta('ws-s1', 'first letter'))
    const started = useStore.getState().workingSince['ws-s1']
    expect(started).toBeDefined()
    expect(useStore.getState().sessions['ws-s1']!.state).toBe('working')

    useStore.getState().dispatchEvent(delta('ws-s1', ' and then more'))
    expect(useStore.getState().workingSince['ws-s1']).toBe(started)
  })

  it('the instant is released once a turn ends — the next turn must never inherit someone else\'s start', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('ws-s2', sessionInfo('ws-s2'))
    await useStore.getState().attach(mock)

    useStore.getState().dispatchEvent(delta('ws-s2', 'reply'))
    expect(useStore.getState().workingSince['ws-s2']).toBeDefined()

    useStore.getState().dispatchEvent({ sessionId: 'ws-s2', type: 'turn_complete' } as NormalizedEvent)
    expect(useStore.getState().sessions['ws-s2']!.state).toBe('waiting_input')
    expect(useStore.getState().workingSince['ws-s2']).toBeUndefined()
  })

  it('a session that was already running before the app was opened also gets an instant stamped — with none, the screen has nothing to count from', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('ws-s3', sessionInfo('ws-s3', { state: 'working' }))

    await useStore.getState().attach(mock)

    // The host never tells us when the turn really started — the moment we found out is the earliest honest answer
    expect(useStore.getState().workingSince['ws-s3']).toBeDefined()
  })
})

describe('preventing the opening prompt from being drawn twice', () => {
  it('the host\'s user_message confirmation settles the optimistic opening prompt — it is never drawn twice', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const p = await useStore.getState().addProject('/tmp/ip')
    const info = await useStore.getState().createSession(p.id, { initialPrompt: 'first instruction' })

    // The host also stores and announces the opening prompt (the `user_message` in manager.createSession)
    // — the mock also announces it before the response (#172). Even if the same confirmation arrives a
    // second time (reconnect replay), it is never drawn twice
    useStore
      .getState()
      .dispatchEvent({ type: 'user_message', sessionId: info.id, seq: 1, text: 'first instruction' } as NormalizedEvent)

    const users = useStore.getState().chat[info.id]!.filter((i) => i.kind === 'user')
    expect(users).toHaveLength(1)
    expect((users[0] as { pending?: boolean }).pending).toBeFalsy()
  })
})

describe('the workspace snapshot has a single writer (U7)', () => {
  it('saving the layout after changing the notify policy does not erase the policy', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)

    const policy: NotifyPolicy = { ...DEFAULT_NOTIFY_POLICY, sound: !DEFAULT_NOTIFY_POLICY.sound }
    useStore.getState().setNotifyPolicy(policy)
    await new Promise((r) => setTimeout(r, 0))
    expect((mock.workspaceSnapshot as { notifyPolicy?: NotifyPolicy } | null)?.notifyPolicy).toEqual(policy)

    // This save used to overwrite the whole thing with a partial snapshot missing `notifyPolicy` →
    // resetting the policy on restart (the example at the time of the incident was `treeHeight` — that
    // setting left with the strip, but the rule remains)
    useStore.getState().setShowIgnored(false)
    await new Promise((r) => setTimeout(r, 0))
    const snap = mock.workspaceSnapshot as { notifyPolicy?: NotifyPolicy; showIgnored?: boolean } | null
    expect(snap?.notifyPolicy).toEqual(policy)
    expect(snap?.showIgnored).toBe(false)
  })

  it('conversely, saving the policy does not erase the layout (showIgnored) either', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)

    useStore.getState().setShowIgnored(false)
    await new Promise((r) => setTimeout(r, 0))
    useStore.getState().setNotifyPolicy({ ...DEFAULT_NOTIFY_POLICY })
    await new Promise((r) => setTimeout(r, 0))

    expect((mock.workspaceSnapshot as { showIgnored?: boolean } | null)?.showIgnored).toBe(false)
  })

  /*
   * The text size is a preference now (#312 step 5), not part of the snapshot: a snapshot from
   * before carries it as a step index, and the platform moves it into the preferences once.
   */
  it('the text size is a preference: a stored size arrives with the preferences and is not written into the snapshot', async () => {
    const mock = new MockPlatform()
    mock.workspaceSnapshot = { textScale: 3 }
    await useStore.getState().attach(mock)
    expect(useStore.getState().prefs.textSize).toBe(1.1)

    await useStore.getState().setPrefs({ textSize: 1.2 })
    // Any number lands on the nearest of the five steps
    expect(useStore.getState().prefs.textSize).toBe(1.25)
    useStore.getState().setShowIgnored(false)
    await new Promise((r) => setTimeout(r, 0))
    expect(mock.workspaceSnapshot).not.toHaveProperty('textScale')
  })

  /*
   * What "cannot see ignored files" actually meant was "can see them, but it forgets every time"
   * (issue #17). The switch lived on the component, so leaving the git tab and coming back turned it
   * off again.
   *
   * The direction that matters is now *off*, since on is the default (#17 again). Turning
   * it off is the only version of this choice a person can make deliberately, so it is the
   * one that has to survive a relaunch — and it has to survive the default too.
   */
  it('hiding ignored files survives the next run — a way of viewing belongs to the person', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('si-s1', sessionInfo('si-s1'))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('si-s1')

    useStore.getState().setShowIgnored(false)
    await new Promise((r) => setTimeout(r, 0))
    expect((mock.workspaceSnapshot as { showIgnored?: boolean } | null)?.showIgnored).toBe(false)

    // Simulates reopening the app — feeds the same snapshot to a store reset back to the default
    useStore.setState({ showIgnored: true })
    await useStore.getState().attach(mock)

    expect(useStore.getState().showIgnored).toBe(false)
  })

  /*
   * A stored `false` outranks the default; an *absent* field must not. The two are only
   * distinguishable because the snapshot is read with a `typeof` check — read it as `??
   * false` or `!!snap.showIgnored` instead and every older snapshot suddenly claims someone
   * turned this off, so the default could never move again. That is what this pins.
   */
  it('a setting absent from the snapshot is left at its default — never having chosen is different from having turned it off', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('si-s2', sessionInfo('si-s2'))
    // A snapshot from before this setting existed: it has layout, but no opinion on this
    mock.workspaceSnapshot = { focusedSessionId: 'si-s2', panelOpen: true, panelTab: 'git' }

    // Simulates just opening the app — starts from the default (on)
    useStore.setState({ showIgnored: true })
    await useStore.getState().attach(mock)

    expect(useStore.getState().showIgnored).toBe(true)
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

describe('whether a conversation stood at the bottom (issue #31)', () => {
  it('a session nobody has scrolled is treated as being at the bottom — a conversation starts at its newest line', () => {
    expect(useStore.getState().stickToBottom['sb-s1']).toBeUndefined()
  })

  it('scrolling up to read leaves that fact recorded on the session', () => {
    useStore.getState().setStickToBottom('sb-s1', false)
    expect(useStore.getState().stickToBottom['sb-s1']).toBe(false)
  })

  /*
   * The default (bottom) is recorded **by not being recorded**. That way, an entry does not pile up
   * for every session that was merely passed through — the same rule as an unfinished draft clearing
   * itself once emptied.
   */
  it('returning to the bottom makes the entry itself disappear', () => {
    useStore.getState().setStickToBottom('sb-s2', false)
    useStore.getState().setStickToBottom('sb-s2', true)
    expect('sb-s2' in useStore.getState().stickToBottom).toBe(false)
  })

  /*
   * A single scroll fires dozens of events. If a new object were created even when the value stays
   * the same, every subscriber watching this map would re-render for the entire scroll.
   */
  it('an unchanged value never creates a new state object — scrolling fires dozens of times a second', () => {
    useStore.getState().setStickToBottom('sb-s3', false)
    const before = useStore.getState().stickToBottom
    useStore.getState().setStickToBottom('sb-s3', false)
    expect(useStore.getState().stickToBottom).toBe(before)
  })
})

/**
 * Update status does not belong to a session (issue #43).
 *
 * `dispatchEvent`'s first line is `if (!sessionId) return`, and that is the widest door in this file.
 * Placing an app-wide event after it means whatever the host sends arrives and does nothing —
 * communication looks fine, there is no error, and it is the kind of defect that leaves no clue
 * anywhere to trace the cause. Order is the contract here, so this pins it down.
 */
describe('update status (#43)', () => {
  const status = {
    current: '0.1.0-beta.2', latest: '9999.0.0', newer: true, auto: true, autoApply: false,
    phase: 'idle' as const, error: null, checkedAt: 1,
  }

  it('an event with no session also reaches the store', () => {
    useStore.getState().dispatchEvent({ type: 'update_status', status })
    expect(useStore.getState().update?.latest).toBe('9999.0.0')
  })

  /** Installing must be started by a person — merely finding out does nothing on its own */
  it('merely learning of a new version installs nothing on its own', async () => {
    const platform = new MockPlatform()
    platform.registryVersion = '9999.0.0'
    useStore.setState({ platform })
    await useStore.getState().checkUpdate(true)
    expect(useStore.getState().update?.newer).toBe(true)
    expect(useStore.getState().update?.phase).toBe('idle')
  })
})

/**
 * Composer focus simply calls the existing `wake()` — these are the properties that `wake` must keep.
 *
 * Picking from the sidebar (`focusSession`) and composer focus from a grid panel or restart both go
 * through the same door. A failure is only left in `wakeError`, never raised as a toast (focus is not
 * an action), and if it is already alive, nothing happens.
 */
/** The installed agent CLIs (#297) — app-wide like update status, so the same door applies */
describe('agent CLI versions (#297)', () => {
  it('the installed versions reach the store though they belong to no session', () => {
    useStore.getState().dispatchEvent({ type: 'agent_versions', status: { installed: { claude: '2.1.290' }, autoApply: true, checkedAt: 1 } })
    expect(useStore.getState().agentVersions?.installed.claude).toBe('2.1.290')
  })

  it('coming back to the window asks the host to read the installed versions again', async () => {
    const platform = new MockPlatform()
    platform.setInstalledVersions({ claude: '2.1.291' })
    useStore.setState({ platform, appFocused: false, agentVersions: null })
    useStore.getState().setAppFocused(true)
    await vi.waitFor(() => expect(useStore.getState().agentVersions?.installed.claude).toBe('2.1.291'))
  })

  it('the header action’s line says how many moved and how many were busy', () => {
    expect(appliedVersionsText(2, 0)).toBe('Restarted 2 sessions on the installed version')
    expect(appliedVersionsText(1, 1)).toBe('Restarted 1 session on the installed version; 1 busy keeps its version for now')
    expect(appliedVersionsText(0, 2)).toBe('Nothing restarted: 2 sessions busy keep their version for now')
    expect(appliedVersionsText(0, 0)).toBe('Every session already runs the installed version')
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
 * The screen being viewed carries over a restart.
 *
 * The session comes back, but **the way it is viewed** did not — closed in the grid, it came back up
 * in the focus view. The order of restoration is the trap: `focusSession` forces `view` to `focus`
 * (because a picked session must be shown), so view restoration has to happen **after** that.
 */
describe('view restoration', () => {
  it('closed in the grid, it comes back in the grid — session restoration cannot overwrite it', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('vw-s1', sessionInfo('vw-s1'))
    mock.workspaceSnapshot = { focusedSessionId: 'vw-s1', view: 'grid' }

    await useStore.getState().attach(mock)

    expect(useStore.getState().focusedSessionId).toBe('vw-s1')
    expect(useStore.getState().view).toBe('grid')
  })

  it('changing the view saves it', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)

    useStore.getState().setView('grid')
    await new Promise((r) => setTimeout(r, 0))
    expect((mock.workspaceSnapshot as { view?: string } | null)?.view).toBe('grid')
  })

  it('an unknown view name is ignored — a snapshot is just a file', async () => {
    const mock = new MockPlatform()
    mock.workspaceSnapshot = { view: 'hologram' }

    await useStore.getState().attach(mock)
    expect(useStore.getState().view).toBe('focus')
  })
})

describe('messagesToChat — restoring tool output', () => {
  /*
   * The host keeps the call and the result as separate rows. While there was no branch for the
   * result, reopening a session left the card with only its title, its output gone — a screen that
   * had only ever existed for whoever watched it live.
   */
  const call = (seq: number) => ({
    sessionId: 's',
    seq,
    role: 'system' as const,
    kind: 'tool_call' as const,
    payload: { type: 'tool_call', summary: { tool: 'Bash', title: 'pnpm test', readOnly: true } },
    ts: 0,
  })
  const result = (seq: number, summary: string, ok = true) => ({
    sessionId: 's',
    seq,
    role: 'system' as const,
    kind: 'tool_result' as const,
    payload: { type: 'tool_result', callId: 'c1', ok, summary },
    ts: 0,
  })

  it('a result row attaches to a tool row that has no result yet', () => {
    const items = messagesToChat([call(1), result(2, '3 passed')])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'tool', result: '3 passed', ok: true })
  })

  it('with several calls, they are paired in the order they were emitted — the two are never swapped', () => {
    const items = messagesToChat([call(1), call(2), result(3, 'first'), result(4, 'second', false)])
    expect(items.map((i) => (i.kind === 'tool' ? [i.result, i.ok] : null))).toEqual([
      ['first', true],
      ['second', false],
    ])
  })

  it('a result with no match is discarded — never creates a row that never existed', () => {
    expect(messagesToChat([result(1, 'output with no owner')])).toEqual([])
  })
})

/**
 * A tool row finds its own result and output by `callId` (#98).
 *
 * A background agent's card stays open from the moment it is raised until it finishes (the adapter
 * withholds the result of raising it), and in the meantime the parent uses its own tool. The
 * positional rule (the longest-open row, the last-opened row) swaps ownership between them during
 * that window — the parent's Bash result to the agent's card, the agent's own steps to the parent's
 * Bash card. Both the live and restored paths are checked together.
 */
describe('a tool row finds its pair by callId — beside an open agent card (#98)', () => {
  const agentCall = {
    type: 'tool_call', callId: 'toolu_agent',
    summary: { tool: 'Agent', title: 'Research the build', readOnly: false, paths: [] },
  }
  const bashCall = {
    type: 'tool_call', callId: 'toolu_bash',
    summary: { tool: 'Bash', title: 'git status', readOnly: false, paths: [] },
  }
  const bashDone = { type: 'tool_result', callId: 'toolu_bash', ok: true, summary: 'nothing to commit' }
  const agentDone = { type: 'tool_result', callId: 'toolu_agent', ok: true, summary: '3 tool uses · 2m 14s\n\nI checked all 13 items' }
  const tools = (items: ReturnType<typeof messagesToChat>) =>
    items.flatMap((i) => (i.kind === 'tool' ? [{ tool: i.tool, result: i.result, live: i.live }] : []))

  it('live: the parent\'s result to the parent\'s card, the agent\'s steps to the agent\'s card', async () => {
    const s = 'cid-live'
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)
    const send = (e: object) => useStore.getState().dispatchEvent({ sessionId: s, ...e } as NormalizedEvent)

    send(agentCall)
    send({ type: 'tool_output_delta', callId: 'toolu_agent', text: 'Running in the background\n' })
    send(bashCall)
    // The agent takes a step while the parent's Bash is still open
    send({ type: 'tool_output_delta', callId: 'toolu_agent', text: 'Grep: boundaries\n' })
    send(bashDone)

    expect(tools(useStore.getState().chat[s] ?? [])).toEqual([
      { tool: 'Agent', result: undefined, live: 'Running in the background\nGrep: boundaries\n' },
      { tool: 'Bash', result: 'nothing to commit', live: undefined },
    ])

    send(agentDone)
    expect(tools(useStore.getState().chat[s] ?? [])[0]).toEqual({
      tool: 'Agent', result: '3 tool uses · 2m 14s\n\nI checked all 13 items', live: undefined,
    })
  })

  it('restoration: finds its own pair even when the stored order differs from the call order', () => {
    const row = (seq: number, kind: 'tool_call' | 'tool_result', payload: object) =>
      ({ sessionId: 's', seq, role: 'system' as const, kind, payload, ts: 0 })
    const items = messagesToChat([
      row(1, 'tool_call', agentCall),
      row(2, 'tool_call', bashCall),
      row(3, 'tool_result', bashDone),
      row(4, 'tool_result', agentDone),
    ])
    expect(tools(items).map((t) => [t.tool, t.result])).toEqual([
      ['Agent', '3 tool uses · 2m 14s\n\nI checked all 13 items'],
      ['Bash', 'nothing to commit'],
    ])
  })

  it('restoration: a result whose call sits outside this batch never grabs an open agent card', () => {
    const items = messagesToChat([
      { sessionId: 's', seq: 1, role: 'system', kind: 'tool_call', payload: agentCall, ts: 0 },
      { sessionId: 's', seq: 2, role: 'system', kind: 'tool_result', payload: { ...bashDone, callId: 'toolu_elsewhere' }, ts: 0 },
    ])
    expect(tools(items)).toEqual([{ tool: 'Agent', result: undefined, live: undefined }])
  })
})

/**
 * A launch card's subagent steps (#222): read only when the person opens them, never part of the conversation, and
 * joined live by later steps once every earlier one is read.
 */
describe('a subagent\'s steps under its launch card (#222)', () => {
  const AGENT = 'toolu_agent'
  const step = (sessionId: string, s: object) =>
    ({ type: 'subagent_event', sessionId, parentCallId: AGENT, step: { sessionId, ...s } }) as NormalizedEvent
  const grep = (sessionId: string) =>
    step(sessionId, { type: 'tool_call', callId: 'toolu_sub', summary: { tool: 'Grep', title: 'Grep: boundaries', readOnly: true, paths: [] } })
  const grepDone = (sessionId: string) => step(sessionId, { type: 'tool_result', callId: 'toolu_sub', ok: true, summary: 'tooling/boundaries.test.ts' })
  const said = (sessionId: string, text: string) => step(sessionId, { type: 'message_delta', role: 'assistant', text })

  const setup = async (s: string) => {
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)
    mock.emit({ sessionId: s, type: 'tool_call', callId: AGENT, summary: { tool: 'Agent', title: 'Research', readOnly: true, paths: [] } } as NormalizedEvent)
    return mock
  }
  const steps = (s: string) => messagesToChat(useStore.getState().subagentSteps[s]?.[AGENT]?.rows ?? []).map(line)

  it('a step is not the conversation: no row, no unread, no state change, nothing read until the card is opened', async () => {
    const s = 'sub-quiet'
    const mock = await setup(s)
    const before = useStore.getState().sessions[s]!
    const chat = useStore.getState().chat[s]
    mock.emit(grep(s))
    mock.emit(said(s, 'The test holds.'))
    expect(useStore.getState().chat[s]).toBe(chat)
    expect(useStore.getState().sessions[s]).toBe(before)
    expect(useStore.getState().subagentSteps[s]).toBeUndefined()
    expect(mock.subagentReads).toBe(0)
  })

  it('opening the card reads its steps once; closing and opening again does not read them again', async () => {
    const s = 'sub-open'
    const mock = await setup(s)
    mock.emit(grep(s))
    mock.emit(grepDone(s))
    mock.emit(said(s, 'The test holds.'))
    useStore.getState().toggleSubagentSteps(s, AGENT)
    await vi.waitFor(() => expect(steps(s)).toEqual(['Grep: boundaries', 'The test holds.']))
    expect(messagesToChat(useStore.getState().subagentSteps[s]![AGENT]!.rows)[0]).toMatchObject({ result: 'tooling/boundaries.test.ts' })
    useStore.getState().toggleSubagentSteps(s, AGENT)
    expect(useStore.getState().subagentSteps[s]![AGENT]!.open).toBe(false)
    useStore.getState().toggleSubagentSteps(s, AGENT)
    expect(mock.subagentReads).toBe(1)
  })

  it('a later step joins an opened card live, once, and not while earlier pages are unread', async () => {
    const s = 'sub-live'
    const mock = await setup(s)
    mock.emit(grep(s))
    useStore.getState().toggleSubagentSteps(s, AGENT)
    await vi.waitFor(() => expect(steps(s)).toEqual(['Grep: boundaries']))
    mock.emit(grepDone(s))
    mock.emit(said(s, 'Found it.'))
    // The same step arriving again (a replay) is drawn once
    useStore.getState().dispatchEvent({ ...(said(s, 'Found it.') as object), stepSeq: 3 } as NormalizedEvent)
    expect(steps(s)).toEqual(['Grep: boundaries', 'Found it.'])

    useStore.setState((st) => ({ subagentSteps: { ...st.subagentSteps, [s]: { [AGENT]: { ...st.subagentSteps[s]![AGENT]!, more: true } } } }))
    mock.emit(said(s, 'Past an unread page.'))
    expect(steps(s)).toEqual(['Grep: boundaries', 'Found it.'])
  })
})

/**
 * A failed turn **must be visible** (#107).
 *
 * An actual incident: a codex rollout carried the full 400 error in `task_complete`, but the app kept
 * an empty reply and a state of `waiting_input`. "Waiting for a human" was a lie — what needed waiting
 * for was an explanation, not a person. Both halves are checked together: does it survive in the
 * transcript, and is the state honest.
 */
describe('a failed turn reaches the screen (#107)', () => {
  const boom = (sessionId: string, message: string) =>
    ({ type: 'error', sessionId, error: { code: 'internal', message, retryable: true } }) as NormalizedEvent

  it('the error stands as one line in the transcript, and the session does not pretend to be idle', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('err-1', sessionInfo('err-1'))
    await useStore.getState().attach(mock)

    mock.emit(boom('err-1', "The 'opus[1m]' model is not supported"))

    const last = (useStore.getState().chat['err-1'] ?? []).at(-1)
    expect(last?.kind).toBe('mark')
    expect((last as { text: string }).text).toContain("The 'opus[1m]' model is not supported")
    expect(useStore.getState().sessions['err-1']?.state).toBe('error')
  })

  it('the line is still there after reopening — an error is stored as a marker', () => {
    const items = messagesToChat([
      {
        sessionId: 'err-2', seq: 4, role: 'system', kind: 'marker', ts: 1,
        payload: { type: 'error', sessionId: 'err-2', error: { code: 'internal', message: '400 invalid_request_error' } },
      },
    ])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: 'mark', seq: 4 })
    expect((items[0] as { text: string }).text).toContain('400 invalid_request_error')
  })
})

describe('messagesToChat — image rows (#40, second pass)', () => {
  it('a persisted image is restored into the conversation', () => {
    const items = messagesToChat([
      {
        sessionId: 's1', seq: 1, role: 'system', kind: 'image', ts: 1,
        payload: { type: 'message_image', sessionId: 's1', mime: 'image/png', data: 'aWJs', path: '/tmp/a.png' },
      },
    ])
    expect(items).toEqual([{ kind: 'image', seq: 1, storedSeq: 1, mime: 'image/png', data: 'aWJs', path: '/tmp/a.png', note: undefined }])
  })

  it('a cleaned-up image is restored with its reason — not a silent gap', () => {
    const items = messagesToChat([
      {
        sessionId: 's1', seq: 2, role: 'system', kind: 'image', ts: 1,
        payload: { type: 'message_image', sessionId: 's1', mime: 'image/png', data: '', path: '/tmp/b.png', note: 'The image was cleared and no longer exists (total-size cap)' },
      },
    ])
    expect(items[0]).toMatchObject({ kind: 'image', data: '', note: expect.stringContaining('cleared') })
  })
})

/** A reasoning summary (#58) — delta rows are restored as one block (the same rule as `assistant`) */
describe('messagesToChat — reasoning rows', () => {
  it('neighboring reasoning rows are different thoughts — they are never merged (#77)', () => {
    const row = (seq: number, kind: 'reasoning' | 'text', text: string) => ({
      sessionId: 's1', seq, role: 'assistant' as const, kind, ts: 1,
      payload: { type: kind === 'text' ? 'message_delta' : 'reasoning_delta', sessionId: 's1', text },
    })
    const items = messagesToChat([row(1, 'reasoning', '**Path review**'), row(2, 'reasoning', '**Test check**'), row(3, 'text', 'reply')])
    expect(items).toEqual([
      { kind: 'reasoning', seq: 1, storedSeq: 1, text: '**Path review**' },
      { kind: 'reasoning', seq: 2, storedSeq: 2, text: '**Test check**' },
      { kind: 'assistant', seq: 3, storedSeq: 3, text: 'reply' },
    ])
  })
})

/*
 * Two neighboring replies are two blocks (#77). A new reply with no human message in between (a
 * background task finished, a question card was answered) used to run together with the reply before
 * it, with no gap: "…still running.All six reviews are in." Messages are split by stored number — the
 * host groups a message's chunks into one row and carries that row's number on every chunk (#66). The
 * mock numbers them by the same rule.
 */
describe('neighboring replies are split by stored number (#77)', () => {
  const ask = (sessionId: string, seq: number, text: string) =>
    ({ sessionId, seq, role: 'user' as const, kind: 'text' as const, payload: { text }, ts: seq })
  const reply = (sessionId: string, seq: number, text: string) =>
    ({ sessionId, seq, role: 'assistant' as const, kind: 'text' as const, payload: { type: 'message_delta', text }, ts: seq })
  const shape = (id: string) => useStore.getState().chat[id]!.map((i) => [i.kind, i.storedSeq, line(i)])

  /** Opens a session whose history has four rows — the next message is number 5 */
  async function opened(id: string) {
    const mock = new MockPlatform()
    mock.sessions.set(id, sessionInfo(id))
    mock.messages.set(id, [ask(id, 1, 'question'), reply(id, 2, 'reply'), ask(id, 3, 'Run the review'), reply(id, 4, 'Six reviews started.')])
    await useStore.getState().attach(mock)
    useStore.getState().focusSession(id)
    await vi.waitFor(() => expect(useStore.getState().history[id]).toBeDefined())
    return mock
  }

  it('a chunk of message 6 arriving after a chunk of message 5 makes two items', async () => {
    const mock = await opened('s77-a')
    mock.emit(delta('s77-a', 'One review '))
    mock.emit(delta('s77-a', 'is still running.'))
    // The turn ends, and a new turn stands with no human message in between (a background task finished)
    mock.emit({ type: 'turn_complete', sessionId: 's77-a' } as never)
    mock.emit(delta('s77-a', 'All six reviews are in.'))
    expect(shape('s77-a').slice(-2)).toEqual([
      ['assistant', 5, 'One review is still running.'],
      ['assistant', 6, 'All six reviews are in.'],
    ])
  })

  it('chunks with the same number are gathered into one item — reasoning too', async () => {
    const mock = await opened('s77-b')
    mock.emit({ type: 'reasoning_delta', sessionId: 's77-b', text: '**Path ' } as never)
    mock.emit({ type: 'reasoning_delta', sessionId: 's77-b', text: 'review**' } as never)
    mock.emit(delta('s77-b', 'One review '))
    mock.emit(delta('s77-b', 'is still running.'))
    expect(shape('s77-b').slice(-2)).toEqual([
      ['reasoning', 5, '**Path review**'],
      ['assistant', 6, 'One review is still running.'],
    ])
  })

  it('reasoning with a different number also makes two items', async () => {
    const mock = await opened('s77-c')
    mock.emit({ type: 'reasoning_delta', sessionId: 's77-c', text: "the previous turn's thought" } as never)
    mock.emit({ type: 'turn_complete', sessionId: 's77-c' } as never)
    mock.emit({ type: 'reasoning_delta', sessionId: 's77-c', text: "the new turn's thought" } as never)
    expect(shape('s77-c').slice(-2)).toEqual([
      ['reasoning', 5, "the previous turn's thought"],
      ['reasoning', 6, "the new turn's thought"],
    ])
  })

  it('neighboring replies stay separate even after merging the history page with the live tail (mergePage)', async () => {
    const id = 's77-d'
    const mock = new MockPlatform()
    mock.sessions.set(id, sessionInfo(id))
    // Two neighboring replies already exist at the end of history
    mock.messages.set(id, [ask(id, 1, 'Run the review'), reply(id, 2, 'One review is still running.'), reply(id, 3, 'All six reviews are in.')])
    await useStore.getState().attach(mock)

    // The page is as of the moment it was requested, and the answer arrives later than a message that came after it (same condition as history cursor B)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = mock.agents.loadMessages.bind(mock.agents)
    mock.agents.loadMessages = async (...args: Parameters<typeof real>) => {
      const page = real(...args)
      await gate
      return page
    }
    useStore.getState().focusSession(id)
    mock.emit(delta(id, 'Here is the summary.'))
    release()
    await vi.waitFor(() => expect(useStore.getState().history[id]).toBeDefined())
    mock.agents.loadMessages = real
    // A new turn's message arriving after the merge also stands separately in the tail
    mock.emit({ type: 'turn_complete', sessionId: id } as never)
    mock.emit(delta(id, 'Anything else?'))

    expect(shape(id)).toEqual([
      ['user', 1, 'Run the review'],
      ['assistant', 2, 'One review is still running.'],
      ['assistant', 3, 'All six reviews are in.'],
      ['assistant', 4, 'Here is the summary.'],
      ['assistant', 5, 'Anything else?'],
    ])
  })
})

/**
 * A conversation item's **identity** — only a changed row becomes a new object.
 *
 * The screen's own optimization rests on this rule: `ChatRow` is memoized, so it does not re-render
 * while the item object stays the same. So when a single streaming chunk arrives, exactly **one**
 * bubble re-renders (measured at 1.0 renders per chunk). If the reducer ever did something like
 * `items.map((i) => ({ ...i }))`, that property would quietly disappear — the screen would look
 * identical while the cost grew in proportion to the conversation's length. The render count can only
 * be measured in a browser, but the identity it rests on can be pinned down right here.
 */
describe('a conversation item\'s identity — only a changed row becomes a new object', () => {
  const idOf = (sessionId: string) => useStore.getState().chat[sessionId] ?? []

  it('a streaming chunk only creates a new object for the last row', async () => {
    const s = 'ident-s1'
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)
    useStore.getState().dispatchEvent({ type: 'user_message', sessionId: s, seq: 1, text: 'question' } as NormalizedEvent)
    useStore.getState().dispatchEvent(delta(s, 'reply '))
    const before = idOf(s)
    expect(before.length).toBe(2)

    useStore.getState().dispatchEvent(delta(s, 'continuing'))
    const after = idOf(s)
    expect(after.length).toBe(2)
    expect(after[0]).toBe(before[0]) // The human message is untouched — same object
    expect(after[1]).not.toBe(before[1]) // Only the growing row becomes a new object
  })

  it('a tool result only creates a new object for that tool row — messages that came after it are untouched', async () => {
    const s = 'ident-s2'
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)
    useStore.getState().dispatchEvent({
      type: 'tool_call', sessionId: s, callId: 'c1',
      summary: { tool: 'Read', title: 'a.ts', readOnly: true, paths: [] },
    } as NormalizedEvent)
    useStore.getState().dispatchEvent(delta(s, 'reading'))
    const before = idOf(s)
    expect(before.length).toBe(2)

    useStore.getState().dispatchEvent({
      type: 'tool_result', sessionId: s, callId: 'c1', ok: true, summary: '12 lines',
    } as NormalizedEvent)
    const after = idOf(s)
    expect(after[0]).not.toBe(before[0]) // Only the tool row that received the result
    expect(after[1]).toBe(before[1]) // Messages after it are untouched
  })
})

/**
 * Restoring written text after a send failure (a follow-up to the loss incident of 2026-09-02).
 *
 * The composer is cleared the instant it is sent (#38). On failure, the bubble is removed, which
 * leaves the sentence **nowhere at all** — a toast only reports the failure, it does not return the
 * text. A failed sentence must come back to the composer to be sent again.
 */
describe('restoring written text after a send failure', () => {
  it('a failure returns the sentence to the composer', async () => {
    const s = 'sf-s1'
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)
    mock.sessions.delete(s) // The host refuses it (the same trick as the rename-failure test)

    await useStore.getState().send(s, 'a sentence that must not be lost')

    expect(useStore.getState().drafts[s]?.text).toBe('a sentence that must not be lost')
    expect(useStore.getState().toast).toMatch(/Could not send/)
    // Still no bubble left behind that looks sent (existing behavior kept)
    expect((useStore.getState().chat[s] ?? []).some((i) => i.kind === 'user')).toBe(false)
  })

  it('text written while waiting for the failure is not overwritten — the failed message is prepended in front of it', async () => {
    const s = 'sf-s2'
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)
    mock.sessions.delete(s)

    const inFlight = useStore.getState().send(s, 'the sentence sent first')
    useStore.getState().setDraft(s, { text: 'the sentence written meanwhile', attachments: [] })
    await inFlight

    expect(useStore.getState().drafts[s]?.text).toBe('the sentence sent first\nthe sentence written meanwhile')
  })

  it('a success leaves the composer untouched', async () => {
    const s = 'sf-s3'
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)

    await useStore.getState().send(s, 'a sentence that goes through')

    expect(useStore.getState().drafts[s]).toBeUndefined()
  })
})

/**
 * Warming up grid sessions (dogfooding, the Mea session: reviving a large codex thread measured at
 * 7-13 seconds). A cost that cannot be reduced is moved to a time nobody is waiting on: sessions parked on
 * the grid are woken up in the background as the app comes up. If it fails, the app still comes up,
 * and the failure is left in the same place (`wakeError`) as when woken by a click.
 */
describe('warming up grid sessions', () => {
  it('attach wakes sleeping sessions parked on the grid ahead of time', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('warm-a', sessionInfo('warm-a', { live: false }))
    mock.sessions.set('warm-b', sessionInfo('warm-b', { live: false }))
    await mock.agents.setGridView(['warm-a', 'warm-b'].map(sessionGridPanel))
    await useStore.getState().attach(mock)

    await vi.waitFor(() => {
      expect(useStore.getState().sessions['warm-a']!.live).toBe(true)
      expect(useStore.getState().sessions['warm-b']!.live).toBe(true)
    })
  })

  it('a wake failure is left in that panel\'s wakeError — the app still comes up', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('warm-c', sessionInfo('warm-c', { live: false }))
    mock.unresumable.add('warm-c')
    await mock.agents.setGridView([sessionGridPanel('warm-c')])
    await useStore.getState().attach(mock)

    await vi.waitFor(() => {
      expect(useStore.getState().wakeError['warm-c']).toBeTruthy()
    })
    expect(useStore.getState().connection).toBe('connected')
    expect(useStore.getState().sessions['warm-c']!.live).toBe(false)
  })
})

/**
 * Handing off and starting fresh (a dogfooding request — the way out of the 7-13 second resume delay
 * on an old thread). The dying session's written text becomes the new session's first message, its
 * name and settings carry over, and the old session is deleted all the way to its own original —
 * since #204 it goes to the trash, and its tool file goes when it is deleted for good.
 * Destruction comes last — a failure deletes nothing.
 */
/**
 * App state (#81): the store does not know the app list — an entry only appears through `ensure`
 * (first use) or the `app_state_changed` broadcast. Only the app knows what the document means.
 */
describe('app state (#81)', () => {
  it('ensure loads it, a broadcast triggers a re-read, and setAppDoc updates the screen first', async () => {
    const mock = new MockPlatform()
    mock.appDocs.set('control', { notifies: [{ id: 'n1', text: 'first notification', ts: 1 }] })
    await useStore.getState().attach(mock)

    // First use: ensure fills it in
    await useStore.getState().ensureAppState('control')
    expect((useStore.getState().apps['control']?.doc as { notifies: unknown[] }).notifies).toHaveLength(1)

    // A change on the host's side arrives as a broadcast — the store re-reads it
    mock.appDocs.set('control', { notifies: [] })
    mock.emit({ type: 'app_state_changed', appId: 'control' } as NormalizedEvent)
    await vi.waitFor(() => {
      expect((useStore.getState().apps['control']?.doc as { notifies: unknown[] }).notifies).toHaveLength(0)
    })

    // A change on the UI's side updates the screen first, and saving follows
    await useStore.getState().setAppDoc('control', { notifies: [], metrics: { replies: 1 } })
    expect(mock.appDocs.get('control')).toMatchObject({ metrics: { replies: 1 } })

    // The toggle goes through the same channel
    await useStore.getState().setAppEnabled('control', false)
    expect(useStore.getState().apps['control']?.enabled).toBe(false)
    expect(mock.appDisabled.has('control')).toBe(true)
  })

  /*
   * Never writes over a document that has not been read (#178). If the first read failed, the rail's
   * `doc` is `null`, and pressing one row sent a document holding only `{ metrics }` to the host,
   * overwriting tasks, monitoring and notifications entirely.
   */
  it('if the document has not been read yet, setAppDoc never writes and re-reads instead (#178)', async () => {
    useStore.setState({ apps: {} })
    const mock = new MockPlatform()
    const full = { tasks: [{ id: 't1', title: 'T' }], watches: [{ id: 'w', pattern: 'git push' }], metrics: { inlineReplies: 7 } }
    mock.appDocs.set('control', full)
    await useStore.getState().attach(mock)
    const read = vi.spyOn(mock.apps, 'state').mockRejectedValueOnce(new Error('offline'))
    await useStore.getState().ensureAppState('control')
    expect(useStore.getState().apps['control']).toBeUndefined()

    await useStore.getState().setAppDoc('control', { metrics: { inlineReplies: 1 } })
    expect(mock.appDocs.get('control')).toEqual(full)
    // Discarded the write and triggered a re-read instead — the next write happens on the real document
    await vi.waitFor(() => expect(useStore.getState().apps['control']?.doc).toEqual(full))
    expect(read).toHaveBeenCalledTimes(2)
  })
})

/**
 * An external app's "changed" (M4 B-5): the store only counts, per (project, app). Re-reading is the
 * open view's own job, through its state tool — so unlike a built-in app, this never calls
 * `apps.state`.
 */
describe('an external app\'s change signal (M4 B-5)', () => {
  it('a broadcast only bumps that (project, app)\'s counter, and never re-reads a built-in app\'s state', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const reads = vi.spyOn(mock.apps, 'state')

    mock.emit({ type: 'external_app_state_changed', appId: 'notes', projectId: 'p1' } as NormalizedEvent)
    mock.emit({ type: 'external_app_state_changed', appId: 'notes', projectId: 'p1' } as NormalizedEvent)
    mock.emit({ type: 'external_app_state_changed', appId: 'notes', projectId: null } as NormalizedEvent)
    await vi.waitFor(() => expect(useStore.getState().externalAppChanges[externalAppKey(null, 'notes')]).toBe(1))

    expect(useStore.getState().externalAppChanges).toEqual({ 'p1/notes': 2, '_user/notes': 1 })
    // The `notes` app of two different projects are two different apps — their keys never collide
    expect(externalAppKey('p2', 'notes')).not.toBe(externalAppKey('p1', 'notes'))
    expect(reads).not.toHaveBeenCalled()
    expect(useStore.getState().apps['notes']).toBeUndefined()
  })

  it('a run signal (M4 D-6) only bumps the runs panel\'s counter — the counter the view listens to stays untouched', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.emit({ type: 'external_app_runs_changed', appId: 'notes', projectId: 'p1' } as NormalizedEvent)
    mock.emit({ type: 'external_app_runs_changed', appId: 'notes', projectId: null } as NormalizedEvent)
    await vi.waitFor(() => expect(useStore.getState().externalAppRunChanges).toEqual({ 'p1/notes': 1, '_user/notes': 1 }))
    // A read-only tool's chain also arrives through this signal — waking the view would bring back #190's loop
    expect(useStore.getState().externalAppChanges).toEqual({})
  })

  it('keeps the view instance that caused the change beside the counter — only when it came from a view; null when there is no session, app or owner', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const key = externalAppKey('p1', 'notes')
    const say = (cause?: Record<string, unknown>) =>
      mock.emit({ type: 'external_app_state_changed', appId: 'notes', projectId: 'p1', ...(cause ? { cause } : {}) } as NormalizedEvent)
    const seen = () => [useStore.getState().externalAppChanges[key], useStore.getState().externalAppChangedBy[key]]

    say({ kind: 'view', instanceId: 'frame-a' })
    await vi.waitFor(() => expect(seen()).toEqual([1, 'frame-a']))
    say({ kind: 'session', sessionId: 's1' })
    await vi.waitFor(() => expect(seen()).toEqual([2, null]))
    say({ kind: 'view', instanceId: 'frame-b' })
    await vi.waitFor(() => expect(seen()).toEqual([3, 'frame-b']))
    // A change with no owner (the app came up again, the host merged mixed sources) — everyone hears it
    say()
    await vi.waitFor(() => expect(seen()).toEqual([4, null]))
  })
})

/** A single discovered external app (one row of the host's `apps.list`) */
function appInfo(appId: string, over: Partial<ExternalAppInfo> = {}): ExternalAppInfo {
  return {
    appId, projectId: 'p1', dir: `/tmp/p1/.centralu/apps/${appId}`, name: `App ${appId}`, version: '0.1.0',
    description: null, home: 'home', trusted: true, status: 'stopped', error: null, warnings: [], ...over,
  }
}

/**
 * The external app list (M4 A-8): the store holds a copy of the host's `apps.list`. The broadcast
 * (`external_apps_changed`) never carries what changed, so the whole list is re-read. While an app is
 * coming up, broadcasts arrive back to back (coming up → up), so reads overlap. If an overlapping read
 * overwrites the new list with an old one, the sidebar shows a running app as "coming up" forever.
 */
describe('the external app list (M4 A-8)', () => {
  it('reads on the first attach, and re-reads every time a broadcast arrives', async () => {
    const mock = new MockPlatform()
    mock.externalAppList = [appInfo('notes')]
    await useStore.getState().attach(mock)
    expect(useStore.getState().externalApps.map((a) => a.appId)).toEqual(['notes'])

    mock.setExternalApps([appInfo('notes', { status: 'running' }), appInfo('timer', { projectId: null })])
    await vi.waitFor(() => expect(useStore.getState().externalApps).toHaveLength(2))
    expect(useStore.getState().externalApps[0]?.status).toBe('running')
  })

  it('another broadcast arriving mid-read triggers one more read after it finishes — the last list wins', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const list = vi.spyOn(mock.apps, 'list')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    // The first read holds the list as of that moment (coming up) and returns late
    list.mockImplementationOnce(async () => {
      const snap = structuredClone(mock.externalAppList)
      await gate
      return snap
    })

    mock.setExternalApps([appInfo('notes', { status: 'starting' })])
    mock.setExternalApps([appInfo('notes', { status: 'running' })])
    release()

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(useStore.getState().externalApps[0]?.status).toBe('running'))
  })

  it('reattaching re-reads the list (a broadcast from the gap while disconnected never comes again)', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.externalAppList = [appInfo('notes', { status: 'failed', error: 'boom' })]
    mock.setConnectionState('disconnected')
    mock.setConnectionState('connected')
    await vi.waitFor(() => expect(useStore.getState().externalApps[0]?.status).toBe('failed'))
  })
})

/**
 * Trust (M4, decision 3): asked **once**, at registration, and answering nothing sends nothing.
 * Picking an already-trusted project again is never asked about.
 */
describe('project trust (M4)', () => {
  it('a newly registered project is asked once — "later" sends nothing, "trust" sends it and records it on screen', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const p = await useStore.getState().addProject('/tmp/trust-a')
    expect(useStore.getState().trustAsk).toBe(p.id)

    await useStore.getState().answerTrustAsk(false)
    expect(useStore.getState().trustAsk).toBeNull()
    expect(mock.trustCalls).toEqual([])
    expect(useStore.getState().projects[p.id]?.trusted).toBe(false)

    const q = await useStore.getState().addProject('/tmp/trust-b')
    await useStore.getState().answerTrustAsk(true)
    expect(mock.trustCalls).toEqual([{ projectId: q.id, trusted: true }])
    expect(useStore.getState().projects[q.id]?.trusted).toBe(true)
    expect(useStore.getState().trustAsk).toBeNull()

    // The same folder was picked again — already trusted, so it is never asked about again
    await useStore.getState().addProject('/tmp/trust-b')
    expect(useStore.getState().trustAsk).toBeNull()
  })

  it('only when a running session exists, states in one line that changed trust applies when that session restarts or resumes', async () => {
    const mock = new MockPlatform()
    const busy = await mock.projects.add('/tmp/trust-busy')
    mock.sessions.set('trust-live', sessionInfo('trust-live', { projectId: busy.id, live: true }))
    await useStore.getState().attach(mock)
    const quiet = await useStore.getState().addProject('/tmp/trust-quiet')

    await useStore.getState().setProjectTrusted(quiet.id, true)
    expect(useStore.getState().toast).toBeNull()

    await useStore.getState().setProjectTrusted(busy.id, true)
    expect(useStore.getState().toast).toBe('Running sessions here pick up the new trust when they restart or resume.')
  })

  it('turning off trust blocks that project\'s app list, following the broadcast', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const p = await useStore.getState().addProject('/tmp/trust-c')
    await useStore.getState().setProjectTrusted(p.id, true)
    mock.setExternalApps([appInfo('notes', { projectId: p.id })])
    await vi.waitFor(() => expect(useStore.getState().externalApps[0]?.status).toBe('stopped'))

    await useStore.getState().setProjectTrusted(p.id, false)
    expect(useStore.getState().projects[p.id]?.trusted).toBe(false)
    await vi.waitFor(() => expect(useStore.getState().externalApps[0]?.status).toBe('untrusted'))
  })
})

/**
 * Apps on the grid (#288). The grid's list holds tagged references, and an app's panel shows a view of its own,
 * apart from the app's pinned view that the app view and the project screen share (owner decision: the same app can
 * stand in more than one place, each its own view, one process).
 */
describe('apps on the grid (#288)', () => {
  const live = async () => {
    const mock = new MockPlatform()
    const p = await mock.projects.add('/tmp/grid-apps')
    mock.sessions.set('ga-s1', sessionInfo('ga-s1', { projectId: p.id }))
    mock.externalAppList = [appInfo('slider', { projectId: p.id }), appInfo('notes', { projectId: null })]
    await useStore.getState().attach(mock)
    useStore.setState({ pinnedViews: [], focusedApp: null })
    return { mock, pid: p.id }
  }
  const app = (projectId: string | null, appId: string) => ({ kind: 'app' as const, projectId, appId })
  const keys = () => useStore.getState().pinnedViews.map((p) => p.key)

  it('a list of bare session ids from a host older than this build is read as session panels', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('ga-old', sessionInfo('ga-old'))
    // What `grid.get` answered before apps could stand on the grid
    Object.assign(mock.agents, { grid: async () => ['ga-old'] })
    await useStore.getState().attach(mock)
    expect(useStore.getState().gridPanels).toEqual([sessionGridPanel('ga-old')])
  })

  it('sessions, a project’s app and a user-folder app are saved in one order and come back from the host', async () => {
    const { mock, pid } = await live()
    const list = [app(null, 'notes'), sessionGridPanel('ga-s1'), app(pid, 'slider')]
    await useStore.getState().setGridPanels(list)
    expect(useStore.getState().gridPanels).toEqual(list)
    expect(await mock.agents.grid()).toEqual(list)
  })

  it('an app on the grid gets a view of its own, apart from its pinned view, and each opens its own instance', async () => {
    const { mock, pid } = await live()
    useStore.getState().ensureGridAppView(pid, 'slider')
    useStore.getState().ensureGridAppView(pid, 'slider')
    useStore.getState().ensurePinnedView(pid, 'slider')
    expect(keys()).toEqual([gridAppViewKey(pid, 'slider'), externalAppKey(pid, 'slider')])
    for (const k of keys()) await useStore.getState().startPinnedView(k)
    expect(mock.openedViews).toEqual([
      { appId: 'slider', projectId: pid },
      { appId: 'slider', projectId: pid },
    ])
    expect(new Set(useStore.getState().pinnedViews.map((p) => p.instanceId)).size).toBe(2)
  })

  it('taking an app panel off the grid tears its view down first, then releases it, and leaves the app’s pinned view alone', async () => {
    const { mock, pid } = await live()
    await useStore.getState().setGridPanels([app(pid, 'slider'), sessionGridPanel('ga-s1')])
    useStore.getState().ensureGridAppView(pid, 'slider')
    useStore.getState().ensurePinnedView(pid, 'slider')
    for (const k of keys()) await useStore.getState().startPinnedView(k)
    const gridView = useStore.getState().pinnedViews.find((p) => p.key === gridAppViewKey(pid, 'slider'))!
    const order: string[] = []
    const off = registerPinnedFrame(gridView.key, {
      teardown: async () => {
        order.push(`teardown, ${mock.closedViews.length} closed`)
        return 'answered'
      },
    })

    await useStore.getState().setGridPanels([sessionGridPanel('ga-s1')])
    await vi.waitFor(() => expect(keys()).toEqual([externalAppKey(pid, 'slider')]))
    off()
    expect(order).toEqual(['teardown, 0 closed'])
    expect(mock.closedViews).toEqual([gridView.instanceId])
    expect(useStore.getState().gridPanels).toEqual([sessionGridPanel('ga-s1')])
  })

  it('the grid lays views over its app panels only while it is on show, and only for apps the list has', async () => {
    const { pid } = await live()
    useStore.setState({
      gridPanels: [app(pid, 'slider'), sessionGridPanel('ga-s1'), app(pid, 'removed'), app(null, 'notes')],
      view: 'focus',
    })
    expect(gridScreenAppKeys(useStore.getState())).toEqual([])
    useStore.setState({ view: 'grid' })
    expect(gridScreenAppKeys(useStore.getState())).toEqual([gridAppViewKey(pid, 'slider'), gridAppViewKey(null, 'notes')])
  })
})

/**
 * A pinned view (M4 B-2): an opened view survives a focus change. Its instance is created once by the
 * host calling `home`, and released when closed. If it was closed while opening, the just-opened
 * instance is released too — otherwise a view nobody watches would hold onto the app forever.
 */
describe('a pinned view (M4 B-2)', () => {
  const live = async () => {
    const mock = new MockPlatform()
    mock.sessions.set('pin-s1', sessionInfo('pin-s1'))
    mock.externalAppList = [appInfo('slider')]
    await useStore.getState().attach(mock)
    useStore.setState({ pinnedViews: [], focusedApp: null })
    return mock
  }
  const pinned = () => useStore.getState().pinnedViews

  it('opening stands up a slot, going to look at a session leaves it in place, and opening it again creates nothing new', async () => {
    const mock = await live()
    useStore.getState().openApp('p1', 'slider')
    expect(useStore.getState()).toMatchObject({ view: 'app', focusedApp: { projectId: 'p1', appId: 'slider' }, focusedProjectId: 'p1' })
    await useStore.getState().startPinnedView('p1/slider')
    const opened = pinned()[0]
    expect(opened).toMatchObject({ key: 'p1/slider', phase: 'open', instanceId: expect.stringMatching(/^mock-view-/) })

    useStore.getState().focusSession('pin-s1')
    expect(useStore.getState().view).toBe('focus')
    expect(pinned()).toEqual([opened])

    useStore.getState().openApp('p1', 'slider')
    await useStore.getState().startPinnedView('p1/slider')
    expect(pinned()).toEqual([opened])
    expect(mock.openedViews).toEqual([{ appId: 'slider', projectId: 'p1' }])
  })

  it('closing releases the instance, removes the slot, and returns to the session that was being viewed', async () => {
    const mock = await live()
    useStore.getState().focusSession('pin-s1')
    useStore.getState().openApp('p1', 'slider')
    await useStore.getState().startPinnedView('p1/slider')
    const id = pinned()[0]!.instanceId

    useStore.getState().closeApp('p1/slider')
    expect(mock.closedViews).toEqual([id])
    expect(pinned()).toEqual([])
    expect(useStore.getState()).toMatchObject({ view: 'focus', focusedApp: null, focusedSessionId: 'pin-s1' })
  })

  it('closing it while it is opening also releases the just-opened instance', async () => {
    const mock = await live()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    mock.openViewProvider = async () => {
      await gate
      return { instanceId: 'late-view', tool: 'home', resourceUri: 'ui://slider/main', toolInput: {}, toolResult: { content: [] }, runId: 'r' }
    }
    useStore.getState().openApp('p1', 'slider')
    const opening = useStore.getState().startPinnedView('p1/slider')
    expect(pinned()[0]?.phase).toBe('opening')
    useStore.getState().closeApp('p1/slider')
    release()
    await opening
    expect(mock.closedViews).toEqual(['late-view'])
    expect(pinned()).toEqual([])
  })

  it('Restart releases the old instance, and reopens only **after** the host finishes restarting (B-6)', async () => {
    const mock = await live()
    useStore.getState().openApp('p1', 'slider')
    await useStore.getState().startPinnedView('p1/slider')
    const old = pinned()[0]!.instanceId
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    vi.spyOn(mock.apps, 'restart').mockImplementation(async () => {
      order.push('restart:begin')
      await gate
      order.push('restart:end')
    })
    const realOpen = mock.apps.openView
    vi.spyOn(mock.apps, 'openView').mockImplementation(async (appId, projectId) => {
      order.push('open')
      return realOpen(appId, projectId)
    })

    const restarting = useStore.getState().restartApp('p1/slider')
    expect(mock.closedViews).toEqual([old])
    // Even if the screen's effect tries to open it now (it is an app that can be opened), it does not open — restart tears down the app just brought up
    await useStore.getState().startPinnedView('p1/slider')
    release()
    await restarting
    expect(pinned()[0]?.phase).toBe('idle')
    await useStore.getState().startPinnedView('p1/slider')
    expect(order).toEqual(['restart:begin', 'restart:end', 'open'])
    expect(pinned()[0]).toMatchObject({ phase: 'open', instanceId: expect.not.stringMatching(old!) })
  })

  it('a pinned view that was being viewed is restored — an app not in the list leaves the focus view instead', async () => {
    const mock = new MockPlatform()
    mock.externalAppList = [appInfo('slider')]
    mock.workspaceSnapshot = { view: 'app', focusedApp: { projectId: 'p1', appId: 'slider' } }
    useStore.setState({ pinnedViews: [], focusedApp: null })
    await useStore.getState().attach(mock)
    expect(useStore.getState()).toMatchObject({ view: 'app', focusedApp: { projectId: 'p1', appId: 'slider' } })
    expect(pinned().map((p) => p.key)).toEqual(['p1/slider'])

    const gone = new MockPlatform()
    gone.workspaceSnapshot = { view: 'app', focusedApp: { projectId: 'p1', appId: 'slider' } }
    useStore.setState({ pinnedViews: [], focusedApp: null, view: 'focus' })
    await useStore.getState().attach(gone)
    expect(useStore.getState().view).toBe('focus')
    expect(pinned()).toEqual([])
  })
})

/**
 * A project's default model belongs to **the tool** (#107).
 *
 * An actual incident: a project with `default_tool=codex` was also holding
 * `default_model=opus[1m]`, and a codex session born from it died every turn with a
 * `400 invalid_request_error`. A handoff deliberately clears the model when the tool changes
 * (`sameTool ? … : undefined`), but the project default filled it right back in beneath that guard —
 * a shape where the guard collapsed onto a layer it had delegated to.
 */
describe('a project\'s default model follows the tool (#107)', () => {
  const withDefaults = async (mock: MockPlatform, path: string, defaults: Record<string, { model: string | null; effort: string | null }>) => {
    const proj = await mock.projects.add(path)
    proj.defaultModels = defaults
    proj.defaultTool = 'claude'
    return proj
  }

  it('a different tool receives only that tool\'s own memory — with none, nothing is sent at all', async () => {
    const mock = new MockPlatform()
    const proj = await withDefaults(mock, '/tmp/def-1', { claude: { model: 'opus', effort: 'high' } })
    await useStore.getState().attach(mock)

    await useStore.getState().createSession(proj.id, { tool: 'codex' })
    expect(mock.lastCreateParams?.tool).toBe('codex')
    expect(mock.lastCreateParams?.model).toBeUndefined()
    expect(mock.lastCreateParams?.effort).toBeUndefined()

    // The same tool still gets it as is — the remembering feature itself must keep working
    await useStore.getState().createSession(proj.id, { tool: 'claude' })
    expect(mock.lastCreateParams?.model).toBe('opus')
    expect(mock.lastCreateParams?.effort).toBe('high')
  })

  /*
   * Storing it per tool is not enough by itself: models retire. If the name picked yesterday is not
   * on today's list, sending it as is kills the session — `agents.models` is the source of truth.
   */
  it('drops a model that tool no longer accepts', async () => {
    const mock = new MockPlatform()
    const proj = await withDefaults(mock, '/tmp/def-2', { codex: { model: 'gpt-5-retired', effort: 'high' } })
    await useStore.getState().attach(mock)

    await useStore.getState().createSession(proj.id, { tool: 'codex' })
    expect(mock.lastCreateParams?.model).toBeUndefined()
    // Effort is a handle on the model, so it is dropped together — a `high` of unknown origin must never remain
    expect(mock.lastCreateParams?.effort).toBeUndefined()
  })

  it('a model still on the list is sent as is', async () => {
    const mock = new MockPlatform()
    const proj = await withDefaults(mock, '/tmp/def-3', { codex: { model: 'gpt-5.6-terra', effort: 'medium' } })
    await useStore.getState().attach(mock)

    await useStore.getState().createSession(proj.id, { tool: 'codex' })
    expect(mock.lastCreateParams?.model).toBe('gpt-5.6-terra')
    expect(mock.lastCreateParams?.effort).toBe('medium')
  })
})

describe('handing off and starting fresh', () => {
  it('makes a new session from the note, hands on the name, and moves the original to the trash (#204)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho1')
    mock.sessions.set('ho-s1', sessionInfo('ho-s1', { projectId: proj.id, name: 'Mea', model: 'gpt-5.6', tool: 'codex', externalId: 'rollout-1' }))
    const old = oldRepoNote(mock, 'ho-s1')
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-s1')
    // A handoff request is never hidden — it enters as the session's own ordinary message
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-s1'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    // The dying session writes its text **as the reply** (#142) — the host reads it from the record after that turn ends and places it as a file
    const notePath = mockNote(mock, 'ho-s1', 'To my successor: status summary')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-s1' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-s1', state: 'waiting_input' } as NormalizedEvent)
    await done

    /*
     * The new session's first message is **the note's location, not the note** (#102). A preview is
     * carried, but not the full text — the prompt's promise that length is not a constraint is only
     * true inside the file.
     */
    expect(mock.lastCreateParams?.initialPrompt).toContain(notePath)
    expect(mock.handoffNotes.get(notePath)).toBe('To my successor: status summary')
    expect(mock.lastCreateParams?.initialPrompt).toContain('To my successor: status summary') // Preview
    // Nothing was written to or cleared from the user's repository — even the old note's location is untouched (#142)
    expect(repoHandoffTraces(mock, old)).toEqual([])
    // The full text goes into the record — the only material that can never be recreated once the predecessor is gone
    // Its id goes along too (#106) — this is how the host's cleanup knows this note still has an owner
    expect(mock.lastCreateParams?.handoff).toEqual({ from: 'Mea', note: 'To my successor: status summary', fromSessionId: 'ho-s1' })
    expect(mock.lastCreateParams?.tool).toBe('codex')
    expect(mock.lastCreateParams?.model).toBe('gpt-5.6')
    const heir = [...mock.sessions.values()].find((r) => r.name === 'Mea')
    expect(heir).toBeDefined()
    expect(heir!.id).not.toBe('ho-s1')
    // The screen's summary also shows the inherited settings immediately — if it is only in the database while the menu says Default, it reads as "never carried over" (dogfooding)
    expect(useStore.getState().sessions[heir!.id]).toMatchObject({ model: 'gpt-5.6', effort: null })
    // The old session is in the trash (#204), its tool file marked to go when it is deleted for good
    expect(mock.sessions.has('ho-s1')).toBe(false)
    expect(mock.externallyDeleted).not.toContain('ho-s1')
    expect((await mock.trash.list()).sessions.find((x) => x.id === 'ho-s1')?.conversationFile).toBe('remove')
    // The screen is looking at the new session
    expect(useStore.getState().focusedSessionId).toBe(heir!.id)
  })

  it('inherits the grid slot — the successor stands at the same index, and the order does not shift', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho7')
    mock.sessions.set('ho-g1', sessionInfo('ho-g1', { projectId: proj.id }))
    mock.sessions.set('ho-g2', sessionInfo('ho-g2', { projectId: proj.id, name: 'Middle' }))
    mock.sessions.set('ho-g3', sessionInfo('ho-g3', { projectId: proj.id }))
    await mock.agents.setGridView(['ho-g1', 'ho-g2', 'ho-g3'].map(sessionGridPanel))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-g2')
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-g2'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    mockNote(mock, 'ho-g2', 'Please continue')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-g2' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-g2', state: 'waiting_input' } as NormalizedEvent)
    await done

    const heir = [...mock.sessions.values()].find((r) => r.name === 'Middle' && r.id !== 'ho-g2')!
    // The middle panel keeps its successor in place — a panel disappearing and reappearing would scramble the arrangement (dogfooding)
    expect(useStore.getState().gridPanels).toEqual(['ho-g1', heir.id, 'ho-g3'].map(sessionGridPanel))
    expect(useStore.getState().focusedSessionId).toBe(heir.id)
  })

  /*
   * Record mode (#78): asking an agent whose service has been cut off for a note is asking a
   * counterpart who cannot respond for a will — the host builds the record from the store's own
   * transcript and **asks the dead session nothing at all**.
   */
  it('record mode asks the dead session nothing, and leaves the original by default (#78)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-rec')
    mock.sessions.set('ho-r1', sessionInfo('ho-r1', { projectId: proj.id, name: 'Dead Mea', tool: 'codex', state: 'error' }))
    const old = oldRepoNote(mock, 'ho-r1')
    await useStore.getState().attach(mock)

    await useStore.getState().handoffSession('ho-r1', { mode: 'record', tool: 'claude' })

    // No message went out to the dead session — this is the whole reason this mode exists
    expect((useStore.getState().chat['ho-r1'] ?? []).some((i) => i.kind === 'user')).toBe(false)
    // The record also lands at **the same location** (#102) — only the producer differs, and what the successor receives is identical
    expect(mock.handoffNotes.get(notePathOf(mock, 'ho-r1'))).toContain('Handoff Record')
    expect(mock.lastCreateParams?.initialPrompt).toContain(notePathOf(mock, 'ho-r1'))
    expect(repoHandoffTraces(mock, old)).toEqual([]) // The user's repository is never touched (#142)
    expect(mock.lastCreateParams?.initialPrompt).toContain('Handoff Record') // Preview
    expect(mock.lastCreateParams?.handoff?.note).toContain('Handoff Record')
    expect(mock.lastCreateParams?.tool).toBe('claude')
    // The original survives — record mode's default is to preserve it (until the successor is confirmed)
    expect(mock.sessions.has('ho-r1')).toBe(true)
    expect(mock.externallyDeleted).not.toContain('ho-r1')
    // The name is inherited
    expect([...mock.sessions.values()].some((r) => r.name === 'Dead Mea' && r.id !== 'ho-r1')).toBe(true)
  })

  it('deletes nothing if the session errors while writing — destruction only follows success', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho2')
    mock.sessions.set('ho-s2', sessionInfo('ho-s2', { projectId: proj.id, name: 'Mea 2' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-s2')
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-s2'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    mock.emit({ type: 'state_change', sessionId: 'ho-s2', state: 'error' } as NormalizedEvent)
    await done

    expect(mock.sessions.has('ho-s2')).toBe(true)
    expect(mock.externallyDeleted).not.toContain('ho-s2')
    expect(useStore.getState().toast).toMatch(/Handoff failed/)
  })

  it('handing off to a different agent never carries over tool-specific settings', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho5')
    mock.sessions.set('ho-s5', sessionInfo('ho-s5', { projectId: proj.id, name: 'Switching', tool: 'codex', model: 'gpt-5.6', effort: 'high' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-s5', { tool: 'claude' })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-s5'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    mockNote(mock, 'ho-s5', 'note')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-s5' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-s5', state: 'waiting_input' } as NormalizedEvent)
    await done

    expect(mock.lastCreateParams?.tool).toBe('claude')
    // Passing codex's model and effort to claude kills session creation outright — never carried over
    expect(mock.lastCreateParams?.model).toBeUndefined()
    expect(mock.lastCreateParams?.effort).toBeUndefined()
    expect(mock.sessions.has('ho-s5')).toBe(false) // The delete default is still on
  })

  it('turning off deletion leaves the old session standing — a branch, not a switch', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho6')
    mock.sessions.set('ho-s6', sessionInfo('ho-s6', { projectId: proj.id, name: 'Branch' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-s6', { deleteOld: false })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-s6'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    mockNote(mock, 'ho-s6', 'branch note')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-s6' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-s6', state: 'waiting_input' } as NormalizedEvent)
    await done

    expect(mock.sessions.has('ho-s6')).toBe(true) // The old session survives
    expect(mock.externallyDeleted).not.toContain('ho-s6')
    expect([...mock.sessions.values()].filter((r) => r.name === 'Branch').length).toBe(2)
  })

  it('a running turn\'s report never mixes into the top of the note — the request waits for the turn to end (measured in the Mea session)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho4')
    mock.sessions.set('ho-s4', sessionInfo('ho-s4', { projectId: proj.id, name: 'Mea 4', state: 'working' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-s4')
    // The running turn has not ended yet — the prompt is never sent, only that turn's report streams in
    await new Promise((r) => setTimeout(r, 700))
    mock.emit({ type: 'message_delta', sessionId: 'ho-s4', role: 'assistant', text: 'Applied: report on the previous task' } as NormalizedEvent)
    expect((useStore.getState().chat['ho-s4'] ?? []).some((i) => i.kind === 'user')).toBe(false)

    // Only once the turn ends is the request finally sent
    mock.emit({ type: 'turn_complete', sessionId: 'ho-s4' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-s4', state: 'waiting_input' } as NormalizedEvent)
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-s4'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    mockNote(mock, 'ho-s4', '# 1. Project and objective')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-s4' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-s4', state: 'waiting_input' } as NormalizedEvent)
    await done

    // The report from the previous turn is not in the text — a handoff starting with "Applied:" was exactly that incident
    expect(mock.lastCreateParams?.handoff?.note).toBe('# 1. Project and objective')
    expect(mock.lastCreateParams?.initialPrompt).not.toContain('Applied:')
  })

  /*
   * #102: the predecessor was told "it is a file, so length is not a constraint" and then the result
   * was delivered as a single chat message — the longer it got, the more thorough the note, and the
   * more thorough, the more likely the successor died the moment it arrived (measured: handing a long
   * session off to codex produced an error). The first message now points at the note's **location**
   * instead, so no matter how long the note grows, the first message never grows with it.
   */
  it('even a long note never becomes a huge first message — what is handed over is a path, not the content (#102)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-big')
    mock.sessions.set('ho-big', sessionInfo('ho-big', { projectId: proj.id, name: 'a session that lived long' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-big')
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-big'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    const huge = '# 1. Project and objective\n' + 'This session ran long, and the note is just as long. '.repeat(20_000)
    const bigPath = mockNote(mock, 'ho-big', huge)
    mock.emit({ type: 'turn_complete', sessionId: 'ho-big' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-big', state: 'waiting_input' } as NormalizedEvent)
    await done

    const prompt = mock.lastCreateParams!.initialPrompt!
    // The note is over 500,000 characters, but the first message fits on one screen — that gap is exactly what this fix is
    expect(huge.length).toBeGreaterThan(500_000)
    expect(prompt.length).toBeLessThan(2_000)
    expect(prompt).toContain(bigPath)
    expect(prompt).toContain('# 1. Project and objective') // A preview is there
    // And the note is never lost — its full text lives somewhere that outlives the file (the record)
    const kept = mock.lastCreateParams?.handoff?.note ?? ''
    expect(kept).toHaveLength(huge.trim().length)
    expect(kept.endsWith('the note is just as long.')).toBe(true)
  })

  /*
   * #106: cleanup used to hang off a turn boundary — **the instant the successor's first turn ends.**
   * That condition asks neither whether the turn succeeded nor whether the note was ever read. In an
   * actual incident, the first turn died with a 400 in under a second, and the directory was empty
   * within three minutes. The successor was holding a path to a file that no longer existed, and that
   * text could never be recreated, since the session that wrote it had just been replaced.
   */
  it('the note survives even if the first turn fails — nothing is ever cleared at a turn boundary (#106)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-sweep')
    mock.sessions.set('ho-sw', sessionInfo('ho-sw', { projectId: proj.id, name: 'Cleanup' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-sw', { deleteOld: false })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-sw'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    const notePath = mockNote(mock, 'ho-sw', 'text that must not disappear before it is read')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-sw' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-sw', state: 'waiting_input' } as NormalizedEvent)
    await done

    const heir = [...mock.sessions.values()].find((r) => r.name === 'Cleanup' && r.id !== 'ho-sw')!
    // The first turn dies with a 400 — the note used to disappear right here
    mock.emit({
      type: 'error', sessionId: heir.id,
      error: { code: 'internal', message: "The 'opus[1m]' model is not supported", retryable: true },
    } as NormalizedEvent)
    // Same result even with a successful turn — the reasoning was "was it read," which cannot be observed
    mock.emit({ type: 'turn_complete', sessionId: heir.id } as NormalizedEvent)
    await new Promise((r) => setTimeout(r, 50))

    expect(mock.handoffNotes.get(notePath)).toBe('text that must not disappear before it is read')
  })

  /*
   * #104: running several sessions at once in one project is the whole reason this app exists, yet the
   * handoff file was one per project. So two handoffs running at the same time would (1) write to the
   * same location, letting whichever wrote later win — the one waiting quietly received a note with
   * the right shape and the wrong content — and (2) have the successor that finished its first turn
   * first clear away someone else's text with its cleanup.
   */
  it('two handoffs in the same project never overwrite or clear each other\'s text (#104)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-pair')
    mock.sessions.set('ho-a', sessionInfo('ho-a', { projectId: proj.id, name: 'Left' }))
    mock.sessions.set('ho-b', sessionInfo('ho-b', { projectId: proj.id, name: 'Right' }))
    await useStore.getState().attach(mock)

    // Both are started side by side — doing them one after the other would never surface this bug at all
    const a = useStore.getState().handoffSession('ho-a', { deleteOld: false })
    const b = useStore.getState().handoffSession('ho-b', { deleteOld: false })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-a'] ?? []).some((i) => i.kind === 'user')).toBe(true)
      expect((useStore.getState().chat['ho-b'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    const pathA = mockNote(mock, 'ho-a', "Left's note")
    const pathB = mockNote(mock, 'ho-b', "Right's note")
    for (const id of ['ho-a', 'ho-b']) {
      mock.emit({ type: 'turn_complete', sessionId: id } as NormalizedEvent)
      mock.emit({ type: 'state_change', sessionId: id, state: 'waiting_input' } as NormalizedEvent)
    }
    await Promise.all([a, b])

    // Each received its own predecessor's text — when there was one filename, both received whichever one was written last
    const paramsOf = (from: string) => mock.createParamsLog.find((x) => x.handoff?.from === from)
    expect(paramsOf('Left')?.handoff?.note).toBe("Left's note")
    expect(paramsOf('Right')?.handoff?.note).toBe("Right's note")
    expect(paramsOf('Left')?.initialPrompt).toContain(pathA)
    expect(paramsOf('Right')?.initialPrompt).toContain(pathB)

    /*
     * Even after one successor's first turn ends, **no text disappears** (#106). While cleanup hung
     * off a turn, whichever finished first cleared away someone else's text (what #104 fixed); now not
     * even its own predecessor's text is cleared here — there is no way to tell whether it was read.
     */
    const heirA = [...mock.sessions.values()].find((r) => r.name === 'Left' && r.id !== 'ho-a')!
    mock.emit({ type: 'turn_complete', sessionId: heirA.id } as NormalizedEvent)
    await new Promise((r) => setTimeout(r, 50))
    expect(pathA).not.toBe(pathB)
    expect(mock.handoffNotes.get(pathA)).toBe("Left's note")
    expect(mock.handoffNotes.get(pathB)).toBe("Right's note")
  })

  /*
   * The counterpart of #104 (#142): the old wait loop only checked "the file exists and is not
   * empty," so a file left behind by a past failed handoff was delivered as if it were the freshly
   * written note. Now that the note is a reply, the same trap becomes **the reply to a past request.**
   * A failed handoff leaves the same request and its reply sitting in the conversation, and the host
   * reads "the last reply after the request" as the note. Finding the request by taking the first one
   * makes that old reply the note.
   */
  it('a reply left by a past failure is never mistaken for a freshly written note (#104, #142)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-stale')
    mock.sessions.set('ho-st', sessionInfo('ho-st', { projectId: proj.id, name: 'an old spot' }))
    await useStore.getState().attach(mock)

    // A handoff that failed previously: the same request and its reply are already in the conversation
    mock.emit({ type: 'user_message', sessionId: 'ho-st', seq: 1, text: handoffPrompt() } as NormalizedEvent)
    mockNote(mock, 'ho-st', 'an old note left by a failed handoff last month')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-st' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-st', state: 'waiting_input' } as NormalizedEvent)

    const done = useStore.getState().handoffSession('ho-st', { deleteOld: false })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-st'] ?? []).filter((i) => i.kind === 'user').length).toBe(2)
    })
    // The predecessor ended this turn without answering anything — exactly the moment the old text used to be delivered
    mock.emit({ type: 'turn_complete', sessionId: 'ho-st' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-st', state: 'waiting_input' } as NormalizedEvent)
    await new Promise((r) => setTimeout(r, 1_500))
    expect(mock.createParamsLog).toEqual([]) // No successor is born — there is nothing yet for it to receive

    // Only once the real note arrives does it proceed
    mockNote(mock, 'ho-st', 'a new note just written')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-st' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-st', state: 'waiting_input' } as NormalizedEvent)
    await done
    expect(mock.lastCreateParams?.handoff?.note).toBe('a new note just written')
  })

  /*
   * #142: the note's location is the first human message after "the last recorded point right before
   * the request." If that point is measured by the screen's `lastSeq`, then while the confirmation
   * (`user_message`) for a message sent earlier has not yet arrived, `lastSeq` does not count that
   * message and lags behind — so the first human message after that lagging point is the earlier
   * message, and the request becomes "the next human message," so the reply is never read as the note
   * (this actually stalled in e2e).
   */
  it('never misses the request\'s point even when a previously sent message has not been confirmed yet (#142)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-lag')
    mock.sessions.set('ho-lag', sessionInfo('ho-lag', { projectId: proj.id, name: 'late confirmation' }))
    await useStore.getState().attach(mock)
    // A person spoke first and the turn ended — the mock never sends that message's confirmation (the screen's lastSeq does not know about it)
    await useStore.getState().send('ho-lag', 'the thing said first')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-lag' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-lag', state: 'waiting_input' } as NormalizedEvent)

    const done = useStore.getState().handoffSession('ho-lag', { deleteOld: false })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-lag'] ?? []).filter((i) => i.kind === 'user').length).toBe(2)
    })
    mockNote(mock, 'ho-lag', "the late confirmation's note")
    mock.emit({ type: 'turn_complete', sessionId: 'ho-lag' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-lag', state: 'waiting_input' } as NormalizedEvent)
    await done
    expect(mock.lastCreateParams?.handoff?.note).toBe("the late confirmation's note")
  })

  it('filters out worktree sessions — a worktree\'s lifetime is bound to its session', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho3')
    mock.sessions.set(
      'ho-s3',
      sessionInfo('ho-s3', { projectId: proj.id, worktree: { path: '/tmp/wt', branch: 'centralu/x' } }),
    )
    await useStore.getState().attach(mock)

    await useStore.getState().handoffSession('ho-s3')

    expect(mock.sessions.has('ho-s3')).toBe(true)
    expect((useStore.getState().chat['ho-s3'] ?? []).length).toBe(0)
    expect(useStore.getState().toast).toMatch(/Worktree sessions/)
  })
})

/** An MCP server suggestion card (option B) — a suggestion event re-reads the list, and clicking approve goes to the host */
describe('MCP server suggestions', () => {
  it('a propose_mcp_server tool call re-reads the suggestion list', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('mcp-s1', sessionInfo('mcp-s1'))
    await useStore.getState().attach(mock)
    mock.mcpProposalList.push({ name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'], why: 'browser' })

    mock.emit({
      type: 'tool_call', sessionId: 'mcp-s1', callId: 'c1',
      summary: { tool: 'mcp__centralu__propose_mcp_server', title: 'playwright', readOnly: true, paths: [] },
    } as NormalizedEvent)

    await vi.waitFor(() => {
      expect(useStore.getState().mcpProposals).toEqual([
        { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'], why: 'browser' },
      ])
    })
  })

  it('clicking approve is passed to the host and empties the list', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.mcpProposalList.push({ name: 'playwright', command: 'npx', args: [] })
    await useStore.getState().refreshMcpProposals()

    await useStore.getState().resolveMcpProposal('playwright', true)

    expect(mock.mcpApproved).toContain('playwright')
    expect(useStore.getState().mcpProposals).toEqual([])
    expect(useStore.getState().toast).toMatch(/Installing playwright/)
  })
})

/** A skill suggestion (#71) — the same rail as an MCP suggestion: an event wakes the list, and approval goes to the host */
describe('skill suggestions', () => {
  it('a propose_skill tool call re-reads the suggestion list, and approving leads to a save', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('sk-s1', sessionInfo('sk-s1'))
    await useStore.getState().attach(mock)
    mock.skillProposalList.push({ name: 'weekly-report', content: 'a summary every Friday', why: 'a recurring request' })

    mock.emit({
      type: 'tool_call', sessionId: 'sk-s1', callId: 'c1',
      summary: { tool: 'mcp__centralu__propose_skill', title: 'weekly-report', readOnly: true, paths: [] },
    } as NormalizedEvent)
    await vi.waitFor(() => {
      expect(useStore.getState().skillProposals).toEqual([
        { name: 'weekly-report', content: 'a summary every Friday', why: 'a recurring request' },
      ])
    })

    await useStore.getState().resolveSkillProposal('weekly-report', true)
    expect(mock.skillList).toEqual([{ name: 'weekly-report', content: 'a summary every Friday' }])
    expect(useStore.getState().skillProposals).toEqual([])
    expect(useStore.getState().toast).toMatch(/Skill saved/)
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
 * When a non-conversation event arrives before history is read (dogfooding, 2026-09-25).
 *
 * Reopening the app showed an 11,550-line session as completely empty. A state or usage event the
 * host sent while resuming the session created `chat[id] = []` before the user ever clicked that
 * session, and focusing read that empty array as "already read," so history was never called. There
 * was no error either.
 */
describe('an event arriving before history', () => {
  const many = (id: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      sessionId: id, seq: i + 1, role: 'user' as const, kind: 'text' as const,
      payload: { text: `line ${i + 1}` }, ts: i + 1,
    }))
  const quiet = [
    ['state_change', { type: 'state_change', state: 'idle' }],
    ['context_usage', { type: 'context_usage', used: 111693, window: 1000000, exactness: 'exact' }],
  ] as const

  it.each(quiet)('even if %s arrives first, clicking that session still shows history', async (_name, ev) => {
    const mock = new MockPlatform()
    mock.sessions.set('a', sessionInfo('a'))
    mock.sessions.set('b', sessionInfo('b'))
    mock.messages.set('b', many('b', 50))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('a')

    mock.emit({ sessionId: 'b', ...ev } as unknown as NormalizedEvent)
    useStore.getState().focusSession('b')

    await vi.waitFor(() => expect(useStore.getState().chat['b']).toHaveLength(50))
    expect(useStore.getState().history['b']?.more).toBe(false)
  })

  it('a non-conversation event slipping in mid-read never discards history', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('c', sessionInfo('c'))
    mock.messages.set('c', many('c', 30))
    await useStore.getState().attach(mock)

    // Holds back the answer so the event arrives after the history request goes out but before the answer comes back
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = mock.agents.loadMessages.bind(mock.agents)
    mock.agents.loadMessages = async (...args: Parameters<typeof real>) => {
      await gate
      return real(...args)
    }

    const loading = useStore.getState().loadHistory('c')
    mock.emit({ sessionId: 'c', type: 'state_change', state: 'idle' } as unknown as NormalizedEvent)
    release()
    await loading

    expect(useStore.getState().chat['c']).toHaveLength(30)
  })

  /*
   * The actual fix is here: a non-conversation event never creates a slot. `chat[id]` being absent is
   * used throughout the store as "not read yet" (focus, session creation). The two safeguards below
   * catch this at load time, so this promise would silently break without a test pinning it down on
   * its own.
   */
  it.each(quiet)('%s never creates an empty slot for an unread session', async (_name, ev) => {
    const mock = new MockPlatform()
    mock.sessions.set('g', sessionInfo('g'))
    await useStore.getState().attach(mock)

    mock.emit({ sessionId: 'g', ...ev } as unknown as NormalizedEvent)

    expect(useStore.getState().chat['g']).toBeUndefined()
    // State is still applied as usual — not creating a slot does not mean discarding the event
    expect(useStore.getState().sessions['g']).toBeDefined()
  })

  /*
   * The two below pin down the rule itself, **independent of any event**: an empty slot is treated the
   * same as never having read it. An event is not the only way an empty array gets created (a filter
   * that undoes an optimistically drawn row can also empty it). The tests above never see these two
   * safeguards, since the event-side fix already blocks it.
   */
  it('clicking a session with an empty slot and no cursor still calls history — no matter where the empty slot came from', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('a', sessionInfo('a'))
    mock.sessions.set('e', sessionInfo('e'))
    mock.messages.set('e', many('e', 20))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('a')

    useStore.setState((s) => ({ chat: { ...s.chat, e: [] } }))
    useStore.getState().focusSession('e')

    await vi.waitFor(() => expect(useStore.getState().chat['e']).toHaveLength(20))
  })

  it('if the slot is still empty by the time history arrives, history fills it — no matter where the empty slot came from', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('f', sessionInfo('f'))
    mock.messages.set('f', many('f', 25))
    await useStore.getState().attach(mock)

    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = mock.agents.loadMessages.bind(mock.agents)
    mock.agents.loadMessages = async (...args: Parameters<typeof real>) => {
      await gate
      return real(...args)
    }
    const loading = useStore.getState().loadHistory('f')
    useStore.setState((s) => ({ chat: { ...s.chat, f: [] } }))
    release()
    await loading

    expect(useStore.getState().chat['f']).toHaveLength(25)
  })

  it('even when a row already exists on screen, it is merged with history rather than cleared (the promise from 09-09, #79)', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('a', sessionInfo('a'))
    mock.sessions.set('d', sessionInfo('d'))
    mock.messages.set('d', many('d', 40))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('a')

    // A streaming message arrived first — this is a row that must never be cleared
    mock.emit(delta('d', 'writing right now'))
    useStore.getState().focusSession('d')
    await new Promise((r) => setTimeout(r, 20))

    const chat = useStore.getState().chat['d']!
    expect(chat.map((i) => (i as { text?: string }).text)).toContain('writing right now')
    expect(useStore.getState().history['d']).toBeDefined()
  })
})

/**
 * Restoring the slot of an in-conversation app view (M4 B-1). History carries no body, only "some
 * app's view stood (or was rejected) under this card" — a reopened UI stands a placeholder on that
 * card. Whether it can be reopened is unknown until the host is asked (`kept: false`). A history row
 * for an app view never becomes a conversation row (`ChatItem`).
 */
describe('inlineViewsFromHistory — a past card\'s app view slot', () => {
  const row = (seq: number, payload: Record<string, unknown>) =>
    ({ sessionId: 's-hist', seq, role: 'system' as const, kind: 'app_view' as const, payload, ts: 0 })
  const call = (seq: number, callId: string) =>
    ({ sessionId: 's-hist', seq, role: 'system' as const, kind: 'tool_call' as const, payload: { type: 'tool_call', callId, summary: { tool: 'mcp__app-viewer__show', title: 'show', readOnly: false, paths: [] } }, ts: 0 })

  it('an open becomes a placeholder of unknown reopenability, a rejection a placeholder with only a reason — the same card lets the later row win', () => {
    const msgs = [
      call(1, 'c-open'),
      row(2, { type: 'app_view', callId: 'c-open', appId: 'viewer', projectId: 'p1', tool: 'show', phase: 'open' }),
      call(3, 'c-spoof'),
      row(4, { type: 'app_view', callId: 'c-spoof', appId: 'viewer', projectId: null, tool: 'spoof', phase: 'rejected', reason: 'This app does not serve ui://other/main' }),
      call(5, 'c-late'),
      row(6, { type: 'app_view', callId: 'c-late', appId: 'viewer', projectId: 'p1', tool: 'show', phase: 'open' }),
      row(7, { type: 'app_view', callId: 'c-late', appId: 'viewer', projectId: 'p1', tool: 'show', phase: 'rejected', reason: "This call's result points at ui://other/main" }),
      // A malformed row is discarded
      row(8, { type: 'app_view', phase: 'open' }),
    ]
    expect(inlineViewsFromHistory(msgs)).toEqual({
      'c-open': { callId: 'c-open', appId: 'viewer', projectId: 'p1', tool: 'show', state: 'parked', instanceId: null, kept: false, liveAt: 0 },
      'c-spoof': {
        callId: 'c-spoof', appId: 'viewer', projectId: null, tool: 'spoof', state: 'parked', instanceId: null, kept: false, liveAt: 0,
        rejected: 'This app does not serve ui://other/main', reason: 'This app does not serve ui://other/main',
      },
      'c-late': {
        callId: 'c-late', appId: 'viewer', projectId: 'p1', tool: 'show', state: 'parked', instanceId: null, kept: false, liveAt: 0,
        rejected: "This call's result points at ui://other/main", reason: "This call's result points at ui://other/main",
      },
    })
    // The conversation's rows are only the three cards — a history row for an app view never becomes a row
    expect(messagesToChat(msgs).map((i) => i.kind)).toEqual(['tool', 'tool', 'tool'])
  })
})

/**
 * Reopening to follow new code (M4 C-4). The decision comes down to one thing: the list's fingerprint
 * (`codeStamp`) — if it differs from the code that was up when the view opened, it is stale HTML. If
 * it was unknown at open time (the app came up for the first time at that instant), only the first
 * value learned is recorded: reading that as a change would reopen a view that had just opened.
 */
describe('reopening to follow new code (M4 C-4)', () => {
  const pinned = () => useStore.getState().pinnedViews

  it('records the fingerprint if it is unknown at open time, and once it later changes, tears down and reopens the same slot', async () => {
    const mock = new MockPlatform()
    mock.externalAppList = [appInfo('slider', { status: 'running' })]
    await useStore.getState().attach(mock)
    useStore.setState({ pinnedViews: [], focusedApp: null })
    useStore.getState().openApp('p1', 'slider')
    await useStore.getState().startPinnedView('p1/slider')
    const first = pinned()[0]!
    expect(first).toMatchObject({ phase: 'open', codeStamp: null })
    const teardown = vi.fn(async () => 'answered')
    registerPinnedFrame('p1/slider', { teardown })

    mock.setExternalApps([appInfo('slider', { status: 'running', codeStamp: 'aaaa' })])
    await vi.waitFor(() => expect(pinned()[0]?.codeStamp).toBe('aaaa'))
    expect(teardown).not.toHaveBeenCalled()
    expect(mock.closedViews).toEqual([])

    mock.setExternalApps([appInfo('slider', { status: 'running', codeStamp: 'bbbb' })])
    await vi.waitFor(() => expect(pinned()[0]?.phase).toBe('idle'))
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(mock.closedViews).toEqual([first.instanceId])
    expect(pinned()).toEqual([expect.objectContaining({ key: 'p1/slider', instanceId: null, codeStamp: null, updatedAt: expect.any(Number) })])
    expect(useStore.getState().focusedApp).toEqual({ projectId: 'p1', appId: 'slider' })
    // Reopening the view receives the new fingerprint — after that it is quiet, since the fingerprint matches
    await useStore.getState().startPinnedView('p1/slider')
    expect(pinned()[0]).toMatchObject({ phase: 'open', codeStamp: 'bbbb', updatedAt: expect.any(Number) })
    // A view the person restarted themselves never shows "Updated" — that belongs only to a view that reopened with new code
    await useStore.getState().restartApp('p1/slider')
    expect(pinned()[0]).toMatchObject({ updatedAt: null, codeStamp: null })
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
 * The settings-change toast states what the host actually did (#164). It used to always say "(from
 * next turn)."
 */
describe('the settings-change toast (#164)', () => {
  it.each([
    ['after_turn', 'Effort: high (applies when this turn ends)'],
    ['restarted', 'Effort: high (agent restarted)'],
    ['saved', 'Effort: high (from next turn)'],
  ] as const)('%s → %s', async (applied, toast) => {
    const platform = new MockPlatform()
    const s = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'normal' })
    vi.spyOn(platform.agents, 'updateSettings').mockResolvedValue({ ...s, effort: 'high', applied })
    useStore.setState({ platform, sessions: { [s.id]: { ...s } as never } })

    await useStore.getState().updateSessionSettings(s.id, { effort: 'high' })
    expect(useStore.getState().toast).toBe(toast)
  })
})

/*
 * The "always allow" notification uses the matcher actually sent (#170). The card used to compose its
 * own separate wording, so even a kind with no matcher (`other`) was announced as "Always allow in
 * this session: other" — even though no rule had actually been kept.
 */
describe('the always-allow notification (#170)', () => {
  async function answerAlways(detail: Record<string, unknown>, scope: 'session' | 'project' = 'session') {
    const platform = new MockPlatform()
    const s = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'safe' })
    const spy = vi.spyOn(platform.agents, 'respondApproval').mockResolvedValue(undefined as never)
    useStore.setState({
      platform,
      sessions: { [s.id]: { ...s, pendingApproval: { requestId: 'r1', detail } } as never },
    })
    await useStore.getState().respondApproval(s.id, 'r1', 'always', scope)
    return { matcher: spy.mock.calls[0]?.[4], toast: useStore.getState().toast }
  }

  it('a file edit sends its path, and the notification states that path', async () => {
    const r = await answerAlways({ kind: 'file_edit', path: '/x/a.ts', diffPreview: '', multi: false }, 'project')
    expect(r.matcher).toBe('/x/a.ts')
    expect(r.toast).toBe('Always allow in this project: /x/a.ts')
  })

  it('a kind with no matcher never claims a rule was kept', async () => {
    const r = await answerAlways({ kind: 'other', raw: 'mcp__x__y {}' })
    expect(r.matcher).toBeUndefined()
    expect(r.toast).not.toContain('Always allow in')
    expect(r.toast).toContain('Allowed once')
  })
})

/*
 * #158: if a second input arrives on the same card before the first response's result reaches the
 * screen, the second response became a "vanished request" on the host and recorded a command that had
 * already run as Denied. A request is sent only once.
 */
describe('an approval is sent only once per request (#158)', () => {
  async function pendingCard() {
    const platform = new MockPlatform()
    const s = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'safe' })
    useStore.setState({
      platform,
      sessions: {
        [s.id]: { ...s, pendingApproval: { requestId: 'r1', detail: { kind: 'command', command: 'ls', cwd: '/tmp' } } } as never,
      },
    })
    return { platform, id: s.id }
  }

  it('a second input before the response returns is never sent', async () => {
    const { platform, id } = await pendingCard()
    const finish: (() => void)[] = []
    const spy = vi
      .spyOn(platform.agents, 'respondApproval')
      .mockImplementation(() => new Promise<void>((r) => void finish.push(r)))
    const first = useStore.getState().respondApproval(id, 'r1', 'allow')
    const second = useStore.getState().respondApproval(id, 'r1', 'deny')
    finish.forEach((f) => f())
    await Promise.all([first, second])
    expect(spy.mock.calls.map((c) => c[2])).toEqual(['allow'])
  })

  it('nothing is sent for a request whose card is already dismissed', async () => {
    const { platform, id } = await pendingCard()
    const spy = vi.spyOn(platform.agents, 'respondApproval').mockResolvedValue(undefined as never)
    useStore.setState((st) => ({ sessions: { ...st.sessions, [id]: { ...st.sessions[id]!, pendingApproval: null } } }))
    await useStore.getState().respondApproval(id, 'r1', 'allow')
    expect(spy).not.toHaveBeenCalled()
  })

  it('a send failure allows pressing it again', async () => {
    const { platform, id } = await pendingCard()
    const spy = vi.spyOn(platform.agents, 'respondApproval').mockRejectedValueOnce(new Error('Connection lost'))
    await useStore.getState().respondApproval(id, 'r1', 'allow')
    expect(useStore.getState().toast).toBe('Connection lost')
    spy.mockResolvedValue(undefined as never)
    await useStore.getState().respondApproval(id, 'r1', 'allow')
    expect(spy).toHaveBeenCalledTimes(2)
    expect(useStore.getState().approvalsInFlight).toEqual({})
  })
})

/*
 * #172: the host broadcasts `session_created`, `handoff` and `user_message`, in that order, before the
 * response, while creating a session. The screen registers the session from the first one and attaches
 * the other two to the conversation, but the returned response used to overwrite the conversation with
 * a single pending opening prompt, erasing the marker. Reading history brought the marker back, so the
 * opening prompt stood twice. The mock now broadcasts in the same order as the host.
 */
describe('the first screen of a session born from a handoff (#172)', () => {
  it('exactly one marker and one opening prompt stand, and reading back through history leaves them as is', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho172')
    await useStore.getState().attach(mock)
    // The history page arrives one round trip late — the merge with history (#197) sees the screen before the response's overwrite covers it
    const load = mock.agents.loadMessages.bind(mock.agents)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    vi.spyOn(mock.agents, 'loadMessages').mockImplementation(async (...a) => {
      await gate
      return load(...a)
    })

    const info = await useStore.getState().createSession(proj.id, {
      initialPrompt: 'OPENING',
      handoff: { from: 'Old', note: 'note', fromSessionId: 'old-172' },
    })
    const now = () => useStore.getState().chat[info.id] ?? []
    expect(now().map(line)).toEqual([expect.stringContaining('Handed off from "Old"'), 'OPENING'])
    // The opening prompt is a confirmed row — leaving it pending would let it absorb a later message with the same text
    expect(now().find((i) => i.kind === 'user' && i.pending)).toBeUndefined()

    release()
    expect(await readAll(info.id)).toEqual([expect.stringContaining('Handed off from "Old"'), 'OPENING', ...now().slice(2).map(line)])
    expect(now().filter((i) => i.kind === 'user' && i.text === 'OPENING')).toHaveLength(1)
    expect(now().filter((i) => i.kind === 'mark')).toHaveLength(1)
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
 * #174 (the rest of #125): when text cannot be an answer to a question (several questions, or an
 * attachment), sending it starts a new turn and drops the question. The hint text never looked at
 * attachments, so it said "write an answer" while sending the text as a new turn, and the card
 * vanished with no explanation. Handing off a session with an open question sent the request text as
 * that question's answer.
 */
describe('an open question and the composer (#174)', () => {
  const q = (requestId: string, ...questions: string[]) => ({
    requestId,
    questions: questions.map((question) => ({ question, header: 'h', options: [{ label: 'a', description: '' }], multiSelect: false })),
  })

  it('the hint text and sending use the same decision — an attachment means it is never an answer', () => {
    expect(composerTarget([], false)).toBe('none')
    expect(composerTarget([q('r1', 'Which DB?')], false)).toBe('answer')
    expect(composerTarget([q('r1', 'Which DB?')], true)).toBe('drops')
    expect(composerTarget([q('r1', 'Which DB?', 'Which port?')], false)).toBe('drops')
    expect(composerTarget([q('r1', 'Which DB?'), q('r2', 'Which port?')], false)).toBe('drops')
  })

  async function withQuestions(...open: ReturnType<typeof q>[]) {
    const mock = new MockPlatform()
    mock.sessions.set('q174', sessionInfo('q174', { state: 'waiting_approval', pendingQuestions: open as never }))
    await useStore.getState().attach(mock)
    const sent = vi.spyOn(mock.agents, 'send')
    const answered = vi.spyOn(mock.agents, 'answerQuestion')
    return { mock, sent, answered }
  }

  it('with several questions, the text goes to a new turn, and a line is left before the bubble stating what was dropped', async () => {
    const { sent, answered } = await withQuestions(q('r1', 'Which DB?', 'Which port?'))
    await useStore.getState().send('q174', 'just do it')
    expect(answered).not.toHaveBeenCalled()
    expect(sent).toHaveBeenCalledTimes(1)
    expect(useStore.getState().chat['q174']!.map(line)).toEqual([droppedQuestionsText(['Which DB?', 'Which port?']), 'just do it'])
  })

  it('even one question takes the same path once there is an attachment', async () => {
    const { sent, answered } = await withQuestions(q('r1', 'Which DB?'))
    await useStore.getState().send('q174', 'see this', [{ kind: 'file', path: '/tmp/a.txt', name: 'a.txt', mime: 'text/plain', bytes: 1 }])
    expect(answered).not.toHaveBeenCalled()
    expect(sent).toHaveBeenCalledTimes(1)
    expect(useStore.getState().chat['q174']!.map(line)).toEqual([droppedQuestionsText(['Which DB?']), 'see this'])
  })

  it('never asks a session with an open question for a note — the request text would become that question\'s answer', async () => {
    const { mock, sent, answered } = await withQuestions(q('r1', 'Which DB?'))
    const proj = await mock.projects.add('/tmp/q174')
    useStore.setState((st) => ({
      projects: { ...st.projects, [proj.id]: proj },
      sessions: { ...st.sessions, q174: { ...st.sessions.q174!, projectId: proj.id } },
    }))
    await useStore.getState().handoffSession('q174')
    expect(answered).not.toHaveBeenCalled()
    expect(sent).not.toHaveBeenCalled()
    expect(useStore.getState().toast).toBe('Answer the open question first, or hand off from the record')
  })
})

/*
 * #180: if the send path failed or raced, what a person wrote disappeared.
 */
describe('a failed send returns what was written (#180)', () => {
  it('text sent as an answer to a question comes back to the composer if it never lands', async () => {
    const mock = new MockPlatform()
    const open = [{ requestId: 'r1', questions: [{ question: 'Which DB?', header: 'DB', options: [{ label: 'pg', description: '' }], multiSelect: false }] }]
    mock.sessions.set('a180', sessionInfo('a180', { state: 'waiting_approval', pendingQuestions: open as never }))
    await useStore.getState().attach(mock)
    useStore.getState().setDraft('a180', { text: 'typed after', attachments: [] })
    vi.spyOn(mock.agents, 'answerQuestion').mockRejectedValueOnce(
      Object.assign(new Error('That question is already gone'), { code: 'question_gone' }),
    )
    await useStore.getState().send('a180', 'sqlite please')
    expect(useStore.getState().drafts['a180']!.text).toBe('sqlite please\ntyped after')
    expect(useStore.getState().toast).toBe('That question is already gone')
  })

  it('never claims the first question went out if the orchestrator failed to be born', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    vi.spyOn(mock.agents, 'orchestrator').mockRejectedValueOnce(new Error('no tool'))
    expect(await useStore.getState().askOrchestrator('first question')).toBe(false)
    expect(useStore.getState().toast).toBe('Could not start the orchestrator: no tool')
  })

  it('returns a failure to the calling window if a worktree manager could not be created', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/wm180')
    await useStore.getState().attach(mock)
    vi.spyOn(mock.projects, 'createWorktreeManager').mockRejectedValueOnce(new Error('not a git repository'))
    await expect(useStore.getState().createWorktreeManager(proj.id, 'main')).rejects.toThrow(
      'Could not start the worktree manager: not a git repository',
    )
  })

  it('counts an attachment while it is uploading — the composer refuses to send during that time', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('u180', sessionInfo('u180'))
    await useStore.getState().attach(mock)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const save = mock.agents.saveAttachment.bind(mock.agents)
    vi.spyOn(mock.agents, 'saveAttachment').mockImplementationOnce(async (...a) => {
      await gate
      return save(...a)
    })
    const file = new File(['x'], 'shot.png', { type: 'image/png' })
    const up = useStore.getState().attachFile('u180', file)
    await vi.waitFor(() => expect(useStore.getState().uploading['u180']).toBe(1))
    release()
    expect(await up).toMatchObject({ name: 'shot.png' })
    expect(useStore.getState().uploading['u180']).toBeUndefined()
  })
})

/*
 * The trash (#204) from the screen's side. Deleting says where the session went; restoring puts it back in the
 * sidebar, and a project its restore registered again arrives with it — the screen has not heard of that project,
 * and a session row under a project the sidebar does not have is drawn nowhere.
 */
describe('the trash (#204)', () => {
  it('deleting says where the session went, and restoring brings it and its registered project back', async () => {
    const mock = new MockPlatform()
    const p = await mock.projects.add('/tmp/trash-a')
    await useStore.getState().attach(mock)
    const s = await mock.agents.createSession({ projectId: p.id, cwd: p.path, tool: 'claude', permissionPreset: 'normal' })
    useStore.getState().dispatchEvent({ type: 'session_created', sessionId: s.id, session: s } as NormalizedEvent)

    await useStore.getState().deleteSession(s.id)
    expect(useStore.getState().sessions[s.id]).toBeUndefined()
    expect(useStore.getState().toast).toMatch(/Moved to the trash: .* Settings → Trash/)

    await mock.projects.remove(p.id)
    useStore.setState((st) => ({ projects: Object.fromEntries(Object.entries(st.projects).filter(([id]) => id !== p.id)) }))
    expect(await useStore.getState().restoreFromTrash(s.id)).toBeNull()
    const st = useStore.getState()
    expect(st.projects[p.id]?.path).toBe('/tmp/trash-a')
    expect(st.sessions[s.id]?.projectId).toBe(p.id)
    // Registered again is added again: it is asked about trust as a new project is
    expect(st.trustAsk).toBe(p.id)
    expect(await useStore.getState().restoreFromTrash(s.id)).toMatch(/Not in the trash/)
  })
})

/*
 * The restore must not save a half-restored state (`restoringWorkspace` in store.ts). Every setter the restore goes
 * through saves, so a save in the middle of it used to write the defaults of every field restored later back over
 * the snapshot. The spinning-marker settings are restored last: the person turned both off, and after a restart
 * both were on again (2026-09-30).
 */
describe('restoring the workspace saves nothing until it is done', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const lateFields = { spinGrid: false, spinSessionIcon: false, foldComposer: false }

  it('settings turned off stay off across two launches, even the ones restored last', async () => {
    const mock = new MockPlatform()
    const p = await mock.projects.add('/tmp/restore-late')
    mock.sessions.set('late-r1', sessionInfo('late-r1', { projectId: p.id }))
    mock.workspaceSnapshot = {
      focusedSessionId: 'late-r1',
      panelWidth: 300,
      sidebarWidth: 240,
      railWidth: 300,
      textScale: 3,
      ...lateFields,
    } as never

    // A launch starts from the defaults, which have all three on
    useStore.setState({ spinGrid: true, spinSessionIcon: true, foldComposer: true })
    await useStore.getState().attach(mock)
    await tick()
    expect(useStore.getState()).toMatchObject(lateFields)
    // What the host keeps is what the next launch reads
    expect(mock.workspaceSnapshot).toMatchObject(lateFields)

    useStore.setState({ spinGrid: true, spinSessionIcon: true, foldComposer: true })
    await useStore.getState().attach(mock)
    await tick()
    expect(useStore.getState()).toMatchObject(lateFields)
  })

  it('a change the person makes after the restore is still saved', async () => {
    const mock = new MockPlatform()
    mock.workspaceSnapshot = { ...lateFields } as never
    await useStore.getState().attach(mock)
    await tick()

    useStore.getState().setSpinGrid(true)
    await tick()
    expect(mock.workspaceSnapshot).toMatchObject({ spinGrid: true, spinSessionIcon: false })
  })
})

/*
 * A failed save is retried, not dropped (`workspaceSave` in store.ts). On 2026-09-30 the machine froze for hours,
 * the person folded every project during that time, every save timed out, and after a restart the folds were gone:
 * the stored snapshot never received them.
 */
describe('a workspace save that fails is sent again', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const storedFolds = (mock: MockPlatform) =>
    (mock.workspaceSnapshot as { foldedProjects?: string[] } | null)?.foldedProjects
  const timedOut = () => Object.assign(new Error('RPC timed out: workspace.save'), { code: 'timeout', retryable: true })

  /** Makes `workspace.save` fail `times` times, then store as usual. Returns the fold list of every save that was stored */
  function failSaves(mock: MockPlatform, times: number): { written: string[][]; calls: () => number } {
    const save = mock.workspace.save
    const written: string[][] = []
    let calls = 0
    mock.workspace.save = async (snap) => {
      calls++
      if (calls <= times) throw timedOut()
      written.push([...((snap as { foldedProjects?: string[] }).foldedProjects ?? [])])
      return save(snap)
    }
    return { written, calls: () => calls }
  }

  async function attached(): Promise<MockPlatform> {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    await tick()
    return mock
  }

  it('a fold saved while the host is away is stored when the connection comes back', async () => {
    const mock = await attached()
    failSaves(mock, 1)

    mock.setConnectionState('disconnected')
    useStore.getState().toggleProjectFold('retry-p1')
    await tick()
    expect(storedFolds(mock) ?? []).toEqual([])

    mock.setConnectionState('connected')
    await tick()
    expect(storedFolds(mock)).toEqual(['retry-p1'])
  })

  it('a save that fails while connected is retried after a short wait', async () => {
    const mock = await attached()
    failSaves(mock, 1)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      useStore.getState().toggleProjectFold('retry-p2')
      await vi.advanceTimersByTimeAsync(0)
      expect(storedFolds(mock) ?? []).toEqual([])

      await vi.advanceTimersByTimeAsync(1_000)
      expect(storedFolds(mock)).toEqual(['retry-p2'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a newer save made while an older one is failing is the one stored, and the older never follows it', async () => {
    const mock = await attached()
    const save = mock.workspace.save
    const written: string[][] = []
    let failFirst!: () => void
    let calls = 0
    mock.workspace.save = (snap) => {
      // The first save hangs the way a frozen host does, and then times out
      if (++calls === 1) return new Promise((_, reject) => (failFirst = () => reject(timedOut())))
      written.push([...((snap as { foldedProjects?: string[] }).foldedProjects ?? [])])
      return save(snap)
    }
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      useStore.getState().toggleProjectFold('retry-a') // on its way, and stuck
      useStore.getState().toggleProjectFold('retry-b') // newer: supersedes it
      failFirst()
      await vi.advanceTimersByTimeAsync(0)
      expect(storedFolds(mock)).toEqual(['retry-a', 'retry-b'])

      // Nothing older arrives later — not from a backoff, not from a reconnect
      await vi.advanceTimersByTimeAsync(60_000)
      mock.setConnectionState('disconnected')
      mock.setConnectionState('connected')
      await vi.advanceTimersByTimeAsync(60_000)
      expect(written).toEqual([['retry-a', 'retry-b']])
      expect(storedFolds(mock)).toEqual(['retry-a', 'retry-b'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('a retry waiting on its backoff never sends its older snapshot over a newer one', async () => {
    const mock = await attached()
    const { written } = failSaves(mock, 1)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      useStore.getState().toggleProjectFold('retry-c') // fails; a retry is armed
      await vi.advanceTimersByTimeAsync(0)
      useStore.getState().toggleProjectFold('retry-d') // newer, and stored at once
      await vi.advanceTimersByTimeAsync(0)
      expect(storedFolds(mock)).toEqual(['retry-c', 'retry-d'])

      await vi.advanceTimersByTimeAsync(60_000)
      expect(written).toEqual([['retry-c', 'retry-d']])
      expect(storedFolds(mock)).toEqual(['retry-c', 'retry-d'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('while connected it stops after a few retries, and the next save or reconnect sends it again', async () => {
    const mock = await attached()
    const { calls } = failSaves(mock, Infinity)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      useStore.getState().toggleProjectFold('retry-e')
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(calls()).toBe(4) // the save, then 1 s, 5 s and 30 s later

      useStore.getState().toggleProjectFold('retry-f')
      await vi.advanceTimersByTimeAsync(0)
      expect(calls()).toBe(5)

      mock.setConnectionState('disconnected')
      mock.setConnectionState('connected')
      await vi.advanceTimersByTimeAsync(0)
      expect(calls()).toBe(6)
    } finally {
      vi.useRealTimers()
    }
  })
})

/**
 * What the agent tools tell the person (#304): a fresh conversation and a notice are one quiet line each, live and
 * after reopening; a model switch the tool made updates the model shown without a toast.
 */
describe('resets, notices and switches the tool made (#304)', () => {
  const HOOK =
    'UserPromptSubmit operation blocked by hook:\n[node block-hook.mjs]: Prompts containing BLOCKME are not allowed here.'

  it('a reset and a notice each stand as one line, and the reset empties the context gauge', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('n-1', sessionInfo('n-1'))
    await useStore.getState().attach(mock)

    mock.emit({ type: 'context_update', sessionId: 'n-1', used: 15967, window: 200000, exactness: 'exact' })
    mock.emit({ type: 'conversation_reset', sessionId: 'n-1', trigger: 'clear' })
    mock.emit({ type: 'notice', sessionId: 'n-1', level: 'warning', text: HOOK })

    const marks = (useStore.getState().chat['n-1'] ?? []).filter((i) => i.kind === 'mark').map((i) => (i as { text: string }).text)
    expect(marks).toEqual(['Conversation cleared — the agent remembers nothing above this line', HOOK])
    expect(useStore.getState().sessions['n-1']?.context).toBeNull()
  })

  it('the same lines come back after reopening — both are stored as markers', () => {
    const items = messagesToChat([
      { sessionId: 'n-2', seq: 3, role: 'system', kind: 'marker', ts: 1, payload: { type: 'conversation_reset', sessionId: 'n-2', trigger: 'clear' } },
      { sessionId: 'n-2', seq: 4, role: 'system', kind: 'marker', ts: 2, payload: { type: 'conversation_reset', sessionId: 'n-2', trigger: 'plan_exit' } },
      { sessionId: 'n-2', seq: 5, role: 'system', kind: 'marker', ts: 3, payload: { type: 'notice', sessionId: 'n-2', level: 'warning', text: HOOK } },
    ])
    expect(items.map((i) => (i as { text: string }).text)).toEqual([
      'Conversation cleared — the agent remembers nothing above this line',
      'The agent started a new conversation here — it remembers nothing above this line',
      HOOK,
    ])
  })

  it('a marker kind this build does not know is left out, not drawn as a compaction', () => {
    const items = messagesToChat([
      { sessionId: 'n-4', seq: 1, role: 'system', kind: 'marker', ts: 1, payload: { type: 'from_a_newer_host', text: 'x' } },
      { sessionId: 'n-4', seq: 2, role: 'system', kind: 'marker', ts: 2, payload: { type: 'compaction', failed: false } },
    ])
    expect(items.map((i) => (i as { text: string }).text)).toEqual(['Earlier messages were compacted here'])
  })

  it('a readable notice (#342) leads with who, what kind and whose it is, live and restored alike', async () => {
    const CONFIG =
      'Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.\n' +
      '  user (~/.codex/config.toml): `a.b` is ignored.\n  user (~/.codex/config.toml): `c` is ignored.'
    const notice = {
      type: 'notice' as const,
      sessionId: 'n-5',
      level: 'warning' as const,
      text: CONFIG,
      oncePerSession: true,
      from: 'Codex',
      label: 'config warning',
      audience: 'you' as const,
      summary: 'Codex ignored 2 settings in `~/.codex/config.toml`',
      items: ['a.b', 'c'],
      hint: 'Codex already runs without them; removing them from the file only silences this notice.',
    }
    const expected = {
      text: 'Codex · config warning · for you — Codex ignored 2 settings in `~/.codex/config.toml`',
      notice: {
        head: 'Codex · config warning',
        from: 'Codex',
        audience: 'you',
        summary: 'Codex ignored 2 settings in `~/.codex/config.toml`',
        original: CONFIG,
        items: ['a.b', 'c'],
        hint: 'Codex already runs without them; removing them from the file only silences this notice.',
      },
    }
    const mock = new MockPlatform()
    mock.sessions.set('n-5', sessionInfo('n-5'))
    await useStore.getState().attach(mock)
    mock.emit(notice)
    const live = (useStore.getState().chat['n-5'] ?? []).filter((i) => i.kind === 'mark')
    expect(live).toMatchObject([expected])

    const restored = messagesToChat([{ sessionId: 'n-5', seq: 1, role: 'system', kind: 'marker', ts: 1, payload: notice }])
    expect(restored).toMatchObject([expected])
  })

  it("an unknown readable notice keeps the tool's text as its line, and one from before #342 reads as before", () => {
    const items = messagesToChat([
      {
        sessionId: 'n-6', seq: 1, role: 'system', kind: 'marker', ts: 1,
        payload: { type: 'notice', sessionId: 'n-6', level: 'warning', text: 'Exceeded skills context budget.', from: 'Codex', label: 'warning' },
      },
      {
        sessionId: 'n-6', seq: 2, role: 'system', kind: 'marker', ts: 2,
        payload: { type: 'notice', sessionId: 'n-6', level: 'warning', text: 'Full-history hydration is deprecated.', from: 'Codex', label: 'deprecation', audience: 'centralu' },
      },
      { sessionId: 'n-6', seq: 3, role: 'system', kind: 'marker', ts: 3, payload: { type: 'notice', sessionId: 'n-6', level: 'warning', text: HOOK } },
    ])
    expect(items.map((i) => (i as { text: string }).text)).toEqual([
      'Codex · warning — Exceeded skills context budget.',
      'Codex · deprecation · for Centralu — Full-history hydration is deprecated.',
      HOOK,
    ])
    // No summary: the text is the line itself, so there is nothing to show on demand
    expect(items[0]).toMatchObject({ notice: { head: 'Codex · warning', from: 'Codex' } })
    expect((items[0] as { notice?: { original?: string } }).notice?.original).toBeUndefined()
    expect((items[2] as { notice?: unknown }).notice).toBeUndefined()
  })

  it('a model switch the tool made updates the model shown without a toast; the orchestrator still raises one', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('n-3', sessionInfo('n-3', { model: 'opus' }))
    await useStore.getState().attach(mock)
    useStore.setState({ toast: null })

    mock.emit({ type: 'settings_changed', sessionId: 'n-3', model: 'claude-sonnet-4-6', effort: null, verbosity: null, serviceTier: null, by: 'tool' })
    expect(useStore.getState().sessions['n-3']?.model).toBe('claude-sonnet-4-6')
    expect(useStore.getState().toast).toBeNull()

    mock.emit({ type: 'settings_changed', sessionId: 'n-3', model: 'haiku', effort: null, verbosity: null, serviceTier: null })
    expect(useStore.getState().toast).toMatch(/Orchestrator changed/)
  })
})
