/**
 * Store regression tests: the sidebar, screens, the workspace snapshot and navigation.
 *
 * Ports go through `MockPlatform` (no ad-hoc mocking, or the contract falls apart). The
 * `pendingEvents` holding pen is module state, so it cannot be cleared between tests — each test
 * uses a different session id instead. Shared fixtures are in store.test-helpers.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalAppInfo } from '@cc/protocol'
import { DEFAULT_NOTIFY_POLICY, arrangePanels, withOrder, withPanel, type NotifyPolicy } from '@cc/core'
// eslint-disable-next-line no-restricted-imports -- the runtime ui knows only ports, but tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import { projectScreenSessions, projectScreenAppKeys, useStore } from './store.js'
import { appInfo, resetStore, sessionInfo } from './store.test-helpers.js'

beforeEach(resetStore)

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

  /*
   * A file and the git screen are pages of their own (owner, 2026-10-18): opened over a screen, back closes them onto
   * it, forward opens them again, closing one (Esc, its close button) is a step back, and going to another screen
   * closes them.
   */
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
