import { SLOW } from '../../../../tooling/test-timing.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalAppInfo, MachineInfo, NormalizedEvent, SessionInfo } from '@cc/protocol'
import { NO_PATH, sessionLiveDefaults } from '@cc/protocol'
import { DEFAULT_NOTIFY_POLICY, arrangePanels, countWaiting, withOrder, withPanel, sessionGridPanel, type NotifyPolicy } from '@cc/core'
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
  newSessionProjectOf,
  PENDING_EVENTS_MAX,
  PENDING_EVENTS_MAX_AGE_MS,
  projectScreenSessions,
  projectScreenAppKeys,
  registerPinnedFrame,
  useStore,
  type ChatItem,
} from './store.js'
import { computeInbox } from './selectors.js'
import { omitKey } from './patch.js'

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
    searchTargets: {},
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
 * Sidebar group folding (#666). The children of a session and the sessions of an app fold behind a chevron; the folded
 * keys live in the screen preferences (`prefs.foldedGroups`), so they are saved through `prefs.save` and come back on
 * attach. A pick makes its session visible again, except where `reveal: false` says the session is already on screen.
 */
describe('sidebar group folding (#666)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const folded = () => useStore.getState().prefs.foldedGroups

  it('a fold is saved through the screen preferences and survives a restart', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/group-save')
    for (const id of ['g-a', 'g-b']) mock.sessions.set(id, sessionInfo(id, { projectId: a.id }))
    await useStore.getState().attach(mock)
    useStore.getState().setGroupsFolded(['session:g-a', 'session:g-b'], true)
    useStore.getState().setGroupsFolded(['session:g-a'], true)
    await tick()
    expect(folded()).toEqual(['session:g-a', 'session:g-b'])
    expect((await mock.prefs.load()).foldedGroups).toEqual(['session:g-a', 'session:g-b'])

    useStore.getState().setGroupsFolded(['session:g-a'], false)
    await tick()
    expect((await mock.prefs.load()).foldedGroups).toEqual(['session:g-b'])

    // Reopening the app: a store reset to the defaults reads the record back
    useStore.setState({ prefs: { ...useStore.getState().prefs, foldedGroups: [] } })
    await useStore.getState().attach(mock)
    expect(folded()).toEqual(['session:g-b'])
  })

  it('a save that fails is said and undone, and keeps no stale fold', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.prefs.save = async () => {
      throw new Error('disk full')
    }
    useStore.getState().setGroupsFolded(['session:a'], true)
    expect(folded()).toEqual(['session:a'])
    await tick()
    expect(folded()).toEqual([])
    expect(useStore.getState().toast).toContain('disk full')
  })

  it('picking a hidden child unfolds its parent’s group, and an app session its app’s', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/group-go')
    mock.sessions.set('g-parent', sessionInfo('g-parent', { projectId: a.id }))
    mock.sessions.set('g-kid', sessionInfo('g-kid', { projectId: a.id, parentSessionId: 'g-parent', askedBy: 'g-parent' } as never))
    mock.sessions.set('g-app', sessionInfo('g-app', { projectId: a.id, appId: 'slider' }))
    mock.setExternalApps([
      { appId: 'slider', projectId: a.id, dir: '/tmp/group-go/.centralu/apps/slider', name: 'Slider', version: '0.1.0', description: null, home: 'home', trusted: true, status: 'stopped', error: null, warnings: [] } as never,
    ])
    await useStore.getState().attach(mock)
    await tick()
    useStore.getState().setGroupsFolded(['session:g-parent', `app:${a.id}/slider`, 'session:unrelated'], true)

    useStore.getState().focusSession('g-kid')
    expect(folded()).toEqual([`app:${a.id}/slider`, 'session:unrelated'])
    useStore.getState().focusSession('g-app')
    expect(folded()).toEqual(['session:unrelated'])
    await tick()
    expect((await mock.prefs.load()).foldedGroups).toEqual(['session:unrelated'])
  })

  it('a removed app does not claim the session, so its fold opens nothing', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/group-gone')
    mock.sessions.set('g-orphan', sessionInfo('g-orphan', { projectId: a.id, appId: 'removed' }))
    await useStore.getState().attach(mock)
    useStore.getState().setGroupsFolded([`app:${a.id}/removed`], true)

    useStore.getState().focusSession('g-orphan')

    expect(folded()).toEqual([`app:${a.id}/removed`])
  })

  it('a pick made by clicking a grid panel (reveal: false) leaves a group folded', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/group-grid')
    mock.sessions.set('g-parent', sessionInfo('g-parent', { projectId: a.id }))
    mock.sessions.set('g-kid', sessionInfo('g-kid', { projectId: a.id, parentSessionId: 'g-parent' }))
    await useStore.getState().attach(mock)
    useStore.getState().setGroupsFolded(['session:g-parent'], true)

    useStore.getState().focusSession('g-kid', { preferGrid: true, reveal: false })

    expect(useStore.getState().focusedSessionId).toBe('g-kid')
    expect(folded()).toEqual(['session:g-parent'])
  })

  it('a deleted session takes its fold with it, saved too', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/group-del')
    for (const id of ['g-parent', 'g-other']) mock.sessions.set(id, sessionInfo(id, { projectId: a.id }))
    await useStore.getState().attach(mock)
    useStore.getState().setGroupsFolded(['session:g-parent', 'session:g-other'], true)

    mock.emit({ type: 'session_deleted', sessionId: 'g-parent' })
    await tick()

    expect(folded()).toEqual(['session:g-other'])
    expect((await mock.prefs.load()).foldedGroups).toEqual(['session:g-other'])
  })

  it('the first attach drops folds of groups that are gone, and keeps what it cannot judge', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/group-stale')
    mock.sessions.set('g-live', sessionInfo('g-live', { projectId: a.id }))
    const stale = Array.from({ length: 496 }, (_, i) => `session:gone-${i}`)
    // A linked machine's session and a linked machine's app are not here until that link comes up
    await mock.prefs.save({ foldedGroups: [...stale, 'session:g-live', 'session:m1.far', 'app:m1:_user/far', `app:${a.id}/removed`] })

    await useStore.getState().attach(mock)
    await tick()

    // Apps are not judged while the list names none (it may be a read that failed)
    expect(folded()).toEqual(['session:g-live', 'session:m1.far', 'app:m1:_user/far', `app:${a.id}/removed`])
    expect((await mock.prefs.load()).foldedGroups).toEqual(folded())
  })

  it('a removed app takes its fold with it, but an empty list does not condemn them all', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/group-apps')
    const app = (appId: string) =>
      ({ appId, projectId: a.id, dir: `/tmp/${appId}`, name: appId, version: '0.1.0', description: null, home: 'home', trusted: true, status: 'stopped', error: null, warnings: [] }) as never
    mock.setExternalApps([app('keep'), app('drop')])
    await useStore.getState().attach(mock)
    useStore.getState().setGroupsFolded([`app:${a.id}/keep`, `app:${a.id}/drop`], true)

    mock.setExternalApps([app('keep')])
    await vi.waitFor(() => expect(folded()).toEqual([`app:${a.id}/keep`]))

    mock.setExternalApps([])
    await tick()
    await tick()
    expect(folded()).toEqual([`app:${a.id}/keep`])
  })

  it('another setting saved against a host that does not know folds leaves the folds alone', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    useStore.getState().setGroupsFolded(['session:a'], true)
    await tick()
    // An older host answers with the record it knows: no `foldedGroups` in it
    const save = mock.prefs.save
    mock.prefs.save = async (patch) => {
      const { foldedGroups: _unknown, ...known } = await save(patch)
      return known as never
    }

    await useStore.getState().setPrefs({ sessionTools: false })

    expect(useStore.getState().prefs.sessionTools).toBe(false)
    expect(folded()).toEqual(['session:a'])
  })

  it('a setting whose answer was written before a fold was saved does not bring the old folds back', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const save = mock.prefs.save
    let answer: (v: unknown) => void = () => {}
    mock.prefs.save = (patch) => (patch.sessionTools === undefined ? save(patch) : new Promise((r) => (answer = r)) as never)

    const pending = useStore.getState().setPrefs({ sessionTools: false })
    useStore.getState().setGroupsFolded(['session:a'], true)
    answer({ ...useStore.getState().prefs, sessionTools: false, foldedGroups: [] })
    await pending

    expect(folded()).toEqual(['session:a'])
  })

  it('a failed save is undone even when a reconnect handed the screen a new array of the same folds', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    useStore.getState().setGroupsFolded(['session:a'], true)
    await tick()
    let fail: (e: Error) => void = () => {}
    mock.prefs.save = () => new Promise((_, reject) => (fail = reject))
    useStore.getState().setGroupsFolded(['session:b'], true)
    // What attach does when it reads the preferences again: same keys, new array
    useStore.setState((s) => ({ prefs: { ...s.prefs, foldedGroups: [...s.prefs.foldedGroups] } }))

    fail(new Error('offline'))
    await tick()

    expect(folded()).toEqual(['session:a'])
    expect(useStore.getState().toast).toContain('offline')
  })

  it('a failed older save does not undo a newer fold that is still being saved', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const fails: ((e: Error) => void)[] = []
    mock.prefs.save = () => new Promise((_, reject) => fails.push(reject))
    useStore.getState().setGroupsFolded(['session:b'], true)
    useStore.getState().setGroupsFolded(['session:b'], false)
    useStore.getState().setGroupsFolded(['session:b'], true)

    fails[0]!(new Error('first failed'))
    await tick()

    expect(folded()).toEqual(['session:b'])
  })

  it('keeps at most 500 folds, dropping the oldest', async () => {
    await useStore.getState().attach(new MockPlatform())
    useStore.getState().setGroupsFolded(Array.from({ length: 510 }, (_, i) => `session:${i}`), true)
    expect(folded()).toHaveLength(500)
    expect(folded()[0]).toBe('session:10')
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

  // The folder goes through its own door (#838 review): the file tree's trash refuses the project folder
  it('deleting a project with its folder trashes the folder through its own door, then removes the project', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/trash-whole')
    await useStore.getState().attach(mock)

    await useStore.getState().deleteProject(a.id, true)

    expect(mock.trashedProjects).toEqual([a.id])
    expect(mock.trashed).toEqual([])
    expect(useStore.getState().projects[a.id]).toBeUndefined()
  })

  it('a deleted project leaves no fold behind', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/fold-gone')
    await useStore.getState().attach(mock)
    useStore.getState().toggleProjectFold(a.id)

    await useStore.getState().deleteProject(a.id, false)

    expect(useStore.getState().foldedProjects).toEqual([])
  })

  it('a deleted project takes what was kept for it and its sessions along', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/kept-gone')
    mock.sessions.set('kept-s', sessionInfo('kept-s', { projectId: a.id }))
    await useStore.getState().attach(mock)
    useStore.setState((s) => ({
      gitEpoch: { ...s.gitEpoch, [a.id]: 3 },
      expandedDirs: { ...s.expandedDirs, [a.id]: ['src'] },
      drafts: { ...s.drafts, 'kept-s': { text: 'half a thought', attachments: [] } },
      history: { ...s.history, 'kept-s': { oldestSeq: 1, more: false, loading: false } },
    }))

    await useStore.getState().deleteProject(a.id, false)

    const st = useStore.getState()
    expect(st.gitEpoch[a.id]).toBeUndefined()
    expect(st.expandedDirs[a.id]).toBeUndefined()
    expect(st.drafts['kept-s']).toBeUndefined()
    expect(st.history['kept-s']).toBeUndefined()
  })
})

/*
 * The project screen's arrangement (#203): per project, in the workspace snapshot, next to the fold. The panels are
 * explicitly chosen by the person and restored once the availability catalogs have loaded.
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

    useStore.getState().arrangeProject(a.id, { panels: ['session:x', 'session:y'], order: ['session:x', 'session:y'], hidden: ['app:z'] })
    await tick()
    expect(stored(mock)).toEqual({ [a.id]: { panels: ['session:x', 'session:y'], order: ['session:x', 'session:y'], hidden: ['app:z'] } })
    expect(stored(mock)?.[b.id]).toBeUndefined()

    useStore.setState({ projectPanels: {} })
    await useStore.getState().attach(mock)
    expect(useStore.getState().projectPanels).toEqual({ [a.id]: { panels: ['session:x', 'session:y'], order: ['session:x', 'session:y'], hidden: ['app:z'] } })
  })

  it('no save made while restoring writes an empty arrangement over the stored one', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/arr-restore')
    mock.sessions.set('arr-r1', sessionInfo('arr-r1', { projectId: a.id }))
    const saved = { [a.id]: { panels: ['session:arr-r1'], order: ['session:arr-r1'], hidden: [] } }
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

  it('migrates arranged projects once from loaded catalogs and saves only after all workspace fields are restored', async () => {
    const mock = new MockPlatform()
    const arranged = await mock.projects.add('/tmp/arr-migrate')
    const untouched = await mock.projects.add('/tmp/arr-untouched')
    for (const id of ['first', 'hidden', 'last']) mock.sessions.set(id, sessionInfo(id, { projectId: arranged.id }))
    mock.sessions.set('untouched', sessionInfo('untouched', { projectId: untouched.id }))
    mock.setExternalApps([
      { appId: 'slider', projectId: arranged.id } as never,
      { appId: 'zebra', name: 'Zebra', projectId: arranged.id } as never,
      { appId: 'alpha', name: 'Alpha', projectId: arranged.id } as never,
    ])
    const legacy = { order: ['app:slider', 'session:first', 'session:gone'], hidden: ['session:hidden'] }
    mock.workspaceSnapshot = {
      projectPanels: { [arranged.id]: legacy }, focusedSessionId: 'first',
      foldedProjects: [untouched.id], panelOpen: false, introSeen: true,
    } as never
    await useStore.getState().attach(mock)
    const migrated = { ...legacy, panels: ['app:slider', 'session:first', 'session:gone', 'session:last', 'app:alpha', 'app:zebra'] }
    expect(useStore.getState().projectPanels).toEqual({ [arranged.id]: migrated })
    useStore.setState({ view: 'focus', focusedProjectId: arranged.id, focusedSessionId: null })
    expect(projectScreenSessions(useStore.getState())).toEqual(['first', 'last'])
    expect(projectScreenAppKeys(useStore.getState())).toEqual([`${arranged.id}/slider`, `${arranged.id}/zebra`, `${arranged.id}/alpha`])
    await tick()
    expect(stored(mock)?.[arranged.id]).toEqual(migrated)
    expect(mock.workspaceSnapshot).toMatchObject({
      focusedSessionId: 'first', foldedProjects: [untouched.id], panelOpen: false, introSeen: true,
    })
    mock.sessions.set('new', sessionInfo('new', { projectId: arranged.id }))
    await useStore.getState().attach(mock)
    expect(useStore.getState().projectPanels[arranged.id]).toEqual(migrated)
    useStore.setState({ focusedProjectId: untouched.id, focusedSessionId: null, view: 'focus' })
    expect(projectScreenSessions(useStore.getState())).toEqual([])
    expect(projectScreenAppKeys(useStore.getState())).toEqual([])
  })

  it.each(['empty', 'partial', 'failed'])(
    'persists legacy app panels when the startup catalog is %s and draws them after discovery recovers',
    async (catalog) => {
      const mock = new MockPlatform()
      const project = await mock.projects.add(`/tmp/arr-catalog-${catalog}`)
      mock.sessions.set('kept', sessionInfo('kept', { projectId: project.id }))
      const apps = ['offline', 'available', 'hidden'].map((appId) => ({ appId, projectId: project.id } as ExternalAppInfo))
      mock.setExternalApps(catalog === 'partial' ? [apps[1]!] : [])
      const list = mock.apps.list
      if (catalog === 'failed') mock.apps.list = async () => { throw new Error('Discovery unavailable') }
      const legacy = { order: ['app:offline', 'session:kept', 'app:available', 'app:hidden'], hidden: ['app:hidden'] }
      mock.workspaceSnapshot = { projectPanels: { [project.id]: legacy } } as never

      await useStore.getState().attach(mock)
      await tick()
      const migrated = { ...legacy, panels: ['app:offline', 'session:kept', 'app:available'] }
      expect(stored(mock)?.[project.id]).toEqual(migrated)
      useStore.setState({ view: 'focus', focusedProjectId: project.id, focusedSessionId: null })
      expect(projectScreenAppKeys(useStore.getState())).toEqual(catalog === 'partial' ? [`${project.id}/available`] : [])

      mock.apps.list = list
      mock.setExternalApps(apps)
      await useStore.getState().refreshExternalApps()
      expect(projectScreenAppKeys(useStore.getState())).toEqual([`${project.id}/offline`, `${project.id}/available`])
      expect(useStore.getState().projectPanels[project.id]).toEqual(migrated)
      await useStore.getState().attach(mock)
      expect(useStore.getState().projectPanels[project.id]).toEqual(migrated)
    },
  )

  it('an empty-array legacy entry keeps the lone visible session, while a project without an entry starts empty', async () => {
    const mock = new MockPlatform()
    const arranged = await mock.projects.add('/tmp/arr-empty-entry')
    const untouched = await mock.projects.add('/tmp/arr-no-entry')
    mock.sessions.set('solo', sessionInfo('solo', { projectId: arranged.id }))
    mock.sessions.set('other', sessionInfo('other', { projectId: untouched.id }))
    mock.workspaceSnapshot = { projectPanels: { [arranged.id]: { order: [], hidden: [] } } } as never
    await useStore.getState().attach(mock)
    await tick()
    expect(stored(mock)).toEqual({ [arranged.id]: { panels: ['session:solo'], order: [], hidden: [] } })
    useStore.setState({ view: 'focus', focusedProjectId: arranged.id, focusedSessionId: null })
    expect(projectScreenSessions(useStore.getState())).toEqual(['solo'])
    useStore.setState({ focusedProjectId: untouched.id })
    expect(projectScreenSessions(useStore.getState())).toEqual([])
  })

  it.each(['reorder', 'add', 'remove'])(
    '%s edits retain unavailable app panels in the snapshot and draw them when discovery recovers',
    async (edit) => {
      const mock = new MockPlatform()
      const project = await mock.projects.add(`/tmp/arr-offline-edit-${edit}`)
      for (const id of ['a', 'b', 'c']) mock.sessions.set(id, sessionInfo(id, { projectId: project.id }))
      const saved = { panels: ['session:a', 'app:offline', 'session:b'], order: ['session:a', 'app:offline', 'session:b'], hidden: [] }
      mock.workspaceSnapshot = { projectPanels: { [project.id]: saved } } as never
      await useStore.getState().attach(mock)
      const present = ['session:a', 'session:b', 'session:c']
      const next = edit === 'reorder' ? withOrder(present, saved, ['session:b', 'session:a'])
        : withPanel(present, saved, edit === 'add' ? 'session:c' : 'session:a', edit === 'add')
      const expected = edit === 'reorder' ? ['session:b', 'app:offline', 'session:a']
        : edit === 'add' ? ['session:a', 'app:offline', 'session:b', 'session:c'] : ['app:offline', 'session:b']
      useStore.getState().arrangeProject(project.id, next)
      await tick()
      expect(stored(mock)?.[project.id]).toMatchObject({ panels: expected, order: expected })
      mock.setExternalApps([{ appId: 'offline', projectId: project.id } as ExternalAppInfo])
      await useStore.getState().refreshExternalApps()
      useStore.setState({ view: 'focus', focusedProjectId: project.id, focusedSessionId: null })
      expect(projectScreenAppKeys(useStore.getState())).toEqual([`${project.id}/offline`])
      expect(arrangePanels([...present, 'app:offline'], useStore.getState().projectPanels[project.id])).toEqual(expected)
      await useStore.getState().attach(mock)
      expect(useStore.getState().projectPanels[project.id]?.panels).toEqual(expected)
    },
  )

  it('explicit session deletion removes its panel without discarding unavailable apps, and trash restore does not re-add it', async () => {
    const mock = new MockPlatform()
    const project = await mock.projects.add('/tmp/arr-trash-signal')
    mock.sessions.set('kept', sessionInfo('kept', { projectId: project.id }))
    mock.sessions.set('deleted', sessionInfo('deleted', { projectId: project.id }))
    useStore.getState().arrangeProject(project.id, { panels: ['session:kept', 'app:offline', 'session:deleted'], order: [], hidden: [] })
    mock.workspaceSnapshot = { projectPanels: useStore.getState().projectPanels } as never
    await useStore.getState().attach(mock)
    mock.sessions.delete('deleted')
    mock.emit({ type: 'session_deleted', sessionId: 'deleted' })
    await tick()
    expect(useStore.getState().projectPanels[project.id]?.panels).toEqual(['session:kept', 'app:offline'])
    expect(stored(mock)?.[project.id]).toMatchObject({ panels: ['session:kept', 'app:offline'] })
    mock.sessions.set('deleted', sessionInfo('deleted', { projectId: project.id }))
    await useStore.getState().attach(mock)
    expect(useStore.getState().projectPanels[project.id]?.panels).toEqual(['session:kept', 'app:offline'])
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

  it('the project screen shows only listed sessions, and only while no session is picked', () => {
    useStore.setState({
      projects: { p1: { id: 'p1', path: '/tmp/p1', name: 'p1' } as never, p2: { id: 'p2', path: '/tmp/p2', name: 'p2' } as never },
      sessions: {
        s1: { ...sessionInfo('s1', { projectId: 'p1' }) } as never,
        s2: { ...sessionInfo('s2', { projectId: 'p1' }) } as never,
        s3: { ...sessionInfo('s3', { projectId: 'p2' }) } as never,
      },
      projectPanels: { p1: { panels: ['session:s1'], order: ['session:s1'], hidden: ['session:s2'] } },
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
 * A reconnect's recovery while the host keeps talking. The session list is read with a request, and live
 * events keep arriving until its answer does; the hub answers only once every linked machine has, so the
 * list can be older than them. The recovery used to apply the rows as they stood.
 */
/** Holds the next `sessions.list` answer (read at the moment it was asked) until `release` */
function holdList(mock: MockPlatform): { asked: Promise<void>; release: () => void } {
  const real = mock.agents.listSessions
  let release!: () => void
  let askedNow!: () => void
  const asked = new Promise<void>((r) => (askedNow = r))
  mock.agents.listSessions = async () => {
    mock.agents.listSessions = real
    const snapshot = await real()
    const held = new Promise<void>((r) => (release = r))
    askedNow()
    await held
    return snapshot
  }
  return { asked, release: () => release() }
}

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

  it('a startup that read everything says nothing', async () => {
    useStore.setState({ toast: null })
    await useStore.getState().attach(new MockPlatform())
    expect(useStore.getState().toast).toBeNull()
  })
})

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

  it('opens a search hit outside the newest page with context on both sides (#590)', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('h590', sessionInfo('h590', { live: false }))
    mock.messages.set('h590', many('h590', 260))
    await useStore.getState().attach(mock)

    useStore.getState().openSearchHit('h590', 40)

    await vi.waitFor(() => expect(useStore.getState().chat.h590?.some((row) => row.storedSeq === 40)).toBe(true))
    const rows = useStore.getState().chat.h590!
    expect(rows.map((row) => row.storedSeq)).toEqual(Array.from({ length: 140 }, (_, i) => i + 1))
    expect(useStore.getState().searchTargets.h590).toMatchObject({ seq: 40 })
    expect(mock.resumeCalls).toEqual([])
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
    mock.emit({ sessionId: 'a79-probe', type: 'tool_call', callId: 'p', summary: { tool: 'Read', title: 'probe' } } as never)
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
    mock.emit({ type: 'tool_call', sessionId: 'app79', callId: 'r', summary: { tool: 'Read', title: 'Read note.md' } } as never)
    mock.emit({ type: 'tool_result', sessionId: 'app79', callId: 'r', ok: true, summary: 'empty' } as never)
    mock.emit({ type: 'tool_call', sessionId: 'app79', callId: 'w', summary: { tool: 'Write', title: 'Write note.md' } } as never)
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
      { sessionId: 'q79', seq: 9, role: 'system', kind: 'tool_call', payload: { callId: 'c9', summary: { tool: 'Read', title: 'T9' } }, ts: 9 },
      { sessionId: 'q79', seq: 10, role: 'system', kind: 'marker', payload: { type: 'compaction', sessionId: 'q79', failed: false }, ts: 10 },
    ])
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('q79')
    await vi.waitFor(() => expect(useStore.getState().history['q79']).toBeDefined())

    // An event for the same row, held in the pen, was replayed later than the page
    for (const e of [
      { type: 'user_message', sessionId: 'q79', seq: 8, text: 'L8' },
      { type: 'tool_call', sessionId: 'q79', seq: 9, callId: 'c9', summary: { tool: 'Read', title: 'T9' } },
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

    // Before this session is opened: a command that went through approval, a human message (numbered by
    // its user_message, as the host announces it, #999), an agent's image (its event carries no
    // number), a failed turn (the schema strips the number, #161)
    mock.emit({ type: 'approval_request', sessionId: 'e79', requestId: 'q1', detail: { kind: 'command', command: 'rm -rf build' } } as never)
    mock.emit({ type: 'approval_resolved', sessionId: 'e79', requestId: 'q1', decision: 'allow' } as never)
    await useStore.getState().send('e79', 'Hi')
    mock.emit({ type: 'message_image', sessionId: 'e79', mime: 'image/png', data: 'aWJs' } as never)
    const error = { type: 'error', sessionId: 'e79', error: { code: 'internal', message: 'boom', retryable: false } }
    mock.messages.get('e79')!.push({ sessionId: 'e79', seq: 10, role: 'system', kind: 'marker', payload: error, ts: 10 })
    useStore.getState().dispatchEvent(error as NormalizedEvent)
    expect(useStore.getState().chat['e79']!.map((i) => i.storedSeq)).toEqual([6, 8, undefined, undefined])

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
      mock.emit({ sessionId: 't79', type: 'tool_call', callId: `c${i}`, summary: { tool: 'Read', title: `L${i}` } } as never)
    }
    useStore.getState().focusSession('t79-other')
    expect(useStore.getState().chat['t79']).toHaveLength(50)
    expect(useStore.getState().history['t79']!.oldestSeq).toBe(131)

    useStore.getState().focusSession('t79')
    expect(await readAll('t79')).toEqual(L(180))
  })

  it('a session that is never on screen does not keep every event it receives', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('off-bg', sessionInfo('off-bg'))
    mock.sessions.set('off-seen', sessionInfo('off-seen'))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('off-seen')

    // A worker nobody opens — the trim on losing focus never reaches it
    for (let i = 1; i <= 300; i++) {
      mock.emit({ sessionId: 'off-bg', type: 'tool_call', callId: `c${i}`, summary: { tool: 'Read', title: `L${i}` } } as never)
    }
    expect(useStore.getState().chat['off-bg']!.length).toBeLessThanOrEqual(100)

    // Nothing is lost: opening it reads the cut rows back from the store
    useStore.getState().focusSession('off-bg')
    expect(await readAll('off-bg')).toEqual(L(300))
  })

  it('the conversation on screen is never cut while it is being read', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('off-focused', sessionInfo('off-focused'))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('off-focused')
    await vi.waitFor(() => expect(useStore.getState().history['off-focused']).toBeDefined())

    for (let i = 1; i <= 300; i++) {
      mock.emit({ sessionId: 'off-focused', type: 'tool_call', callId: `c${i}`, summary: { tool: 'Read', title: `L${i}` } } as never)
    }
    expect(useStore.getState().chat['off-focused']).toHaveLength(300)
  })

  it('an off-screen conversation is not cut while a page of its history is on the way', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('off-paging', sessionInfo('off-paging'))
    mock.sessions.set('off-paging-other', sessionInfo('off-paging-other'))
    mock.messages.set('off-paging', rows('off-paging', 130))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('off-paging')
    await vi.waitFor(() => expect(useStore.getState().history['off-paging']).toBeDefined())
    // Leaving cuts it to the window: rows 81..130, with older rows still to read
    useStore.getState().focusSession('off-paging-other')
    expect(useStore.getState().history['off-paging']).toMatchObject({ oldestSeq: 81, more: true })

    // A page of older rows is asked for and held on its way
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = mock.agents.loadMessages.bind(mock.agents)
    mock.agents.loadMessages = async (...args: Parameters<typeof real>) => {
      const page = await real(...args)
      await gate
      return page
    }
    const paging = useStore.getState().loadOlder('off-paging')
    expect(useStore.getState().history['off-paging']!.loading).toBe(true)

    // Meanwhile the session keeps working off screen, past the point where it would be cut
    for (let i = 131; i <= 190; i++) {
      mock.emit({ sessionId: 'off-paging', type: 'tool_call', callId: `c${i}`, summary: { tool: 'Read', title: `L${i}` } } as never)
    }
    release()
    await paging
    mock.agents.loadMessages = real

    // The page joins the rows it was asked for: no gap between it and the rest
    expect(useStore.getState().chat['off-paging']!.map(line)).toEqual(L(190))
  })

  it('a re-read in the middle of reading back keeps the pages already read, and the cursor with them', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('mid-read', sessionInfo('mid-read'))
    mock.messages.set('mid-read', rows('mid-read', 350))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('mid-read')
    await vi.waitFor(() => expect(useStore.getState().history['mid-read']).toBeDefined())
    await useStore.getState().loadOlder('mid-read')
    await useStore.getState().loadOlder('mid-read')
    expect(useStore.getState().chat['mid-read']!.map(line)[0]).toBe('L51')

    // The resumed session caught up on a line said elsewhere: the host announces it and the screen reads again
    mock.messages.set('mid-read', rows('mid-read', 351))
    useStore.getState().dispatchEvent({ type: 'history_synced', sessionId: 'mid-read', added: 1 } as NormalizedEvent)
    await vi.waitFor(() => expect(useStore.getState().chat['mid-read']!.map(line).at(-1)).toBe('L351'))

    // Still where the person was reading, not snapped back to the last page
    expect(useStore.getState().chat['mid-read']!.map(line)).toEqual(L(351).slice(50))
    expect(useStore.getState().history['mid-read']).toMatchObject({ oldestSeq: 51, more: true, loading: false })
    expect(await readAll('mid-read')).toEqual(L(351))
  })

  it('a page of older rows that lands after a re-read moved the cursor is dropped, leaving no gap', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('raced', sessionInfo('raced'))
    mock.messages.set('raced', rows('raced', 350))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('raced')
    await vi.waitFor(() => expect(useStore.getState().history['raced']).toMatchObject({ oldestSeq: 251 }))

    // "Earlier messages" is asked for, and its page is held on the way
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = mock.agents.loadMessages.bind(mock.agents)
    mock.agents.loadMessages = async (...args: Parameters<typeof real>) => {
      const page = await real(...args)
      if (args[2] !== undefined) await gate
      return page
    }
    const paging = useStore.getState().loadOlder('raced')

    // Meanwhile a hundred lines were said elsewhere, and a re-read lands first: a gap the screen cannot bridge, so it shows the new page
    mock.messages.set('raced', rows('raced', 450))
    await useStore.getState().loadHistory('raced')
    expect(useStore.getState().history['raced']).toMatchObject({ oldestSeq: 351 })

    release()
    await paging
    mock.agents.loadMessages = real

    expect(await readAll('raced')).toEqual(L(450))
  })

  it.each(['orchestrator', 'grid'] as const)(
    'the focused session keeps everything it loaded while the %s is on screen',
    async (view) => {
      const mock = new MockPlatform()
      mock.sessions.set('off-kept', sessionInfo('off-kept'))
      mock.messages.set('off-kept', rows('off-kept', 150))
      await useStore.getState().attach(mock)
      useStore.getState().focusSession('off-kept')
      expect(await readAll('off-kept')).toEqual(L(150))

      // Looking elsewhere does not take focus: the session stays focused, only the view changes
      useStore.getState().setView(view)
      mock.emit({ sessionId: 'off-kept', type: 'tool_call', callId: 'c151', summary: { tool: 'Read', title: 'L151' } } as never)

      const st = useStore.getState()
      expect(st.focusedSessionId).toBe('off-kept')
      expect(st.chat['off-kept']!.map(line)).toEqual(L(151))
      expect(st.history['off-kept']).toMatchObject({ oldestSeq: 1, more: false })
    },
  )
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

  it.each(['check', 'install'] as const)('ignores a late %s response from a host swapped mid-install (#635)', async (action) => {
    const platform = new MockPlatform()
    let resolve!: (value: typeof status) => void
    const gate = new Promise<typeof status>((r) => { resolve = r })
    const spy = action === 'check'
      ? vi.spyOn(platform.updates, 'status').mockReturnValueOnce(gate)
      : vi.spyOn(platform.updates, 'apply').mockReturnValueOnce(gate)
    useStore.setState({ platform, update: { ...status, phase: 'updating' }, hostResyncs: 0 })
    const pending = action === 'check' ? useStore.getState().checkUpdate(true) : useStore.getState().applyUpdate()
    const replacement = { ...status, current: '9999.0.0', newer: false }
    useStore.setState({ update: replacement, hostResyncs: 1 })
    resolve(status)
    await pending
    expect(useStore.getState().update).toEqual(replacement)
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('re-reads update status after reconnect without replaying an install (#635)', async () => {
    const platform = new MockPlatform()
    platform.registryVersion = '9999.0.2'
    const apply = vi.spyOn(platform.updates, 'apply')
    useStore.setState({ platform, update: { ...status, phase: 'updating' }, sessions: {}, chat: {}, connection: 'connected' })
    await useStore.getState().recoverAfterReconnect(true)
    await vi.waitFor(() => expect(useStore.getState().update?.latest).toBe('9999.0.2'))
    expect(useStore.getState().update?.phase).toBe('idle')
    expect(apply).not.toHaveBeenCalled()
    apply.mockRestore()
  })

  /**
   * An agent's "Apply now" (#665): the host asks over the event stream, and the window answers with the checks its
   * button makes; told to go, it runs the button's own `applyUpdateNow`. The mock plays the host's half
   * (`agentApply`), the window's half is the store's.
   */
  describe('an agent applying the installed update (#665)', () => {
    const installed = { ...status, current: '0.0.1', latest: '9999.0.0', phase: 'restart_required' as const }
    function windowOf(platform: MockPlatform) {
      useStore.setState({ platform, update: installed })
      return platform.agents.subscribe((e) => useStore.getState().dispatchEvent(e))
    }

    it('a request reaches the window, which relaunches through applyUpdateNow once', async () => {
      const platform = new MockPlatform()
      platform.relaunchCheck = { ready: true, version: '9999.0.0' }
      const stop = windowOf(platform)
      const applyNow = vi.fn(useStore.getState().applyUpdateNow)
      useStore.setState({ applyUpdateNow: applyNow })
      // What the host had heard when the shell was asked to relaunch: "started" comes first (#665 review)
      const relaunch = platform.relaunch.relaunch
      let heardBefore: unknown[] = []
      platform.relaunch.relaunch = async () => {
        heardBefore = [...platform.applyReports]
        await relaunch()
      }
      expect(await platform.agentApply()).toEqual({ ok: true })
      expect(applyNow).toHaveBeenCalledTimes(1)
      expect(platform.relaunches).toBe(1)
      expect(platform.applyAnswers).toEqual([expect.objectContaining({ ready: true, version: '9999.0.0' })])
      expect(heardBefore).toEqual([expect.objectContaining({ started: true })])
      expect(platform.applyReports).toEqual([expect.objectContaining({ started: true }), expect.not.objectContaining({ error: expect.anything() })])
      stop()
    })

    it("a go for another window's ticket, or replayed, relaunches nothing", async () => {
      const platform = new MockPlatform()
      platform.relaunchCheck = { ready: true, version: '9999.0.0' }
      const stop = windowOf(platform)
      useStore.getState().dispatchEvent({ type: 'update_apply_go', requestId: 'r', ticket: 'someone-else' })
      expect(await platform.agentApply()).toEqual({ ok: true })
      // The same go again, as a reconnect would replay it
      useStore.getState().dispatchEvent({ type: 'update_apply_go', requestId: 'apply-1', ticket: 'ticket-apply-1' })
      await Promise.resolve()
      expect(platform.relaunches).toBe(1)
      stop()
    })

    it('nothing installed: the window says so and nothing relaunches', async () => {
      const platform = new MockPlatform()
      platform.relaunchCheck = { ready: false, reason: 'not replaced' }
      const stop = windowOf(platform)
      useStore.setState({ update: { ...status, phase: 'idle' } })
      expect(await platform.agentApply()).toEqual({ ok: false, error: expect.stringContaining('No update is installed') })
      expect(platform.relaunches).toBe(0)
      stop()
    })

    it("the shell's refusal at the go reaches the host", async () => {
      const platform = new MockPlatform()
      platform.relaunchCheck = { ready: true, version: '9999.0.0' }
      platform.relaunchFails = 'Not relaunched: the keeper is too old.'
      const stop = windowOf(platform)
      expect(await platform.agentApply()).toEqual({ ok: false, error: 'Not relaunched: the keeper is too old.' })
      stop()
    })
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
    payload: { type: 'tool_call', summary: { tool: 'Bash', title: 'pnpm test' } },
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

  it('a restored card keeps the files its call named, so their paths are links as they were live', () => {
    const named = {
      ...call(1),
      payload: { type: 'tool_call', summary: { tool: 'Read', title: 'Read: /repo/a.ts', paths: ['/repo/a.ts'] } },
    }
    expect(messagesToChat([named])[0]).toMatchObject({ kind: 'tool', paths: ['/repo/a.ts'] })
    // A call that named none (and a row written before `paths` was kept) carries no field
    expect(messagesToChat([call(1)])[0]).not.toHaveProperty('paths')
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
    summary: { tool: 'Agent', title: 'Research the build', paths: [] },
  }
  const bashCall = {
    type: 'tool_call', callId: 'toolu_bash',
    summary: { tool: 'Bash', title: 'git status', paths: [] },
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
    step(sessionId, { type: 'tool_call', callId: 'toolu_sub', summary: { tool: 'Grep', title: 'Grep: boundaries', paths: [] } })
  const grepDone = (sessionId: string) => step(sessionId, { type: 'tool_result', callId: 'toolu_sub', ok: true, summary: 'tooling/boundaries.test.ts' })
  const said = (sessionId: string, text: string) => step(sessionId, { type: 'message_delta', role: 'assistant', text })

  const setup = async (s: string) => {
    const mock = new MockPlatform()
    mock.sessions.set(s, sessionInfo(s))
    await useStore.getState().attach(mock)
    mock.emit({ sessionId: s, type: 'tool_call', callId: AGENT, summary: { tool: 'Agent', title: 'Research', paths: [] } } as NormalizedEvent)
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

  it('a closed card lets go of its steps when its conversation is cut back to the window, and reads them again when opened (#392)', async () => {
    const s = 'sub-trim'
    const mock = await setup(s)
    mock.sessions.set('sub-other', sessionInfo('sub-other'))
    await useStore.getState().attach(mock)
    mock.emit(grep(s))
    useStore.getState().focusSession(s)
    useStore.getState().toggleSubagentSteps(s, AGENT)
    await vi.waitFor(() => expect(steps(s)).toEqual(['Grep: boundaries']))
    useStore.getState().toggleSubagentSteps(s, AGENT)
    const OPEN = 'toolu_still_open'
    useStore.setState((st) => ({
      // A conversation longer than the window, so leaving it cuts it back; and a second card the person left open
      chat: { ...st.chat, [s]: Array.from({ length: 120 }, (_, i) => ({ kind: 'assistant', seq: i + 1, storedSeq: i + 1, text: `L${i + 1}` }) as ChatItem) },
      subagentSteps: { ...st.subagentSteps, [s]: { ...st.subagentSteps[s], [OPEN]: { open: true, rows: [], more: false, loading: false, error: null } } },
    }))

    useStore.getState().focusSession('sub-other')
    expect(useStore.getState().chat[s]!.length).toBeLessThan(120)
    expect(Object.keys(useStore.getState().subagentSteps[s] ?? {})).toEqual([OPEN])

    useStore.getState().toggleSubagentSteps(s, AGENT)
    await vi.waitFor(() => expect(steps(s)).toEqual(['Grep: boundaries']))
    expect(mock.subagentReads).toBe(2)
  })

  it('so does a closed card of a session that is not on screen, when the off-screen trim cuts it (#392)', async () => {
    const s = 'sub-offscreen'
    const mock = await setup(s)
    mock.sessions.set('sub-seen', sessionInfo('sub-seen'))
    await useStore.getState().attach(mock)
    mock.emit(grep(s))
    useStore.getState().toggleSubagentSteps(s, AGENT)
    await vi.waitFor(() => expect(steps(s)).toEqual(['Grep: boundaries']))
    useStore.getState().toggleSubagentSteps(s, AGENT)
    useStore.getState().focusSession('sub-seen')
    for (let i = 1; i <= 300; i++) {
      mock.emit({ sessionId: s, type: 'tool_call', callId: `c${i}`, summary: { tool: 'Read', title: `L${i}` } } as never)
    }
    expect(useStore.getState().chat[s]!.length).toBeLessThanOrEqual(100)
    expect(useStore.getState().subagentSteps[s]?.[AGENT]).toBeUndefined()
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
      summary: { tool: 'Read', title: 'a.ts', paths: [] },
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

/**
 * Handing off and starting fresh (a dogfooding request — the way out of the 7-13 second resume delay
 * on an old thread). The dying session's written text becomes the new session's first message, its
 * name and settings carry over, and the old session is deleted all the way to its own original —
 * since #204 it goes to the trash, and its tool file goes when it is deleted for good.
 * Destruction comes last — a failure deletes nothing.
 */
/**
 * An external app's "changed" (M4 B-5): the store only counts, per (project, app). Re-reading is the
 * open view's own job, through its state tool — the store never asks the host for it.
 */
describe('an external app\'s change signal (M4 B-5)', () => {
  it('a broadcast only bumps that (project, app)\'s counter', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)

    mock.emit({ type: 'external_app_state_changed', appId: 'notes', projectId: 'p1' } as NormalizedEvent)
    mock.emit({ type: 'external_app_state_changed', appId: 'notes', projectId: 'p1' } as NormalizedEvent)
    mock.emit({ type: 'external_app_state_changed', appId: 'notes', projectId: null } as NormalizedEvent)
    await vi.waitFor(() => expect(useStore.getState().externalAppChanges[externalAppKey(null, 'notes')]).toBe(1))

    expect(useStore.getState().externalAppChanges).toEqual({ 'p1/notes': 2, '_user/notes': 1 })
    // The `notes` app of two different projects are two different apps — their keys never collide
    expect(externalAppKey('p2', 'notes')).not.toBe(externalAppKey('p1', 'notes'))
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

  it('a linked machine’s user-folder app opens on that machine, apart from this computer’s app of the same id (#82)', async () => {
    const mock = await live()
    useStore.getState().openApp(null, 'slider', { machine: 'm1' })
    expect(useStore.getState().focusedApp).toEqual({ projectId: null, appId: 'slider', machine: 'm1' })
    await useStore.getState().startPinnedView('m1:_user/slider')
    useStore.getState().openApp(null, 'slider')
    await useStore.getState().startPinnedView('_user/slider')
    expect(mock.openedViews).toEqual([
      { appId: 'slider', projectId: null, machine: 'm1' },
      { appId: 'slider', projectId: null },
    ])
    // Two views, one per machine: closing theirs leaves this computer's open
    expect(pinned().map((p) => p.key)).toEqual(['m1:_user/slider', '_user/slider'])
    useStore.getState().closeApp('m1:_user/slider')
    expect(pinned().map((p) => p.key)).toEqual(['_user/slider'])
  })

  it('removing a linked machine’s user-folder app names that machine; removing this computer’s names none (#82)', async () => {
    const mock = await live()
    const removed: unknown[][] = []
    vi.spyOn(mock.apps, 'remove').mockImplementation(async (...args: unknown[]) => void removed.push(args))
    expect(await useStore.getState().removeUserApp('slider', 'm1')).toBe(true)
    expect(await useStore.getState().removeUserApp('slider')).toBe(true)
    expect(removed).toEqual([
      ['slider', null, 'm1'],
      ['slider', null, undefined],
    ])
  })

  it('Restart of a linked machine’s user-folder app restarts it on that machine, not this computer’s app of the same id (#82)', async () => {
    const mock = await live()
    const restarts: unknown[][] = []
    vi.spyOn(mock.apps, 'restart').mockImplementation(async (...args: unknown[]) => void restarts.push(args))
    useStore.getState().openApp(null, 'slider', { machine: 'm1' })
    await useStore.getState().startPinnedView('m1:_user/slider')
    await useStore.getState().restartApp('m1:_user/slider')
    useStore.getState().openApp(null, 'slider')
    await useStore.getState().startPinnedView('_user/slider')
    await useStore.getState().restartApp('_user/slider')
    expect(restarts).toEqual([
      ['slider', null, 'm1'],
      ['slider', null, undefined],
    ])
  })

  it.each(['pinned', 'project panel', 'grid', 'linked user app', 'restored window'])(
    '%s waits for a replacement host after its instance-open answer is dropped', async (path) => {
      const mock = await live()
      if (path === 'restored window') {
        mock.workspaceSnapshot = { view: 'app', focusedApp: { projectId: 'p1', appId: 'slider' } }
        await useStore.getState().attach(mock)
      } else if (path === 'grid') useStore.getState().ensureGridAppView('p1', 'slider')
      else if (path === 'project panel') useStore.getState().ensurePinnedView('p1', 'slider')
      else if (path === 'linked user app') useStore.getState().openApp(null, 'slider', { machine: 'm1' })
      else useStore.getState().openApp('p1', 'slider')
      const key = pinned()[0]!.key
      const keys: (string | undefined)[] = []
      const recoveries: (boolean | undefined)[] = []
      const answer = { instanceId: 'kept-view', tool: 'home', resourceUri: 'ui://slider/main', toolInput: {}, toolResult: { content: [] }, runId: 'once' }
      mock.openViewProvider = async (_a, _p, openKey, recover) => {
        keys.push(openKey)
        recoveries.push(recover)
        if (keys.length === 1) {
          mock.setConnectionState('disconnected')
          throw Object.assign(new Error('Host restarted before an answer came'), { code: 'connection_lost' })
        }
        return answer
      }
      const opening = useStore.getState().startPinnedView(key)
      await Promise.resolve()
      expect(pinned()[0]).toMatchObject({ phase: 'opening', error: null })
      expect(keys).toHaveLength(1)
      mock.setConnectionState('resync_required')
      await opening
      expect(pinned()[0]).toMatchObject({ phase: 'open', instanceId: 'kept-view', error: null })
      expect(keys).toHaveLength(2)
      expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/)
      expect(keys[1]).toBe(keys[0])
      expect(recoveries).toEqual([false, true])
    },
  )

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

    const done = useStore.getState().handoffSession('ho-s1', { mode: 'agent' })
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
    // and that the original goes next (#738), so the host gives the new session every child, settled ones too
    expect(mock.lastCreateParams?.handoff).toEqual({ from: 'Mea', note: 'To my successor: status summary', fromSessionId: 'ho-s1', removesOriginal: true })
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

  // #841 item 5: a note the host could not write read as "no note yet" and was polled for ten minutes
  it('stops at once and says why when the host cannot save the note', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-fail')
    mock.sessions.set('ho-f1', sessionInfo('ho-f1', { projectId: proj.id, name: 'Mea' }))
    mock.agents.exportHandoffNote = async () => {
      throw new Error('EACCES: permission denied')
    }
    await useStore.getState().attach(mock)
    const before = mock.sessions.size

    const done = useStore.getState().handoffSession('ho-f1', { mode: 'agent' })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-f1'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    mock.emit({ type: 'turn_complete', sessionId: 'ho-f1' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-f1', state: 'waiting_input' } as NormalizedEvent)
    await vi.waitFor(() => expect(useStore.getState().toast).toContain('could not save the handoff note: EACCES: permission denied'), { timeout: 5_000 * SLOW })
    await done
    expect(mock.sessions.size).toBe(before)
    expect(mock.sessions.has('ho-f1')).toBe(true)
  })

  it('inherits the grid slot — the successor stands at the same index, and the order does not shift', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho7')
    mock.sessions.set('ho-g1', sessionInfo('ho-g1', { projectId: proj.id }))
    mock.sessions.set('ho-g2', sessionInfo('ho-g2', { projectId: proj.id, name: 'Middle' }))
    mock.sessions.set('ho-g3', sessionInfo('ho-g3', { projectId: proj.id }))
    await mock.agents.setGridView(['ho-g1', 'ho-g2', 'ho-g3'].map(sessionGridPanel))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-g2', { mode: 'agent' })
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

  /*
   * The note comes from the record unless the caller asks the agent (owner decision on #694): a live session that
   * could answer is still not asked, since it is the one least likely to summarize itself correctly.
   */
  it('builds the note from the record by default, even for a live session, and keeps the original (#694)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho-default')
    mock.sessions.set('ho-d1', sessionInfo('ho-d1', { projectId: proj.id, name: 'Live Mea', tool: 'claude', state: 'idle' }))
    await useStore.getState().attach(mock)

    await useStore.getState().handoffSession('ho-d1')

    expect((useStore.getState().chat['ho-d1'] ?? []).some((i) => i.kind === 'user')).toBe(false)
    expect(mock.lastCreateParams?.handoff?.note).toContain('Handoff Record')
    expect(mock.lastCreateParams?.tool).toBe('claude')
    expect(mock.sessions.has('ho-d1')).toBe(true)
    expect(mock.lastCreateParams?.handoff?.removesOriginal).toBeUndefined()
  })

  it('deletes nothing if the session errors while writing — destruction only follows success', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho2')
    mock.sessions.set('ho-s2', sessionInfo('ho-s2', { projectId: proj.id, name: 'Mea 2' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-s2', { mode: 'agent' })
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

    const done = useStore.getState().handoffSession('ho-s5', { mode: 'agent', tool: 'claude' })
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

    const done = useStore.getState().handoffSession('ho-s6', { mode: 'agent', deleteOld: false })
    await vi.waitFor(() => {
      expect((useStore.getState().chat['ho-s6'] ?? []).some((i) => i.kind === 'user')).toBe(true)
    })
    mockNote(mock, 'ho-s6', 'branch note')
    mock.emit({ type: 'turn_complete', sessionId: 'ho-s6' } as NormalizedEvent)
    mock.emit({ type: 'state_change', sessionId: 'ho-s6', state: 'waiting_input' } as NormalizedEvent)
    await done

    expect(mock.sessions.has('ho-s6')).toBe(true) // The old session survives
    // It keeps its settled children: the host is not told the original goes (#738)
    expect(mock.lastCreateParams?.handoff).not.toHaveProperty('removesOriginal')
    expect(mock.externallyDeleted).not.toContain('ho-s6')
    expect([...mock.sessions.values()].filter((r) => r.name === 'Branch').length).toBe(2)
  })

  it('a running turn\'s report never mixes into the top of the note — the request waits for the turn to end (measured in the Mea session)', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/ho4')
    mock.sessions.set('ho-s4', sessionInfo('ho-s4', { projectId: proj.id, name: 'Mea 4', state: 'working' }))
    await useStore.getState().attach(mock)

    const done = useStore.getState().handoffSession('ho-s4', { mode: 'agent' })
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

    const done = useStore.getState().handoffSession('ho-big', { mode: 'agent' })
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

    const done = useStore.getState().handoffSession('ho-sw', { mode: 'agent', deleteOld: false })
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
    const a = useStore.getState().handoffSession('ho-a', { mode: 'agent', deleteOld: false })
    const b = useStore.getState().handoffSession('ho-b', { mode: 'agent', deleteOld: false })
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

    const done = useStore.getState().handoffSession('ho-st', { mode: 'agent', deleteOld: false })
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

    const done = useStore.getState().handoffSession('ho-lag', { mode: 'agent', deleteOld: false })
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

/** A new project (#515): made from this window it joins at once; made by the host on its own, the event brings it */
describe('new projects', () => {
  it('a project the host made (the orchestrator, once approved) joins the list on projects_changed, after the ones there', async () => {
    const mock = new MockPlatform()
    await mock.projects.add('/tmp/old')
    await useStore.getState().attach(mock)
    const before = useStore.getState().projects
    // Made behind the window's back, as the orchestrator's card does
    const made = await mock.projects.create('shop')
    expect(Object.keys(useStore.getState().projects)).not.toContain(made.id)

    mock.emit({ type: 'projects_changed' } as NormalizedEvent)

    await vi.waitFor(() => expect(Object.keys(useStore.getState().projects)).toEqual([...Object.keys(before), made.id]))
    // The rows already listed keep their objects
    for (const id of Object.keys(before)) expect(useStore.getState().projects[id]).toBe(before[id])
  })

  it('a setting another client wrote (trust, commands) replaces the listed value on projects_changed, and git stays as the window has it (#719)', async () => {
    const mock = new MockPlatform()
    const p = await mock.projects.add('/tmp/old')
    await useStore.getState().attach(mock)
    const other = await mock.projects.add('/tmp/other')
    mock.emit({ type: 'projects_changed' } as NormalizedEvent)
    await vi.waitFor(() => expect(useStore.getState().projects[other.id]).toBeDefined())
    const untouched = useStore.getState().projects[other.id]
    const git = { branch: 'seen-here', changedFiles: 3, isRepo: true }
    useStore.setState((s) => ({ projects: { ...s.projects, [p.id]: { ...s.projects[p.id]!, git } } }))
    expect(useStore.getState().projects[p.id]?.trusted).toBe(false)

    // Written behind the window's back, as another window or an agent over RPC does
    await mock.projects.setTrusted(p.id, true)
    await mock.projects.setCommands(p.id, [{ command: 'pnpm dev' }])
    mock.emit({ type: 'projects_changed' } as NormalizedEvent)

    await vi.waitFor(() => expect(useStore.getState().projects[p.id]?.trusted).toBe(true))
    expect(useStore.getState().projects[p.id]?.commands).toEqual([{ command: 'pnpm dev' }])
    expect(useStore.getState().projects[p.id]?.git).toEqual(git)
    // A row nothing changed for keeps its object
    expect(useStore.getState().projects[other.id]).toBe(untouched)
    expect(Object.keys(useStore.getState().projects)).toEqual([p.id, other.id])
  })

  /** A list read that answers late: it is taken when called (the host's value then) and handed back when the gate opens */
  function gatedList(mock: MockPlatform) {
    const real = mock.projects.list.bind(mock.projects)
    const gates: (() => void)[] = []
    let calls = 0
    mock.projects.list = async () => {
      calls++
      const answer = structuredClone(await real())
      await new Promise<void>((open) => gates.push(open))
      return answer
    }
    return { host: real, calls: () => calls, open: () => gates.splice(0).forEach((g) => g()), waiting: () => gates.length }
  }

  it('a list read that began before this window saved commands does not take the old list back over them (#719)', async () => {
    const mock = new MockPlatform()
    const p = await mock.projects.add('/tmp/old')
    await useStore.getState().attach(mock)
    const list = gatedList(mock)
    const reading = useStore.getState().refreshProjects()
    await vi.waitFor(() => expect(list.waiting()).toBe(1))
    // The person's edit lands while that read is out, and the read comes back with the list from before it
    await useStore.getState().setProjectCommands(p.id, [{ command: 'pnpm dev' }])
    list.open()
    await vi.waitFor(() => expect(list.waiting()).toBe(1))
    expect(useStore.getState().projects[p.id]?.commands).toEqual([{ command: 'pnpm dev' }])
    // The withheld project is read again, and the host's value then is the one kept
    list.open()
    await reading
    expect(list.calls()).toBe(2)
    expect(useStore.getState().projects[p.id]?.commands).toEqual([{ command: 'pnpm dev' }])
    expect((await list.host()).find((x) => x.id === p.id)?.commands).toEqual([{ command: 'pnpm dev' }])
  })

  it('a list read answering while this window\'s save is still out leaves the project alone, then reads it when the save is done (#719)', async () => {
    const mock = new MockPlatform()
    const p = await mock.projects.add('/tmp/old')
    await useStore.getState().attach(mock)
    const realSet = mock.projects.setCommands.bind(mock.projects)
    let finishSave!: () => void
    mock.projects.setCommands = async (id, commands) => {
      await new Promise<void>((done) => (finishSave = done))
      return realSet(id, commands)
    }
    const saving = useStore.getState().setProjectCommands(p.id, [{ command: 'pnpm dev' }])
    await vi.waitFor(() => expect(finishSave).toBeTypeOf('function'))
    // A read that starts and ends inside the save, from a host that has not answered the save yet
    const list = gatedList(mock)
    const reading = useStore.getState().refreshProjects()
    await vi.waitFor(() => expect(list.waiting()).toBe(1))
    list.open()
    await reading
    expect(useStore.getState().projects[p.id]?.commands).toEqual([{ command: 'pnpm dev' }])
    const callsBefore = list.calls()
    finishSave()
    await saving
    await vi.waitFor(() => expect(list.calls()).toBe(callsBefore + 1))
    list.open()
    await vi.waitFor(() => expect(list.waiting()).toBe(0))
    expect(useStore.getState().projects[p.id]?.commands).toEqual([{ command: 'pnpm dev' }])
  })

  it('reads of the project list run one at a time, so an older answer cannot land after a newer one (#719)', async () => {
    const mock = new MockPlatform()
    const p = await mock.projects.add('/tmp/old')
    await useStore.getState().attach(mock)
    const list = gatedList(mock)
    const first = useStore.getState().refreshProjects()
    await vi.waitFor(() => expect(list.waiting()).toBe(1))
    // Another client trusts the project, then a second read is asked for while the first is out
    await mock.projects.setTrusted(p.id, true)
    const second = useStore.getState().refreshProjects()
    await new Promise((r) => setTimeout(r, 30))
    expect(list.calls()).toBe(1)
    list.open()
    await vi.waitFor(() => expect(list.waiting()).toBe(1))
    expect(list.calls()).toBe(2)
    list.open()
    await Promise.all([first, second])
    expect(useStore.getState().projects[p.id]?.trusted).toBe(true)
  })

  it('createProject registers what the host made, and asks about trust only for a clone (#655, #999)', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    // An empty folder the host made itself starts trusted: nothing to ask
    const p = await useStore.getState().createProject('site')
    expect(p.path).toBe('/Users/you/Centralu/site')
    expect(useStore.getState().projects[p.id]).toEqual(p)
    expect(useStore.getState().trustAsk).toBeNull()
    await expect(useStore.getState().createProject('site')).rejects.toThrow(/already in/)
    // A clone holds a stranger's code: the person decides, once
    const clone = await useStore.getState().createProject('', undefined, null, { git: 'https://github.com/me/app.git' })
    expect(useStore.getState().trustAsk).toBe(clone.id)
  })
})

/**
 * An MCP server suggestion card (option B) — the host says when a list changed, and clicking approve goes to the host.
 *
 * The screen never guesses the moment from the orchestrator's `tool_call` (#703): that event arrives when the call
 * starts, before the host has saved the proposal, so a read on it returns the old list.
 */
describe('MCP server suggestions', () => {
  it('the card appears when the host saves the proposal after the tool_call arrived (#703)', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('mcp-s1', sessionInfo('mcp-s1'))
    await useStore.getState().attach(mock)

    // The order the host really has: the call starts (the event goes out), and only then is the proposal saved
    mock.emit({
      type: 'tool_call', sessionId: 'mcp-s1', callId: 'c1',
      summary: { tool: 'mcp__centralu__propose_mcp_server', title: 'playwright', paths: [] },
    } as NormalizedEvent)
    await Promise.resolve()
    expect(useStore.getState().mcpProposals).toEqual([])
    mock.saveProposal({ mcp: { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'], why: 'browser' } })

    await vi.waitFor(() => {
      expect(useStore.getState().mcpProposals).toEqual([
        { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'], why: 'browser' },
      ])
    })
  })

  it('a tool_call alone does not read the lists: the host broadcast is the signal', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('mcp-s2', sessionInfo('mcp-s2'))
    await useStore.getState().attach(mock)
    const read = vi.spyOn(mock.agents, 'mcpProposals')

    for (const tool of ['mcp__centralu__propose_mcp_server', 'mcp__centralu__propose_skill', 'centralu_run']) {
      mock.emit({
        type: 'tool_call', sessionId: 'mcp-s2', callId: tool,
        summary: { tool, title: tool, paths: [] },
      } as NormalizedEvent)
    }
    await Promise.resolve()
    expect(read).not.toHaveBeenCalled()
  })

  /*
   * A host that predates `orchestrator_proposals_changed` (an old host still serving during a swap) sends only the
   * tool events. The result comes after the save, so it re-reads: the one place a guess about the tool name stays.
   */
  it('the tool_result of a proposal call re-reads both lists, for a host that does not broadcast', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('mcp-s3', sessionInfo('mcp-s3'))
    await useStore.getState().attach(mock)
    mock.sessions.set('mcp-s3b', sessionInfo('mcp-s3b'))
    const call = (tool: string, callId: string, sessionId = 'mcp-s3') =>
      mock.emit({ type: 'tool_call', sessionId, callId, summary: { tool, title: tool, paths: [] } } as NormalizedEvent)
    const result = (callId: string, sessionId = 'mcp-s3') => mock.emit({ type: 'tool_result', sessionId, callId, ok: true, summary: '' } as NormalizedEvent)
    const read = vi.spyOn(mock.agents, 'mcpProposals')

    // An unrelated call's result reads nothing
    call('Bash', 'other')
    result('other')
    await Promise.resolve()
    expect(read).not.toHaveBeenCalled()

    // Call ids may repeat between sessions (a Codex id is unique per thread): another session's result is not this call's
    call('centralu_run', 'same-id')
    result('same-id', 'mcp-s3b')
    await Promise.resolve()
    expect(read).not.toHaveBeenCalled()
    result('same-id')
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    read.mockClear()

    // The old host saved without announcing (the lists change silently), then the call returned
    call('centralu_run', 'run-1')
    mock.mcpProposalList.push({ name: 'playwright', command: 'npx', args: [] })
    mock.skillProposalList.push({ name: 'weekly-report', content: 'a summary every Friday' })
    expect(useStore.getState().mcpProposals).toEqual([])
    result('run-1')
    await vi.waitFor(() => {
      expect(useStore.getState().mcpProposals.map((p) => p.name)).toEqual(['playwright'])
      expect(useStore.getState().skillProposals.map((p) => p.name)).toEqual(['weekly-report'])
    })
  })

  it('a reconnect re-reads both lists: a broadcast lost in the gap leaves no stale card, count or badge', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.saveProposal({ mcp: { name: 'playwright', command: 'npx', args: [] } })
    await vi.waitFor(() => expect(useStore.getState().mcpProposals).toHaveLength(1))
    expect(mock.badge).toBe(1)

    // While the socket was down the person answered in another window and the orchestrator proposed a skill: no event arrived
    mock.mcpProposalList.splice(0)
    mock.skillProposalList.push({ name: 'weekly-report', content: 'a summary every Friday' })
    expect(useStore.getState().mcpProposals).toHaveLength(1)

    await useStore.getState().recoverAfterReconnect(true)

    await vi.waitFor(() => {
      expect(useStore.getState().mcpProposals).toEqual([])
      expect(useStore.getState().skillProposals.map((p) => p.name)).toEqual(['weekly-report'])
      expect(computeInbox(useStore.getState()).map((i) => i.proposal)).toEqual([{ kind: 'skill', name: 'weekly-report' }])
    })
    expect(mock.badge).toBe(1)
  })

  it('one broadcast re-reads both lists, whichever tool or command made the change', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.mcpProposalList.push({ name: 'playwright', command: 'npx', args: [] })
    mock.skillProposalList.push({ name: 'weekly-report', content: 'a summary every Friday' })

    mock.emit({ type: 'orchestrator_proposals_changed' })

    await vi.waitFor(() => {
      expect(useStore.getState().mcpProposals.map((p) => p.name)).toEqual(['playwright'])
      expect(useStore.getState().skillProposals.map((p) => p.name)).toEqual(['weekly-report'])
    })
  })

  it('a proposal answered elsewhere (another window) leaves the list without a reload', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.saveProposal({ mcp: { name: 'playwright', command: 'npx', args: [] } })
    await vi.waitFor(() => expect(useStore.getState().mcpProposals).toHaveLength(1))

    // The other window's answer: the host drops the proposal and broadcasts
    mock.mcpProposalList.splice(0)
    mock.emit({ type: 'orchestrator_proposals_changed' })

    await vi.waitFor(() => expect(useStore.getState().mcpProposals).toEqual([]))
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

/** A skill suggestion (#71) — the same rail as an MCP suggestion: the host's broadcast wakes the list, and approval goes to the host */
describe('skill suggestions', () => {
  it('the card appears when the host saves the proposal after the tool_call, and approving leads to a save', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('sk-s1', sessionInfo('sk-s1'))
    await useStore.getState().attach(mock)

    mock.emit({
      type: 'tool_call', sessionId: 'sk-s1', callId: 'c1',
      summary: { tool: 'mcp__centralu__propose_skill', title: 'weekly-report', paths: [] },
    } as NormalizedEvent)
    await Promise.resolve()
    mock.saveProposal({ skill: { name: 'weekly-report', content: 'a summary every Friday', why: 'a recurring request' } })
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

/** A pending proposal waits on the person like an approval does (#703): it is counted, listed and jumped to */
describe('pending proposals wait on the person', () => {
  it('count and list with the approvals, and a jump lands on the orchestrator screen', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('pw-s1', sessionInfo('pw-s1'))
    await useStore.getState().attach(mock)
    expect(computeInbox(useStore.getState())).toEqual([])

    mock.saveProposal({ mcp: { name: 'playwright', command: 'npx', args: [] } })
    mock.saveProposal({ skill: { name: 'weekly-report', content: 'a summary every Friday' } })
    await vi.waitFor(() => expect(computeInbox(useStore.getState())).toHaveLength(2))

    const items = computeInbox(useStore.getState())
    expect(items.map((i) => [i.state, i.proposal])).toEqual([
      ['waiting_approval', { kind: 'mcp', name: 'playwright' }],
      ['waiting_approval', { kind: 'skill', name: 'weekly-report' }],
    ])
    expect(countWaiting([...items])).toMatchObject({ approval: 2 })
    // The dock badge counts them too
    expect(mock.badge).toBe(2)

    await useStore.getState().openWaiting(items[0]!.id)
    await vi.waitFor(() => expect(useStore.getState().view).toBe('orchestrator'))
  })

  it('leave the list when answered', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.saveProposal({ mcp: { name: 'playwright', command: 'npx', args: [] } })
    await vi.waitFor(() => expect(computeInbox(useStore.getState())).toHaveLength(1))

    await useStore.getState().resolveMcpProposal('playwright', false)

    expect(computeInbox(useStore.getState())).toEqual([])
    expect(mock.badge).toBe(0)
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
    ({ sessionId: 's-hist', seq, role: 'system' as const, kind: 'tool_call' as const, payload: { type: 'tool_call', callId, summary: { tool: 'mcp__app-viewer__show', title: 'show', paths: [] } }, ts: 0 })

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

  // An edit whose path is unknown has nothing to remember (#428): it used to send "(no path)" and toast it as a rule
  it('a file edit with no path sends no matcher and says it was allowed once', async () => {
    const r = await answerAlways({ kind: 'file_edit', path: NO_PATH, diffPreview: '', multi: false })
    expect(r.matcher).toBeUndefined()
    expect(r.toast).toContain('Allowed once')
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

  // #683 review: ids repeat across sessions (each process counts its own), so the guard is per session
  it('an answer in flight in one session does not swallow the same request id in another', async () => {
    const { platform, id } = await pendingCard()
    const other = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'safe' })
    useStore.setState((st) => ({
      sessions: { ...st.sessions, [other.id]: { ...other, pendingApproval: { requestId: 'r1', detail: { kind: 'command', command: 'rm x', cwd: '/tmp' } } } as never },
    }))
    const finish: (() => void)[] = []
    const spy = vi
      .spyOn(platform.agents, 'respondApproval')
      .mockImplementation(() => new Promise<void>((r) => void finish.push(r)))
    const first = useStore.getState().respondApproval(id, 'r1', 'allow')
    const second = useStore.getState().respondApproval(other.id, 'r1', 'deny')
    finish.forEach((f) => f())
    await Promise.all([first, second])
    expect(spy.mock.calls.map((c) => [c[0], c[2]])).toEqual([[id, 'allow'], [other.id, 'deny']])
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
    await useStore.getState().handoffSession('q174', { mode: 'agent' })
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

  it('returns a failure to the calling window if the worktree trunk could not be set', async () => {
    const mock = new MockPlatform()
    const proj = await mock.projects.add('/tmp/wm180')
    await useStore.getState().attach(mock)
    vi.spyOn(mock.projects, 'setWorktreeTrunk').mockRejectedValueOnce(new Error('not a git repository'))
    await expect(useStore.getState().setWorktreeTrunk(proj.id, 'main')).rejects.toThrow('Could not set the trunk: not a git repository')
    // Set, it is the project's trunk on screen
    await useStore.getState().setWorktreeTrunk(proj.id, 'develop')
    expect(useStore.getState().projects[proj.id]?.worktreeManager?.baseBranch).toBe('develop')
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
 * the snapshot. The folded-composer setting is restored last: the person turned it off, and after a restart
 * it was on again (2026-09-30).
 */
describe('restoring the workspace saves nothing until it is done', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const lateFields = { foldComposer: false }

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

    // A launch starts from the defaults, which have it on
    useStore.setState({ foldComposer: true })
    await useStore.getState().attach(mock)
    await tick()
    expect(useStore.getState()).toMatchObject(lateFields)
    // What the host keeps is what the next launch reads
    expect(mock.workspaceSnapshot).toMatchObject(lateFields)

    useStore.setState({ foldComposer: true })
    await useStore.getState().attach(mock)
    await tick()
    expect(useStore.getState()).toMatchObject(lateFields)
  })

  // #384: a snapshot an older build saved has no `done` switch; it was not a choice to turn it off
  it('a notification policy from an older snapshot takes the switches it lacks from the defaults', async () => {
    const mock = new MockPlatform()
    mock.workspaceSnapshot = { notifyPolicy: { approval: false, error: true, allDone: true, whenFocused: false, sound: 'loud' } } as never
    await useStore.getState().attach(mock)
    await tick()
    expect(useStore.getState().notifyPolicy).toEqual({ approval: false, error: true, done: true, allDone: true, whenFocused: false, sound: true })
  })

  /*
   * The control rail is gone (#97), and a snapshot written by an older build still carries its width
   * (`railWidth`). It must load like any other snapshot: the fields around it come back, and the next
   * save simply stops writing it — an older build that reads the new snapshot falls back to its own
   * default width.
   */
  it('an old snapshot that still carries the control rail\'s width loads in full, and the next save drops it (#97)', async () => {
    const mock = new MockPlatform()
    const p = await mock.projects.add('/tmp/restore-rail')
    mock.sessions.set('rail-r1', sessionInfo('rail-r1', { projectId: p.id }))
    const policy: NotifyPolicy = { ...DEFAULT_NOTIFY_POLICY, sound: !DEFAULT_NOTIFY_POLICY.sound }
    mock.workspaceSnapshot = {
      focusedSessionId: 'rail-r1',
      panelWidth: 333,
      sidebarWidth: 251,
      railWidth: 400,
      notifyPolicy: policy,
      ...lateFields,
    } as never

    useStore.setState({ foldComposer: true })
    await useStore.getState().attach(mock)
    await tick()

    expect(useStore.getState()).toMatchObject({ focusedSessionId: 'rail-r1', panelWidth: 333, sidebarWidth: 251, notifyPolicy: policy, ...lateFields })
    expect(useStore.getState()).not.toHaveProperty('railWidth')

    useStore.getState().setFoldComposer(true)
    await tick()
    expect(mock.workspaceSnapshot).toMatchObject({ panelWidth: 333, sidebarWidth: 251, foldComposer: true })
    expect(mock.workspaceSnapshot).not.toHaveProperty('railWidth')
  })

  /*
   * The spin switches left with the orbit (#736). A snapshot an older build wrote still carries them: it loads in full,
   * nothing reads them, and the next save stops writing them (an older build reading that snapshot falls back to its
   * default, which is on).
   */
  it('an old snapshot that still carries the spin switches loads in full, and the next save drops them (#736)', async () => {
    const mock = new MockPlatform()
    mock.workspaceSnapshot = { panelWidth: 333, spinGrid: false, spinSessionIcon: false, foldComposer: false } as never
    await useStore.getState().attach(mock)
    await tick()
    expect(useStore.getState()).toMatchObject({ panelWidth: 333, foldComposer: false })
    expect(useStore.getState()).not.toHaveProperty('spinGrid')
    expect(useStore.getState()).not.toHaveProperty('spinSessionIcon')

    useStore.getState().setFoldComposer(true)
    await tick()
    expect(mock.workspaceSnapshot).toMatchObject({ panelWidth: 333, foldComposer: true })
    expect(mock.workspaceSnapshot).not.toHaveProperty('spinGrid')
    expect(mock.workspaceSnapshot).not.toHaveProperty('spinSessionIcon')
  })

  it('a change the person makes after the restore is still saved', async () => {
    const mock = new MockPlatform()
    mock.workspaceSnapshot = { ...lateFields } as never
    await useStore.getState().attach(mock)
    await tick()

    useStore.getState().setFoldComposer(true)
    await tick()
    expect(mock.workspaceSnapshot).toMatchObject({ foldComposer: true })
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

  // #841 item 9: past the last retry a save stopped trying with no word, and the layout was found lost after a restart
  it('says so once the retries while connected run out', async () => {
    const mock = await attached()
    failSaves(mock, 100)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      useStore.setState({ toast: null })
      useStore.getState().toggleProjectFold('retry-out')
      await vi.advanceTimersByTimeAsync(1_000 + 5_000)
      expect(useStore.getState().toast).toBeNull()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(useStore.getState().toast).toBe('Could not save the window layout; it is tried again on the next change or reconnect')
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

  /*
   * #659: a window other than the caller (or the person's own window when an agent made the change) only learned the new
   * model and permission preset from a re-list. The mock emits what the host emits for `agents.updateSettings`.
   */
  it('a settings change another client made shows the new model and permission preset, without the orchestrator toast (#659)', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('n-4', sessionInfo('n-4', { model: 'fable', permissionPreset: 'normal' }))
    await useStore.getState().attach(mock)
    useStore.setState({ toast: null })

    await mock.agents.updateSettings('n-4', { model: 'opus', permissionPreset: 'auto' })

    expect(useStore.getState().sessions['n-4']).toMatchObject({ model: 'opus', permissionPreset: 'auto' })
    expect(useStore.getState().toast).toBeNull()
  })

  it('a settings change that lands back on the value a pending list was asked with is kept over the list (#642, #659)', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('n-5', sessionInfo('n-5', { model: 'fable', permissionPreset: 'normal' }))
    await useStore.getState().attach(mock)
    mock.setConnectionState('disconnected')
    // The list is read with this row; the settings events below are newer than it
    mock.sessions.get('n-5')!.permissionPreset = 'safe'
    const list = holdList(mock)
    const recovery = useStore.getState().recoverAfterReconnect(true)
    await list.asked
    const set = (model: string, permissionPreset: 'safe' | 'normal' | 'auto') =>
      mock.emit({ type: 'settings_changed', sessionId: 'n-5', model, effort: null, verbosity: null, serviceTier: null, permissionPreset, person: true })
    set('opus', 'auto')
    set('fable', 'normal')
    list.release()
    await recovery
    expect(useStore.getState().sessions['n-5']).toMatchObject({ model: 'fable', permissionPreset: 'normal' })
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
    error: null, versions: null, lastConnectedAt: null, localPort: null, sameLocalPort: false, hostStarted: null, install: null, operation: null, autostart: null, ...over,
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

/**
 * Back and forward between screens (#374). History is written by one subscriber, whichever action changed the
 * screen, so these go through the store's ordinary doors — the sidebar's, the grid button's, an app's — and read
 * what is on screen after each step.
 */
describe('back and forward between screens (#374)', () => {
  const live = async () => {
    const mock = new MockPlatform()
    mock.sessions.set('nav-a', sessionInfo('nav-a'))
    mock.sessions.set('nav-b', sessionInfo('nav-b'))
    mock.sessions.set('nav-c', sessionInfo('nav-c'))
    mock.externalAppList = [appInfo('slider')]
    useStore.setState({ settingsOpen: false, view: 'focus', focusedApp: null, focusedSessionId: null })
    await useStore.getState().attach(mock)
    return mock
  }
  const st = () => useStore.getState()

  it('goes back and forward between sessions, the grid and an app page', async () => {
    await live()
    st().focusSession('nav-a')
    st().focusSession('nav-b')
    st().setView('grid')
    st().openApp('p1', 'slider')

    st().goBack()
    expect(st().view).toBe('grid')
    st().goBack()
    expect(st()).toMatchObject({ view: 'focus', focusedSessionId: 'nav-b' })
    st().goBack()
    expect(st()).toMatchObject({ view: 'focus', focusedSessionId: 'nav-a' })
    st().goForward()
    st().goForward()
    expect(st().view).toBe('grid')
    st().goForward()
    expect(st()).toMatchObject({ view: 'app', focusedApp: { projectId: 'p1', appId: 'slider' } })
  })

  it('does not record a change inside a screen: a session picked inside the grid', async () => {
    await live()
    useStore.setState({ gridPanels: ['nav-b', 'nav-c'].map((sessionId) => ({ kind: 'session' as const, sessionId })) })
    st().focusSession('nav-a')
    st().setView('grid')
    st().focusSession('nav-b', { preferGrid: true, reveal: false })
    st().focusSession('nav-c', { preferGrid: true, reveal: false })
    expect(st().nav.entries.map((e) => e.kind)).toEqual(['session', 'grid'])
  })

  it('skips a session deleted since it was seen', async () => {
    await live()
    st().focusSession('nav-a')
    st().focusSession('nav-b')
    st().focusSession('nav-c')
    await st().deleteSession('nav-b')
    st().focusSession('nav-c')
    st().goBack()
    expect(st().focusedSessionId).toBe('nav-a')
  })

  it('closing Settings is a step back, and forward opens it again', async () => {
    await live()
    st().focusSession('nav-a')
    st().toggleSettings(true)
    st().toggleSettings(false)
    st().goForward()
    expect(st().settingsOpen).toBe(true)
    st().goBack()
    expect(st()).toMatchObject({ settingsOpen: false, focusedSessionId: 'nav-a' })
  })

  it('starts after a restart at the restored screen, not at the steps the restore took', async () => {
    const mock = await live()
    mock.workspaceSnapshot = { focusedSessionId: 'nav-a', view: 'grid' } as never
    await st().attach(mock)
    expect(st().nav).toEqual({ entries: [{ kind: 'grid' }], index: 0 })
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

describe('pinned views claimed back after a reconnect (#392)', () => {
  it('claims the views it shows, keeps the ones the host still has, and opens again the ones it closed', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    useStore.getState().ensurePinnedView('p1', 'kept')
    useStore.getState().ensurePinnedView('p1', 'lost')
    useStore.getState().ensurePinnedView('p1', 'never')
    await useStore.getState().startPinnedView(externalAppKey('p1', 'kept'))
    await useStore.getState().startPinnedView(externalAppKey('p1', 'lost'))
    const of = (appId: string) => useStore.getState().pinnedViews.find((p) => p.key === externalAppKey('p1', appId))!
    const kept = of('kept').instanceId!
    const lost = of('lost').instanceId!
    // The window was away longer than the host waited: it closed the view it no longer saw claimed
    mock.pinnedInstances.delete(lost)

    mock.setConnectionState('disconnected')
    mock.setConnectionState('connected')

    await vi.waitFor(() => expect(of('lost').phase).toBe('idle'))
    // Only open views are claimed; one that never opened has nothing to claim
    expect(mock.heldViews).toEqual([[kept, lost]])
    expect(of('lost').instanceId).toBeNull()
    expect(of('kept')).toMatchObject({ phase: 'open', instanceId: kept })
    expect(of('never').phase).toBe('idle')
  })
})

describe('a parked in-conversation view lets go of its call (#392)', () => {
  it('a placeholder keeps neither the input nor the result, and reopening brings both back from the host', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('iv392', sessionInfo('iv392'))
    await useStore.getState().attach(mock)
    const big = 'x'.repeat(200_000)
    const base = { type: 'app_view', sessionId: 'iv392', callId: 'c1', appId: 'viewer', projectId: 'p1', tool: 'show' } as const
    mock.emit({ ...base, phase: 'open', instanceId: 'inst-iv392', toolInput: { text: big } } as NormalizedEvent)
    mock.emit({ ...base, phase: 'result', toolResult: { content: [{ type: 'text', text: big }] }, kept: true } as NormalizedEvent)
    const view = () => useStore.getState().inlineViews['iv392']!['c1']!
    expect(view().toolResult).toBeDefined()

    await useStore.getState().closeInlineView('iv392', 'c1', 'Scrolled away')
    expect(view()).toMatchObject({ state: 'parked', instanceId: null, kept: true })
    expect(view().toolInput).toBeUndefined()
    expect(view().toolResult).toBeUndefined()

    await useStore.getState().reopenInlineView('iv392', 'c1')
    expect(view().state).toBe('live')
    expect(view().toolInput).toEqual({ text: big })
    expect(view().toolResult).toEqual({ content: [{ type: 'text', text: big }] })
  })
})

describe('a conversation view opening across a host swap', () => {
  it('retries the session/call reopen after a dropped answer without repeating its app tool', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('iv-swap', sessionInfo('iv-swap'))
    await useStore.getState().attach(mock)
    const base = { type: 'app_view', sessionId: 'iv-swap', callId: 'c1', appId: 'viewer', projectId: 'p1', tool: 'show' } as const
    mock.emit({ ...base, phase: 'open', instanceId: 'first-inline', toolInput: { once: true } } as NormalizedEvent)
    mock.emit({ ...base, phase: 'result', toolResult: { content: [] }, kept: true } as NormalizedEvent)
    await useStore.getState().closeInlineView('iv-swap', 'c1', 'Scrolled away')
    const reopen = mock.apps.reopenInlineView
    let opened: Awaited<ReturnType<typeof reopen>>
    const retry = vi.spyOn(mock.apps, 'reopenInlineView').mockImplementation(async (...args) => {
      if (retry.mock.calls.length === 1) {
        opened = await reopen(...args)
        mock.setConnectionState('disconnected')
        throw Object.assign(new Error('Connection lost'), { code: 'connection_lost' })
      }
      return reopen(...args)
    })
    const opening = useStore.getState().reopenInlineView('iv-swap', 'c1')
    await vi.waitFor(() => expect(useStore.getState().connection).toBe('disconnected'))
    mock.setConnectionState('resync_required')
    await opening
    expect(useStore.getState().inlineViews['iv-swap']!['c1']).toMatchObject({ state: 'live', instanceId: opened!.instanceId })
    expect(retry).toHaveBeenCalledTimes(2)
    expect(mock.appToolCalls).toEqual([])
  })
})

describe('an orphaned in-conversation view is remembered only while its close is on its way (#392)', () => {
  it('is closed once while the close is pending, and again if the host still holds it afterwards', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('orph392', sessionInfo('orph392'))
    await useStore.getState().attach(mock)
    // The host holds a view this window is not drawing (the window reloaded)
    vi.spyOn(mock.apps, 'inlineViews').mockResolvedValue([
      { callId: 'c1', appId: 'viewer', projectId: 'p1', tool: 'show', kept: true, instanceId: 'orphan-392' },
    ])
    let fail: (e: Error) => void = () => {}
    const close = vi.spyOn(mock.apps, 'closeView').mockImplementationOnce(() => new Promise<void>((_, reject) => (fail = reject)))

    // Two reads while the first close is still on its way: one close
    await useStore.getState().loadHistory('orph392')
    await useStore.getState().loadHistory('orph392')
    expect(close).toHaveBeenCalledTimes(1)

    // That close never reached the host, which still holds the view: the next read closes it again
    fail(new Error('disconnected'))
    await vi.waitFor(async () => {
      await useStore.getState().loadHistory('orph392')
      expect(close).toHaveBeenCalledTimes(2)
    })
  })
})

/**
 * A composer asked to take the keyboard (#528) belongs to the session asked for: showing another
 * session withdraws the request, so it never lands later in a session the person has left.
 */
describe('composerFocusFor (#528)', () => {
  it('is kept while the session asked for is shown, and withdrawn when another one is', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('cf-a', sessionInfo('cf-a'))
    mock.sessions.set('cf-b', sessionInfo('cf-b'))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('cf-a')
    useStore.getState().askComposerFocus('cf-a')
    useStore.getState().focusSession('cf-a')
    expect(useStore.getState().composerFocusFor).toBe('cf-a')
    useStore.getState().focusSession('cf-b')
    expect(useStore.getState().composerFocusFor).toBeNull()
    useStore.getState().askComposerFocus('cf-b')
    useStore.getState().focusSession(null)
    expect(useStore.getState().composerFocusFor).toBeNull()
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

describe('a project git count the host could not read (#850 review of item 10)', () => {
  it('keeps the last count instead of reading as no changes, and takes a known one again', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const project = { id: 'git-unknown', path: '/tmp/git-unknown', name: 'git-unknown', git: { branch: 'main', changedFiles: 3, isRepo: true } }
    useStore.setState((s) => ({ projects: { ...s.projects, [project.id]: project as never } }))
    const answer = vi.spyOn(mock.projects, 'gitStatus')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      answer.mockResolvedValueOnce({ ...project, git: { branch: '', changedFiles: 0, isRepo: true, unknown: true } } as never)
      useStore.getState().refreshProjectGit(project.id)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(useStore.getState().projects[project.id]!.git).toEqual(project.git)

      answer.mockResolvedValueOnce({ ...project, git: { branch: 'main', changedFiles: 10_000, isRepo: true, more: true } } as never)
      useStore.getState().refreshProjectGit(project.id)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(useStore.getState().projects[project.id]!.git).toEqual({ branch: 'main', changedFiles: 10_000, isRepo: true, more: true })
    } finally {
      vi.useRealTimers()
    }
  })
})

/*
 * A failed save puts back only what it changed (#842 item 3). The rollbacks used to put back the whole map from before
 * the save, so whatever happened while the save was out was lost with it.
 */
describe('a failed reorder or command save puts back only what it changed (#842 item 3)', () => {
  /** A promise this test settles by hand */
  function held() {
    let fail!: (e: Error) => void
    const p = new Promise<never>((_, reject) => (fail = reject))
    return { p, fail }
  }

  it('a failed session reorder keeps a session created and a state changed while it was out', async () => {
    const platform = new MockPlatform()
    const save = held()
    vi.spyOn(platform.agents, 'reorderSessions').mockReturnValue(save.p)
    useStore.setState({
      platform,
      sessions: { a: sessionInfo('a') as never, b: sessionInfo('b') as never },
    })

    const reordering = useStore.getState().reorderSessions('p1', ['b', 'a'])
    expect(Object.keys(useStore.getState().sessions)).toEqual(['b', 'a'])
    // While the save is out: a new session arrives, and one already listed starts working
    useStore.setState((st) => ({
      sessions: { ...st.sessions, a: { ...st.sessions.a!, state: 'working' }, c: sessionInfo('c') as never },
    }))
    save.fail(new Error('offline'))
    await reordering

    const st = useStore.getState()
    expect(Object.keys(st.sessions)).toEqual(['a', 'b', 'c'])
    expect(st.sessions.a!.state).toBe('working')
    expect(st.toast).toContain('offline')
  })

  it('a failed session reorder does not undo a later reorder that the host kept', async () => {
    const platform = new MockPlatform()
    const first = held()
    const spy = vi.spyOn(platform.agents, 'reorderSessions').mockReturnValueOnce(first.p).mockResolvedValueOnce(undefined as never)
    useStore.setState({ platform, sessions: { a: sessionInfo('a') as never, b: sessionInfo('b') as never, c: sessionInfo('c') as never } })

    const failing = useStore.getState().reorderSessions('p1', ['b', 'a', 'c'])
    await useStore.getState().reorderSessions('p1', ['c', 'b', 'a'])
    first.fail(new Error('offline'))
    await failing

    expect(spy).toHaveBeenCalledTimes(2)
    expect(Object.keys(useStore.getState().sessions)).toEqual(['c', 'b', 'a'])
  })

  it('a failed project reorder does not bring back a project deleted while it was out', async () => {
    const platform = new MockPlatform()
    const save = held()
    vi.spyOn(platform.projects, 'reorder').mockReturnValue(save.p)
    const project = (id: string) => ({ id, path: `/tmp/${id}`, name: id, commands: [] }) as never
    useStore.setState({ platform, projects: { p1: project('p1'), p2: project('p2'), p3: project('p3') } })

    const reordering = useStore.getState().reorderProjects(['p3', 'p2', 'p1'])
    useStore.setState((st) => ({ projects: omitKey(st.projects, 'p2') }))
    save.fail(new Error('offline'))
    await reordering

    expect(Object.keys(useStore.getState().projects)).toEqual(['p1', 'p3'])
  })

  it('a failed project reorder does not undo a later reorder that the host kept', async () => {
    const platform = new MockPlatform()
    const first = held()
    const project = (id: string) => ({ id, path: `/tmp/${id}`, name: id, commands: [] }) as never
    const spy = vi
      .spyOn(platform.projects, 'reorder')
      .mockReturnValueOnce(first.p)
      .mockResolvedValueOnce([project('p3'), project('p2'), project('p1')] as never)
    useStore.setState({ platform, projects: { p1: project('p1'), p2: project('p2'), p3: project('p3') } })

    const failing = useStore.getState().reorderProjects(['p2', 'p1', 'p3'])
    await useStore.getState().reorderProjects(['p3', 'p2', 'p1'])
    first.fail(new Error('offline'))
    await failing

    expect(spy).toHaveBeenCalledTimes(2)
    expect(Object.keys(useStore.getState().projects)).toEqual(['p3', 'p2', 'p1'])
    expect(useStore.getState().toast).toContain('offline')
  })

  it('a failed command save puts back the list and keeps a rename made while it was out', async () => {
    const platform = new MockPlatform()
    const p = await platform.projects.add('/tmp/cmds')
    await useStore.getState().attach(platform)
    const save = held()
    vi.spyOn(platform.projects, 'setCommands').mockReturnValue(save.p)

    const saving = useStore.getState().setProjectCommands(p.id, [{ command: 'pnpm dev' }])
    expect(useStore.getState().projects[p.id]?.commands).toEqual([{ command: 'pnpm dev' }])
    useStore.setState((st) => ({ projects: { ...st.projects, [p.id]: { ...st.projects[p.id]!, name: 'renamed' } } }))
    save.fail(new Error('disk full'))
    await saving

    expect(useStore.getState().projects[p.id]).toMatchObject({ name: 'renamed', commands: [] })
    expect(useStore.getState().toast).toContain('disk full')
  })

  it('a failed command save does not bring back a project removed while it was out', async () => {
    const platform = new MockPlatform()
    const p = await platform.projects.add('/tmp/cmds-gone')
    await useStore.getState().attach(platform)
    const save = held()
    vi.spyOn(platform.projects, 'setCommands').mockReturnValue(save.p)

    const saving = useStore.getState().setProjectCommands(p.id, [{ command: 'pnpm dev' }])
    useStore.setState((st) => ({ projects: omitKey(st.projects, p.id) }))
    save.fail(new Error('disk full'))
    await saving

    expect(useStore.getState().projects[p.id]).toBeUndefined()
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
