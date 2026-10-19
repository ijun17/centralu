/**
 * Store regression tests: projects, their trust, defaults and saves.
 *
 * Ports go through `MockPlatform` (no ad-hoc mocking, or the contract falls apart). The
 * `pendingEvents` holding pen is module state, so it cannot be cleared between tests — each test
 * uses a different session id instead. Shared fixtures are in store.test-helpers.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
// eslint-disable-next-line no-restricted-imports -- the runtime ui knows only ports, but tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import { useStore } from './store.js'
import { omitKey } from './patch.js'
import { appInfo, resetStore, sessionInfo } from './store.test-helpers.js'

beforeEach(resetStore)

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

  it('a folder the person let the orchestrator add is asked about once, as one added from the sidebar (#1220)', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    // A project the host only changed, or one already trusted, is not asked about
    const other = await mock.projects.add('/tmp/trust-other')
    useStore.getState().dispatchEvent({ type: 'projects_changed' } as NormalizedEvent)
    const trusted = await mock.projects.add('/tmp/trust-known')
    await mock.projects.setTrusted(trusted.id, true)
    useStore.getState().dispatchEvent({ type: 'projects_changed', added: trusted.id } as NormalizedEvent)
    await useStore.getState().refreshProjects()
    expect(useStore.getState().projects[other.id]).toBeDefined()
    expect(useStore.getState().projects[trusted.id]).toBeDefined()
    expect(useStore.getState().trustAsk).toBeNull()

    // Registered by the host after the person's Allow on the orchestrator's card, not by this window
    const added = await mock.projects.add('/tmp/trust-orchestrator')
    useStore.getState().dispatchEvent({ type: 'projects_changed', added: added.id } as NormalizedEvent)
    await vi.waitFor(() => expect(useStore.getState().trustAsk).toBe(added.id))
    expect(useStore.getState().projects[added.id]?.trusted).toBe(false)
    await useStore.getState().answerTrustAsk(true)
    expect(mock.trustCalls).toEqual([
      { projectId: trusted.id, trusted: true },
      { projectId: added.id, trusted: true },
    ])
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

    // Each write tells the windows itself too, as the host's do: the reads may land one at a time
    await vi.waitFor(() => {
      expect(useStore.getState().projects[p.id]?.trusted).toBe(true)
      expect(useStore.getState().projects[p.id]?.commands).toEqual([{ command: 'pnpm dev' }])
    })
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
