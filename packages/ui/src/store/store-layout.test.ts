/**
 * Store tests: the sidebar, screens, the workspace snapshot and navigation. Ports go through `MockPlatform`.
 * The `pendingEvents` pen is module state that tests cannot clear, so each test uses its own session id.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { notifyPolicyOf, type ExternalAppInfo } from '@cc/protocol'
import { DEFAULT_NOTIFY_POLICY, arrangePanels, withOrder, withPanel, type NotifyPolicy } from '@cc/core'
// eslint-disable-next-line no-restricted-imports -- the runtime ui knows only ports, but tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import { projectScreenSessions, projectScreenAppKeys, useStore } from './store.js'
import { appInfo, resetStore, sessionInfo } from './store.test-helpers.js'

beforeEach(resetStore)

/*
 * The folded keys live in `prefs.foldedGroups`: saved through `prefs.save`, back on attach. A pick unfolds its
 * session, except where `reveal: false` says the session is already on screen.
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

  it('picking a child started on another machine opens its own project, and leaves its parent’s project and children folded', async () => {
    const mock = new MockPlatform()
    const hub = await mock.projects.add('/tmp/group-hub')
    mock.sessions.set('g-hub-parent', sessionInfo('g-hub-parent', { projectId: hub.id }))
    mock.sessions.set('m1.g-far', sessionInfo('m1.g-far', { projectId: 'm1.p-far', machine: 'm1', askedBy: 'g-hub-parent' } as never))
    await useStore.getState().attach(mock)
    useStore.setState({ foldedProjects: [hub.id, 'm1.p-far'] })
    useStore.getState().setGroupsFolded(['session:g-hub-parent'], true)

    useStore.getState().focusSession('m1.g-far')

    expect(useStore.getState().foldedProjects).toEqual([hub.id])
    expect(folded()).toEqual(['session:g-hub-parent'])
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
 * A fold is kept per project in the workspace snapshot. A picked session must be shown, so every door that picks one
 * unfolds its project, and that is saved too; only restoring a snapshot and clicking a grid panel never unfold.
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

    // Reopening the app: the same snapshot, fed to a store reset to the default (nothing folded)
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

  // The file tree's trash refuses the project folder (#838 review)
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

// Kept per project in the workspace snapshot; restored once the availability catalogs have loaded.
describe('project screen arrangement (#203)', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const stored = (mock: MockPlatform) =>
    (mock.workspaceSnapshot as { projectPanels?: Record<string, unknown> } | null)?.projectPanels

  it('is written to the snapshot per project and read back on the next launch', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/arr-a')
    const b = await mock.projects.add('/tmp/arr-b')
    await useStore.getState().attach(mock)

    useStore.getState().arrangeProject(a.id, { panels: ['session:x', 'session:y'] })
    await tick()
    expect(stored(mock)).toEqual({ [a.id]: { panels: ['session:x', 'session:y'] } })
    expect(stored(mock)?.[b.id]).toBeUndefined()

    useStore.setState({ projectPanels: {} })
    await useStore.getState().attach(mock)
    expect(useStore.getState().projectPanels).toEqual({ [a.id]: { panels: ['session:x', 'session:y'] } })
  })

  it('no save made while restoring writes an empty arrangement over the stored one', async () => {
    const mock = new MockPlatform()
    const a = await mock.projects.add('/tmp/arr-restore')
    mock.sessions.set('arr-r1', sessionInfo('arr-r1', { projectId: a.id }))
    const saved = { [a.id]: { panels: ['session:arr-r1'] } }
    mock.workspaceSnapshot = { focusedSessionId: 'arr-r1', projectPanels: saved } as never
    // Saves are held off for the whole restore (`restoringWorkspace`), so a crash right after it finds the
    // stored arrangement unchanged.
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

  it.each(['reorder', 'add', 'remove'])(
    '%s edits retain unavailable app panels in the snapshot and draw them when discovery recovers',
    async (edit) => {
      const mock = new MockPlatform()
      const project = await mock.projects.add(`/tmp/arr-offline-edit-${edit}`)
      for (const id of ['a', 'b', 'c']) mock.sessions.set(id, sessionInfo(id, { projectId: project.id }))
      const saved = { panels: ['session:a', 'app:offline', 'session:b'] }
      mock.workspaceSnapshot = { projectPanels: { [project.id]: saved } } as never
      await useStore.getState().attach(mock)
      const present = ['session:a', 'session:b', 'session:c']
      const next = edit === 'reorder' ? withOrder(present, saved, ['session:b', 'session:a'])
        : withPanel(present, saved, edit === 'add' ? 'session:c' : 'session:a', edit === 'add')
      const expected = edit === 'reorder' ? ['session:b', 'app:offline', 'session:a']
        : edit === 'add' ? ['session:a', 'app:offline', 'session:b', 'session:c'] : ['app:offline', 'session:b']
      useStore.getState().arrangeProject(project.id, next)
      await tick()
      expect(stored(mock)?.[project.id]).toEqual({ panels: expected })
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
    useStore.getState().arrangeProject(project.id, { panels: ['session:kept', 'app:offline', 'session:deleted'] })
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
    useStore.getState().arrangeProject(a.id, { panels: ['session:x'] })
    useStore.getState().arrangeProject(b.id, { panels: ['session:y'] })

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
      projectPanels: { p1: { panels: ['session:s1'] } },
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

describe('the workspace snapshot has a single writer (U7)', () => {
  it('changing the notify policy writes it to the host, not to the workspace snapshot, and a layout save leaves it there', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)

    const policy: NotifyPolicy = { ...DEFAULT_NOTIFY_POLICY, sound: !DEFAULT_NOTIFY_POLICY.sound }
    useStore.getState().setNotifyPolicy(policy)
    await new Promise((r) => setTimeout(r, 0))
    expect(mock.uiPrefs.notifyPolicy).toEqual(policy)

    useStore.getState().setShowIgnored(false)
    await new Promise((r) => setTimeout(r, 0))
    const snap = mock.workspaceSnapshot as { notifyPolicy?: NotifyPolicy; showIgnored?: boolean } | null
    expect(snap?.notifyPolicy).toBeUndefined()
    expect(snap?.showIgnored).toBe(false)
    expect(notifyPolicyOf(useStore.getState().prefs)).toEqual(policy)
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

  it('the text size is a preference and is not written into the snapshot', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)

    await useStore.getState().setPrefs({ textSize: 1.2 })
    // Any number lands on the nearest of the five steps
    expect(useStore.getState().prefs.textSize).toBe(1.25)
    useStore.getState().setShowIgnored(false)
    await new Promise((r) => setTimeout(r, 0))
    expect(mock.workspaceSnapshot).not.toHaveProperty('textSize')
  })

  // The store keeps it, not the component, which leaving the git tab would reset (#17). On is the default,
  // so off is the choice a person makes and the one that has to survive a relaunch.
  it('hiding ignored files survives the next run — a way of viewing belongs to the person', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('si-s1', sessionInfo('si-s1'))
    await useStore.getState().attach(mock)
    useStore.getState().focusSession('si-s1')

    useStore.getState().setShowIgnored(false)
    await new Promise((r) => setTimeout(r, 0))
    expect((mock.workspaceSnapshot as { showIgnored?: boolean } | null)?.showIgnored).toBe(false)

    // Reopening the app: the same snapshot, fed to a store reset to the default
    useStore.setState({ showIgnored: true })
    await useStore.getState().attach(mock)

    expect(useStore.getState().showIgnored).toBe(false)
  })

  // Only a `typeof` read tells an absent field from a stored `false`: read as `?? false`, every older
  // snapshot would claim someone turned it off.
  it('a setting absent from the snapshot is left at its default — never having chosen is different from having turned it off', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('si-s2', sessionInfo('si-s2'))
    // A snapshot from before this setting existed: it has layout, but no opinion on this
    mock.workspaceSnapshot = { focusedSessionId: 'si-s2', panelOpen: true }

    // Just opened: the default (on)
    useStore.setState({ showIgnored: true })
    await useStore.getState().attach(mock)

    expect(useStore.getState().showIgnored).toBe(true)
  })
})

// The view comes back with the session. `focusSession` forces `view` to `focus`, so the view is restored after it.
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

  // #2133: builds before the rename saved the view as 'orchestrator'
  it.each(['assistant', 'orchestrator'])('a workspace saved with view %s reopens the Assistant screen', async (view) => {
    const mock = new MockPlatform()
    mock.workspaceSnapshot = { view }

    await useStore.getState().attach(mock)
    expect(useStore.getState().view).toBe('assistant')
  })

  // docs/state-management.md §5: a screen that cannot come back opens the Assistant (owner, #2220)
  it('a focused session that is gone opens the Assistant, saved as the screen', async () => {
    const mock = new MockPlatform()
    mock.workspaceSnapshot = { focusedSessionId: 'vw-gone', view: 'focus' }

    await useStore.getState().attach(mock)
    await new Promise((r) => setTimeout(r, 0))

    expect(useStore.getState()).toMatchObject({ view: 'assistant', focusedSessionId: null })
    expect(useStore.getState().workspaceReady).toBe(true)
    expect(mock.workspaceSnapshot).toMatchObject({ view: 'assistant' })

    // The grid does not need the session it last focused: it stays the grid
    mock.workspaceSnapshot = { focusedSessionId: 'vw-gone', view: 'grid' }
    await useStore.getState().attach(mock)
    expect(useStore.getState().view).toBe('grid')
  })

  it('a snapshot that cannot be read opens the Assistant, but not over the intro of a window with nothing yet', async () => {
    const mock = new MockPlatform()
    const prefs = await mock.prefs.load()
    mock.prefs.load = async () => prefs
    mock.workspace.load = async () => {
      throw Object.assign(new Error('RPC timed out: workspace.load'), { code: 'timeout', retryable: true })
    }

    await useStore.getState().attach(mock)

    expect(useStore.getState().view).toBe('assistant')

    // A first launch has nothing to come back to: the intro stands, and the person has not passed it
    useStore.setState({ view: 'focus', introSeen: false, projects: {}, sessions: {} })
    const fresh = new MockPlatform()
    fresh.prefs.load = async () => prefs
    fresh.workspace.load = mock.workspace.load
    await useStore.getState().attach(fresh)
    expect(useStore.getState()).toMatchObject({ view: 'focus', introSeen: false })
  })

  it('an unknown view name is ignored — a snapshot is just a file', async () => {
    const mock = new MockPlatform()
    mock.workspaceSnapshot = { view: 'hologram' }

    await useStore.getState().attach(mock)
    expect(useStore.getState().view).toBe('focus')
  })
})

/*
 * Every setter the restore goes through saves, so a save midway (`restoringWorkspace`) would write the defaults of the
 * fields restored later over the snapshot. The last one restored, `showIgnored`, shows it.
 */
describe('restoring the workspace saves nothing until it is done', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const lateFields = { showIgnored: false }

  it('settings turned off stay off across two launches, even the ones restored last', async () => {
    const mock = new MockPlatform()
    const p = await mock.projects.add('/tmp/restore-late')
    mock.sessions.set('late-r1', sessionInfo('late-r1', { projectId: p.id }))
    mock.workspaceSnapshot = {
      focusedSessionId: 'late-r1',
      panelWidth: 300,
      sidebarWidth: 240,
      railWidth: 300,
      ...lateFields,
    } as never

    // A launch starts from the defaults, which have it on
    useStore.setState({ showIgnored: true })
    await useStore.getState().attach(mock)
    await tick()
    expect(useStore.getState()).toMatchObject(lateFields)
    // What the host keeps is what the next launch reads
    expect(mock.workspaceSnapshot).toMatchObject(lateFields)

    useStore.setState({ showIgnored: true })
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
    expect(notifyPolicyOf(useStore.getState().prefs)).toEqual({ approval: false, error: true, done: true, allDone: true, whenFocused: false, sound: true })
  })

  // An older build reading the snapshot without `railWidth` falls back to its own default width.
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

    useStore.setState({ showIgnored: true })
    await useStore.getState().attach(mock)
    await tick()

    expect(useStore.getState()).toMatchObject({ focusedSessionId: 'rail-r1', panelWidth: 333, sidebarWidth: 251, ...lateFields })
    expect(notifyPolicyOf(useStore.getState().prefs)).toEqual(policy)
    expect(useStore.getState()).not.toHaveProperty('railWidth')

    useStore.getState().setShowIgnored(true)
    await tick()
    expect(mock.workspaceSnapshot).toMatchObject({ panelWidth: 333, sidebarWidth: 251, showIgnored: true })
    expect(mock.workspaceSnapshot).not.toHaveProperty('railWidth')
  })

  // Nothing reads them; an older build reading the snapshot without them falls back to its default (on).
  it('an old snapshot that still carries the spin switches loads in full, and the next save drops them (#736)', async () => {
    const mock = new MockPlatform()
    mock.workspaceSnapshot = { panelWidth: 333, spinGrid: false, spinSessionIcon: false, showIgnored: false } as never
    await useStore.getState().attach(mock)
    await tick()
    expect(useStore.getState()).toMatchObject({ panelWidth: 333, showIgnored: false })
    expect(useStore.getState()).not.toHaveProperty('spinGrid')
    expect(useStore.getState()).not.toHaveProperty('spinSessionIcon')

    useStore.getState().setShowIgnored(true)
    await tick()
    expect(mock.workspaceSnapshot).toMatchObject({ panelWidth: 333, showIgnored: true })
    expect(mock.workspaceSnapshot).not.toHaveProperty('spinGrid')
    expect(mock.workspaceSnapshot).not.toHaveProperty('spinSessionIcon')
  })

  // docs/state-management.md §5: the stored snapshot is unread from the start of `attach` (#2220)
  it('a save made while attach is still reading its lists does not write over the stored snapshot (#2220)', async () => {
    const mock = new MockPlatform()
    const p = await mock.projects.add('/tmp/restore-lists')
    await mock.workspace.save({ focusedSessionId: null, view: 'grid', foldedProjects: [p.id], sidebarWidth: 301 } as never)
    const list = mock.apps.list.bind(mock.apps)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let reading!: () => void
    const started = new Promise<void>((r) => (reading = r))
    mock.apps.list = async () => {
      reading()
      await held
      return list()
    }
    useStore.setState({ foldedProjects: [], view: 'focus' })

    const attaching = useStore.getState().attach(mock)
    await started
    useStore.getState().saveWorkspace()
    await tick()
    release()
    await attaching
    await tick()

    expect(useStore.getState()).toMatchObject({ foldedProjects: [p.id], view: 'grid', sidebarWidth: 301 })
    expect(mock.workspaceSnapshot).toMatchObject({ foldedProjects: [p.id], view: 'grid', sidebarWidth: 301 })
  })

  // `connected` arrives while the lists are read, and a reconnect reads an unread snapshot again (`readWorkspaceAgain`).
  // Beside the attach's own read, it would lay the snapshot without its screen and let a screenless save through.
  it('the host connecting while attach reads its lists does not start a second read of the snapshot (#2220)', async () => {
    const mock = new MockPlatform()
    const p = await mock.projects.add('/tmp/restore-connect')
    mock.sessions.set('rc-s1', sessionInfo('rc-s1', { projectId: p.id }))
    await mock.workspace.save({ focusedSessionId: 'rc-s1', view: 'grid', foldedProjects: [p.id] } as never)
    const list = mock.apps.list.bind(mock.apps)
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let reading!: () => void
    const started = new Promise<void>((r) => (reading = r))
    mock.apps.list = async () => {
      reading()
      await held
      return list()
    }
    useStore.setState({ foldedProjects: [], view: 'focus', focusedSessionId: null })

    const attaching = useStore.getState().attach(mock)
    await started
    mock.setConnectionState('connected')
    await tick()
    useStore.getState().saveWorkspace()
    await tick()
    release()
    await attaching
    await tick()

    expect(useStore.getState()).toMatchObject({ focusedSessionId: 'rc-s1', view: 'grid', foldedProjects: [p.id] })
    expect(mock.workspaceSnapshot).toMatchObject({ focusedSessionId: 'rc-s1', view: 'grid', foldedProjects: [p.id] })
  })

  it('a change the person makes after the restore is still saved', async () => {
    const mock = new MockPlatform()
    mock.workspaceSnapshot = { ...lateFields } as never
    await useStore.getState().attach(mock)
    await tick()

    useStore.getState().setShowIgnored(true)
    await tick()
    expect(mock.workspaceSnapshot).toMatchObject({ showIgnored: true })
  })
})

// docs/state-management.md §5: a snapshot that could not be read is said, and not saved over until read (#384)
describe('a workspace snapshot that could not be read', () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const stored = { view: 'focus', foldedProjects: ['kept-fold'], showIgnored: true, introSeen: true, sidebarWidth: 300 }

  it('is said, and a change made meanwhile is not saved over it', async () => {
    const mock = new MockPlatform()
    await mock.workspace.save(stored)
    const load = mock.workspace.load
    // The mock's preferences read the snapshot too (an old text size); only the snapshot's own read fails here
    const prefs = await mock.prefs.load()
    mock.prefs.load = async () => prefs
    mock.workspace.load = async () => {
      throw Object.assign(new Error('RPC timed out: workspace.load'), { code: 'timeout', retryable: true })
    }
    await useStore.getState().attach(mock)
    await tick()
    expect(useStore.getState().toast).toContain('Could not read the window layout')

    useStore.getState().toggleProjectFold('new-fold')
    await tick()
    expect(mock.workspaceSnapshot).toEqual(stored)

    // Read on the next attach, it is restored and saved as usual again
    mock.workspace.load = load
    await useStore.getState().attach(mock)
    await tick()
    expect(useStore.getState().foldedProjects).toEqual(['kept-fold'])
    useStore.getState().toggleProjectFold('after-read')
    await tick()
    expect((mock.workspaceSnapshot as { foldedProjects?: string[] }).foldedProjects).toEqual(['kept-fold', 'after-read'])
  })

  /** A window attached to a mock whose snapshot read fails `times` times, then reads as usual */
  async function failedFirstRead(times: number) {
    const mock = new MockPlatform()
    await mock.workspace.save(stored)
    const load = mock.workspace.load
    const prefs = await mock.prefs.load()
    mock.prefs.load = async () => prefs
    let failures = 0
    mock.workspace.load = async () => {
      if (failures < times) {
        failures++
        throw Object.assign(new Error('RPC timed out: workspace.load'), { code: 'timeout', retryable: true })
      }
      return load()
    }
    await useStore.getState().attach(mock)
    await vi.advanceTimersByTimeAsync(0)
    return { mock, failures: () => failures }
  }
  const folds = (mock: MockPlatform) => (mock.workspaceSnapshot as { foldedProjects?: string[] }).foldedProjects

  // attach runs once per window: a reconnect is the window's next chance to read it, and a timer the one after
  it('is read again on a reconnect, brought back, and saved as usual from then on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { mock } = await failedFirstRead(1)
      expect(useStore.getState().foldedProjects).toEqual([])
      mock.setConnectionState('disconnected')
      mock.setConnectionState('connected')
      await vi.advanceTimersByTimeAsync(0)
      expect(useStore.getState()).toMatchObject({ foldedProjects: ['kept-fold'], showIgnored: true, introSeen: true })
      useStore.getState().toggleProjectFold('after-reconnect')
      await vi.advanceTimersByTimeAsync(0)
      expect(folds(mock)).toEqual(['kept-fold', 'after-reconnect'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('is read again on a timer while connected, and saved as usual once read', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { mock } = await failedFirstRead(2)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(useStore.getState().foldedProjects).toEqual([])
      await vi.advanceTimersByTimeAsync(5_000)
      expect(useStore.getState().foldedProjects).toEqual(['kept-fold'])
      useStore.getState().toggleProjectFold('after-retry')
      await vi.advanceTimersByTimeAsync(0)
      expect(folds(mock)).toEqual(['kept-fold', 'after-retry'])
    } finally {
      vi.useRealTimers()
    }
  })

  // Otherwise a row that never reads stops saving for good
  it('that never reads is saved over with what the window holds, said once, after the last try', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { mock, failures } = await failedFirstRead(Infinity)
      useStore.getState().toggleProjectFold('kept-meanwhile')
      await vi.advanceTimersByTimeAsync(1_000 + 5_000)
      expect(mock.workspaceSnapshot).toEqual(stored)
      useStore.setState({ toast: null })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(failures()).toBe(4)
      expect(useStore.getState().toast).toBe('Could not read the window layout after 4 tries; the one on screen is saved in its place')
      expect(folds(mock)).toEqual(['kept-meanwhile'])
      await vi.advanceTimersByTimeAsync(120_000)
      expect(failures()).toBe(4)
    } finally {
      vi.useRealTimers()
    }
  })

  // The steps are the window's, not a reconnect's: a reconnect reads at once and the count goes on where it was
  it('goes on up the same steps after a reconnect: four tries in all, then the give-up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { mock, failures } = await failedFirstRead(Infinity)
      await vi.advanceTimersByTimeAsync(1_000)
      expect(failures()).toBe(2)
      mock.setConnectionState('disconnected')
      mock.setConnectionState('connected')
      await vi.advanceTimersByTimeAsync(0)
      expect(failures()).toBe(3)
      useStore.setState({ toast: null })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(failures()).toBe(4)
      expect(useStore.getState().toast).toBe('Could not read the window layout after 4 tries; the one on screen is saved in its place')
    } finally {
      vi.useRealTimers()
    }
  })

  it('that reads but cannot be restored is tried again, and saved over after the last try', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const { mock } = await failedFirstRead(1)
      let restores = 0
      useStore.setState({
        setSidebarWidth: () => {
          restores++
          throw new Error('the restore threw partway')
        },
      })
      await vi.advanceTimersByTimeAsync(1_000 + 5_000 + 30_000)
      expect(restores).toBe(3)
      expect(useStore.getState().toast).toBe('Could not read the window layout after 4 tries; the one on screen is saved in its place')
      useStore.getState().toggleProjectFold('after-giving-up')
      await vi.advanceTimersByTimeAsync(0)
      expect(folds(mock)).toEqual(['kept-fold', 'after-giving-up'])
    } finally {
      vi.useRealTimers()
    }
  })
})

// `workspaceSave`: a machine frozen for hours times out every save, and a dropped save loses every fold made meanwhile.
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

  // #841 item 9: silent, the layout is found lost after a restart
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

  // The steps count on across a newer save: a person who keeps moving panes is told as soon as the retries are spent
  it('says so after the same number of tries when a newer save arrives during a wait', async () => {
    const mock = await attached()
    const { calls } = failSaves(mock, 100)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      useStore.setState({ toast: null })
      useStore.getState().toggleProjectFold('steps-a')
      await vi.advanceTimersByTimeAsync(500)
      useStore.getState().toggleProjectFold('steps-b') // goes at once, on the second step
      await vi.advanceTimersByTimeAsync(0)
      expect(calls()).toBe(2)
      await vi.advanceTimersByTimeAsync(5_000 + 29_000)
      expect(useStore.getState().toast).toBeNull()
      await vi.advanceTimersByTimeAsync(1_000)
      expect(calls()).toBe(4)
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

// One subscriber records every screen change (docs/state-management.md §5a), so these go through the store's
// ordinary doors and read what is on screen after each step.
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

  // Owner, 2026-10-18: back closes them onto the screen under them, forward opens them again, closing one
  // (Esc, its close button) is a step back, and going to another screen closes them.
  describe('a file or the git screen as a page', () => {
    const page = () => ({ overlay: st().overlay?.kind ?? null, viewerPath: st().viewerPath, view: st().view, session: st().focusedSessionId })
    // Each from an empty history: the store is one module for the file, and resetStore leaves `nav` as it was
    beforeEach(() => useStore.setState({ nav: { entries: [], index: -1 }, overlay: null }))

    it('back closes a file onto the session it was opened from, and forward opens it again', async () => {
      await live()
      st().focusSession('nav-a')
      st().openFile('src/a.ts', 'p1')
      expect(page()).toMatchObject({ overlay: 'viewer', viewerPath: 'src/a.ts', session: 'nav-a' })
      expect(st().nav.entries.map((e) => e.kind)).toEqual(['session', 'file'])

      st().goBack()
      expect(page()).toMatchObject({ overlay: null, view: 'focus', session: 'nav-a' })
      st().goForward()
      expect(page()).toMatchObject({ overlay: 'viewer', viewerPath: 'src/a.ts', session: 'nav-a' })
    })

    it('back closes the git screen onto the session it was opened from, and forward opens it again', async () => {
      await live()
      st().focusSession('nav-b')
      st().openGit()
      expect(page()).toMatchObject({ overlay: 'git', session: 'nav-b' })

      st().goBack()
      expect(page()).toMatchObject({ overlay: null, session: 'nav-b' })
      st().goForward()
      expect(page()).toMatchObject({ overlay: 'git', session: 'nav-b' })
    })

    it('closing a page (Esc) is a step back, so forward opens it again and nothing is recorded twice', async () => {
      await live()
      st().focusSession('nav-a')
      st().openFile('src/b.ts', 'p1')
      st().closeOverlay()
      expect(st().nav).toMatchObject({ index: 0 })
      expect(st().nav.entries.map((e) => e.kind)).toEqual(['session', 'file'])
      st().goForward()
      expect(page()).toMatchObject({ overlay: 'viewer', viewerPath: 'src/b.ts' })
    })

    it('going to the grid closes a page, and back returns to it over its session', async () => {
      await live()
      st().focusSession('nav-c')
      st().openGit()
      st().setView('grid')
      expect(page()).toMatchObject({ overlay: null, view: 'grid' })

      st().goBack()
      expect(page()).toMatchObject({ overlay: 'git', view: 'focus', session: 'nav-c' })
    })
  })

  it('starts after a restart at the restored screen, not at the steps the restore took', async () => {
    const mock = await live()
    mock.workspaceSnapshot = { focusedSessionId: 'nav-a', view: 'grid' } as never
    await st().attach(mock)
    expect(st().nav).toEqual({ entries: [{ kind: 'grid' }], index: 0 })
  })
})
