import { describe, expect, it } from 'vitest'
import { RpcMethods } from '@cc/protocol'
import { encodeNumber } from './machine-ids.js'
import { Qualifier } from './qualifier.js'
import { ROUTES } from './routes.js'
import { Router, type RoutedMachine } from './router.js'

/** A linked machine that records what reached it and answers from a table */
class FakeMachine implements RoutedMachine {
  readonly q: Qualifier
  reachable = true
  calls: { method: string; params: unknown }[] = []
  answers: Record<string, unknown> = {}
  mirror: Record<'sessions' | 'projects', unknown[] | null> = { sessions: null, projects: null }
  constructor(
    readonly id: string,
    slot: number,
    readonly name = `Machine ${id}`,
  ) {
    this.q = new Qualifier(id, slot)
  }
  async call(method: string, params: unknown) {
    this.calls.push({ method, params })
    const a = this.answers[method]
    if (a instanceof Error) throw a
    return typeof a === 'function' ? (a as (p: unknown) => unknown)(params) : (a ?? { ok: true })
  }
  lastKnown(kind: 'sessions' | 'projects') {
    return this.mirror[kind]
  }
  observe(kind: 'sessions' | 'projects', list: unknown[]) {
    this.mirror[kind] = list
  }
  hides(s: unknown) {
    const kind = (s as { kind?: string }).kind
    return kind === 'orchestrator' || kind === 'coordinator'
  }
}

function rig() {
  const local: { method: string; params: unknown }[] = []
  const localAnswers: Record<string, unknown> = {}
  const m1 = new FakeMachine('m1', 1)
  const m2 = new FakeMachine('m2', 2)
  const router = new Router({
    local: async (method, params) => {
      local.push({ method, params })
      return localAnswers[method] ?? { ok: true, from: 'hub' }
    },
    machines: () => [m1, m2],
  })
  return { router, local, localAnswers, m1, m2 }
}

const session = (id: string, extra: Record<string, unknown> = {}) => ({ id, projectId: 'p1', kind: 'worker', name: id, live: true, ...extra })

describe('the hub router (docs/plans/remote-hub.md §5)', () => {
  it('classifies every RPC method the protocol has', () => {
    // The table's type already demands it; this catches a method added at runtime only
    expect(Object.keys(ROUTES).sort()).toEqual(Object.keys(RpcMethods).sort())
  })

  it('leaves every call with an unprefixed id, or no id, to the hub exactly as sent', async () => {
    const { router, local, m1 } = rig()
    await router.handle('agents.send', { sessionId: 'abc', text: 'hi' })
    await router.handle('git.status', { projectId: 'p1' })
    await router.handle('terminal.input', { terminalId: 'term-1', data: 'x' })
    await router.handle('agents.models', { tool: 'claude' })
    expect(local).toEqual([
      { method: 'agents.send', params: { sessionId: 'abc', text: 'hi' } },
      { method: 'git.status', params: { projectId: 'p1' } },
      { method: 'terminal.input', params: { terminalId: 'term-1', data: 'x' } },
      { method: 'agents.models', params: { tool: 'claude' } },
    ])
    expect(m1.calls).toEqual([])
  })

  it('an id whose prefix names no linked machine is the hub’s own', async () => {
    const { router, local } = rig()
    await router.handle('agents.send', { sessionId: 'zz.abc', text: 'hi' })
    expect(local[0]!.params).toEqual({ sessionId: 'zz.abc', text: 'hi' })
  })

  it('sends a session-keyed call to the machine the id names, without its prefix, and qualifies the answer', async () => {
    const { router, local, m1, m2 } = rig()
    m1.answers['agents.resumeSession'] = { session: session('s1', { parentSessionId: 's0', projectId: 'p9' }), resumed: true }
    const r = await router.handle('agents.resumeSession', { sessionId: 'm1.s1' })
    expect(m1.calls).toEqual([{ method: 'agents.resumeSession', params: { sessionId: 's1' } }])
    expect(r).toMatchObject({ resumed: true, session: { id: 'm1.s1', projectId: 'm1.p9', parentSessionId: 'm1.s0', machine: 'm1' } })
    expect(local).toEqual([])
    expect(m2.calls).toEqual([])
  })

  it("reads a reply's image on the session's own machine, and keeps that machine's path out of the hub's answer", async () => {
    const { router, local, localAnswers, m1 } = rig()
    m1.answers['messages.image'] = { ok: false, reason: 'too_large', message: 'big', file: '/remote/home/big.png' }
    const remote = await router.handle('messages.image', { sessionId: 'm1.s1', path: '~/big.png' })
    expect(m1.calls).toEqual([{ method: 'messages.image', params: { sessionId: 's1', path: '~/big.png' } }])
    // Without a file there is nothing for "Show in Finder" to open on this computer
    expect(remote).toEqual({ ok: false, reason: 'too_large', message: 'big' })

    localAnswers['messages.image'] = { ok: false, reason: 'too_large', message: 'big', file: '/Users/me/big.png' }
    expect(await router.handle('messages.image', { sessionId: 's1', path: '~/big.png' })).toMatchObject({ file: '/Users/me/big.png' })
    expect(local).toHaveLength(1)
  })

  it('sends a project-keyed call by its project, and a terminal call by its terminal', async () => {
    const { router, m1 } = rig()
    m1.answers['terminal.create'] = { terminalId: 'term-4', cwd: '/srv/app', title: 'zsh', history: '', alive: true }
    const t = await router.handle('terminal.create', { projectId: 'm1.p1', cols: 80, rows: 24 })
    expect(t).toMatchObject({ terminalId: 'm1.term-4' })
    await router.handle('terminal.input', { terminalId: 'm1.term-4', data: 'ls\r' })
    m1.answers['commands.run'] = { command: 'pnpm dev', runId: 'run-2', running: true, exitCode: null, startedAt: 1 }
    expect(await router.handle('commands.run', { projectId: 'm1.p1', command: 'pnpm dev' })).toMatchObject({ runId: 'm1.run-2' })
    expect(m1.calls.map((c) => c.params)).toEqual([
      { projectId: 'p1', cols: 80, rows: 24 },
      { terminalId: 'term-4', data: 'ls\r' },
      { projectId: 'p1', command: 'pnpm dev' },
    ])
  })

  it('a per-machine question goes where `machine` says, and the parameter does not travel', async () => {
    const { router, local, m2 } = rig()
    m2.answers['agents.detect'] = [{ name: 'claude', installed: true }]
    await router.handle('agents.detect', { machine: 'm2' })
    expect(m2.calls).toEqual([{ method: 'agents.detect', params: {} }])
    await router.handle('agents.detect', {})
    expect(local).toEqual([{ method: 'agents.detect', params: {} }])
    m2.answers['projects.add'] = { id: 'p5', path: '/srv/x', name: 'x', worktreeManager: { sessionId: 's9', baseBranch: 'main' } }
    expect(await router.handle('projects.add', { path: '/srv/x', machine: 'm2' })).toMatchObject({
      id: 'm2.p5',
      machine: 'm2',
      worktreeManager: { sessionId: 'm2.s9' },
    })
  })

  it('keeps hub calls on the hub whatever their parameters name', async () => {
    const { router, local, m1 } = rig()
    await router.handle('grid.set', { panels: [{ kind: 'session', sessionId: 'm1.s1' }] })
    await router.handle('prefs.get', {})
    await router.handle('machines.list', {})
    await router.handle('orchestrator.tool', { sessionId: 'm1.s1', name: 'x', args: {} })
    expect(local.map((c) => c.method)).toEqual(['grid.set', 'prefs.get', 'machines.list', 'orchestrator.tool'])
    expect(m1.calls).toEqual([])
  })

  it('refuses a remote project for a path on this computer’s OS, and passes the hub’s own', async () => {
    const { router, local, m1 } = rig()
    await expect(router.handle('fs.resolve', { projectId: 'm1.p1', path: 'a.txt' })).rejects.toThrow(/another machine/)
    await router.handle('fs.resolve', { projectId: 'p1', path: 'a.txt' })
    expect(local).toHaveLength(1)
    expect(m1.calls).toEqual([])
  })

  describe('app views of a linked machine (plan §11)', () => {
    it('opens a remote project app’s pinned view there and hands the window its instance qualified', async () => {
      const { router, local, m1 } = rig()
      m1.answers['apps.openView'] = { instanceId: 'inst-aaaaaaaaaaaaaaaa', tool: 'show', resourceUri: 'ui://board/main', toolInput: {}, toolResult: { content: [] }, runId: 'r1' }
      const r = await router.handle('apps.openView', { appId: 'board', projectId: 'm1.p1' })
      expect(m1.calls).toEqual([{ method: 'apps.openView', params: { appId: 'board', projectId: 'p1' } }])
      expect(r).toMatchObject({ instanceId: 'm1.inst-aaaaaaaaaaaaaaaa', resourceUri: 'ui://board/main' })
      expect(local).toEqual([])
    })

    it('keeps every view address on the hub, which serves a remote one itself', async () => {
      const { router, local, m1 } = rig()
      await router.handle('apps.viewFrame', { appId: 'board', projectId: 'm1.p1', instanceId: 'm1.inst', hostOrigin: 'tauri://localhost' })
      expect(local).toEqual([
        { method: 'apps.viewFrame', params: { appId: 'board', projectId: 'm1.p1', instanceId: 'm1.inst', hostOrigin: 'tauri://localhost' } },
      ])
      expect(m1.calls).toEqual([])
    })

    it('sends a view’s calls to the machine it is open on, every id stripped', async () => {
      const { router, local, m1, m2 } = rig()
      await router.handle('apps.invoke', { appId: 'board', name: 'add', args: { n: 1 }, projectId: 'm1.p1', instanceId: 'm1.inst' })
      await router.handle('apps.readResource', { appId: 'board', projectId: 'm1.p1', uri: 'ui://board/data', instanceId: 'm1.inst' })
      await router.handle('apps.closeView', { instanceId: 'm1.inst' })
      await router.handle('apps.viewMessage', { sessionId: 'm1.s1', instanceId: 'm1.inst', text: 'hi' })
      expect(m1.calls).toEqual([
        { method: 'apps.invoke', params: { appId: 'board', name: 'add', args: { n: 1 }, projectId: 'p1', instanceId: 'inst' } },
        { method: 'apps.readResource', params: { appId: 'board', projectId: 'p1', uri: 'ui://board/data', instanceId: 'inst' } },
        { method: 'apps.closeView', params: { instanceId: 'inst' } },
        { method: 'apps.viewMessage', params: { sessionId: 's1', instanceId: 'inst', text: 'hi' } },
      ])
      expect(local).toEqual([])
      expect(m2.calls).toEqual([])
    })

    it('a remote user-folder app’s view is named by its instance alone, and still reaches its own machine', async () => {
      const { router, local, m2 } = rig()
      // In a conversation on m2: no project to say which machine, so the instance does
      await router.handle('apps.invoke', { appId: 'notes', name: 'add', args: {}, projectId: null, instanceId: 'm2.inst' })
      expect(m2.calls).toEqual([{ method: 'apps.invoke', params: { appId: 'notes', name: 'add', args: {}, projectId: null, instanceId: 'inst' } }])
      expect(local).toEqual([])
    })

    it('the hub’s own views and calls stay on the hub', async () => {
      const { router, local, m1 } = rig()
      await router.handle('apps.invoke', { appId: 'notes', name: 'add', args: {}, projectId: null, instanceId: 'inst' })
      await router.handle('apps.invoke', { appId: 'notes', name: 'add', args: {} })
      await router.handle('apps.closeView', { instanceId: 'inst' })
      expect(local.map((c) => c.method)).toEqual(['apps.invoke', 'apps.invoke', 'apps.closeView'])
      expect(m1.calls).toEqual([])
    })

    it('refuses a view call that names two machines, or a machine and the hub', async () => {
      const { router, local, m1, m2 } = rig()
      // A view on m1 sending to a conversation on this computer, and the reverse
      await expect(router.handle('apps.viewMessage', { sessionId: 'h1', instanceId: 'm1.inst', text: 'hi' })).rejects.toThrow(/only the machine it is open on/)
      await expect(router.handle('apps.viewMessage', { sessionId: 'm1.s1', instanceId: 'inst', text: 'hi' })).rejects.toThrow(/only the machine it is open on/)
      // An instance of m2 claiming an app of m1
      await expect(
        router.handle('apps.invoke', { appId: 'board', name: 'add', args: {}, projectId: 'm1.p1', instanceId: 'm2.inst' }),
      ).rejects.toThrow(/only the machine it is open on/)
      expect(local).toEqual([])
      expect(m1.calls).toEqual([])
      expect(m2.calls).toEqual([])
    })

    it('asks the machine for a view’s document and qualifies the app it names', async () => {
      const { router, m1 } = rig()
      m1.answers['apps.viewDocument'] = { appId: 'board', projectId: 'p1', uri: 'ui://board/main', origin: 'app', resource: { contents: [] } }
      expect(await router.handle('apps.viewDocument', { instanceId: 'm1.inst' })).toEqual({
        appId: 'board',
        projectId: 'm1.p1',
        uri: 'ui://board/main',
        origin: 'app',
        resource: { contents: [] },
      })
      m1.answers['apps.viewDocument'] = { appId: 'notes', projectId: null, uri: 'ui://notes/main', origin: 'opaque', resource: { contents: [] } }
      expect(await router.handle('apps.viewDocument', { instanceId: 'm1.inst2' })).toMatchObject({ projectId: null })
      expect(m1.calls.map((c) => c.params)).toEqual([{ instanceId: 'inst' }, { instanceId: 'inst2' }])
    })

    it('qualifies the instances of a remote conversation’s inline views', async () => {
      const { router, m1 } = rig()
      m1.answers['apps.inlineViews'] = [
        { callId: 'c1', appId: 'board', projectId: 'p1', tool: 'show', kept: true, instanceId: 'inst' },
        { callId: 'c2', appId: 'notes', projectId: null, tool: 'show', kept: false, instanceId: null },
      ]
      expect(await router.handle('apps.inlineViews', { sessionId: 'm1.s1' })).toEqual([
        { callId: 'c1', appId: 'board', projectId: 'm1.p1', tool: 'show', kept: true, instanceId: 'm1.inst' },
        { callId: 'c2', appId: 'notes', projectId: null, tool: 'show', kept: false, instanceId: null },
      ])
      m1.answers['apps.inlineReopen'] = { instanceId: 'inst3', appId: 'board', projectId: 'p1', tool: 'show', toolInput: {} }
      expect(await router.handle('apps.inlineReopen', { sessionId: 'm1.s1', callId: 'c1' })).toMatchObject({ instanceId: 'm1.inst3', projectId: 'm1.p1' })
      expect(m1.calls.at(-1)).toEqual({ method: 'apps.inlineReopen', params: { sessionId: 's1', callId: 'c1' } })
    })

    it('qualifies the view instance in a remote session’s events, so the window opens, calls and closes the right one', () => {
      const q = new Qualifier('m1', 1)
      expect(q.event({ type: 'app_view', sessionId: 's1', callId: 'c1', appId: 'board', projectId: 'p1', tool: 'show', phase: 'open', instanceId: 'inst' })).toMatchObject({
        sessionId: 'm1.s1',
        projectId: 'm1.p1',
        instanceId: 'm1.inst',
      })
      // The view that caused a change is told apart by its instance (B-5): the window holds it qualified
      expect(q.event({ type: 'external_app_state_changed', appId: 'board', projectId: 'p1', cause: { kind: 'view', instanceId: 'inst' } })).toMatchObject({
        projectId: 'm1.p1',
        cause: { kind: 'view', instanceId: 'm1.inst' },
      })
      expect(q.message({ seq: 1, sessionId: 's1', kind: 'app_view', payload: { type: 'app_view', sessionId: 's1', instanceId: 'inst', projectId: null } })).toMatchObject({
        payload: { instanceId: 'm1.inst', projectId: null },
      })
    })
  })

  it('refuses a call that mixes two machines rather than passing a stranger’s id on', async () => {
    const { router, m1 } = rig()
    await expect(router.handle('sessions.reorder', { projectId: 'm1.p1', orderedIds: ['m1.a', 'm2.b'] })).rejects.toThrow(/another machine/)
    await expect(router.handle('apps.reach', { sessionId: 'm1.s', appId: 'x', projectId: 'p-hub' })).rejects.toThrow(/another machine/)
    expect(m1.calls).toEqual([])
  })

  it('a call to an unreachable machine fails at once, says to retry, and names the machine', async () => {
    const { router, m1 } = rig()
    m1.reachable = false
    const err = await router.handle('agents.send', { sessionId: 'm1.s1', text: 'hi' }).catch((e: unknown) => e)
    expect(err).toMatchObject({ code: 'internal', retryable: true, data: { machine: 'm1', reason: 'unreachable' } })
    expect(m1.calls).toEqual([])
  })

  describe('merges', () => {
    it('lists every machine’s sessions after the hub’s own, qualified, without the remote orchestrator and coordinators', async () => {
      const { router, localAnswers, m1, m2 } = rig()
      localAnswers['sessions.list'] = [session('h1')]
      m1.answers['sessions.list'] = [session('a'), session('orch', { kind: 'orchestrator', projectId: null }), session('co', { kind: 'coordinator' })]
      m2.answers['sessions.list'] = [session('b')]
      const list = (await router.handle('sessions.list', {})) as { id: string; machine?: string }[]
      expect(list.map((s) => s.id)).toEqual(['h1', 'm1.a', 'm2.b'])
      // What was read becomes the mirror, the hidden ones included in what the machine itself said
      expect((m1.mirror.sessions as { id: string }[]).map((s) => s.id)).toEqual(['a', 'orch', 'co'])
    })

    it('answers for an unreachable machine from the mirror, marked, with live as last known', async () => {
      const { router, localAnswers, m1 } = rig()
      localAnswers['sessions.list'] = []
      m1.reachable = false
      m1.mirror.sessions = [session('a', { live: true })]
      const list = await router.handle('sessions.list', {})
      expect(list).toEqual([expect.objectContaining({ id: 'm1.a', live: true, unreachable: true, machine: 'm1' })])
    })

    it('falls back to the mirror when the machine fails mid-read', async () => {
      const { router, localAnswers, m1 } = rig()
      localAnswers['projects.list'] = []
      m1.answers['projects.list'] = new Error('dropped')
      m1.mirror.projects = [{ id: 'p1', path: '/srv/p1', name: 'p1' }]
      expect(await router.handle('projects.list', {})).toEqual([expect.objectContaining({ id: 'm1.p1', unreachable: true })])
    })

    it('folds each machine’s approval rule ids apart, and deletes by the folded id on the right machine', async () => {
      const { router, local, localAnswers, m1, m2 } = rig()
      const rule = (id: number) => ({ id, scope: 'project', matcher: 'echo *', decision: 'allow', createdAt: 1, projectId: 'p1', sessionId: null })
      localAnswers['approvals.rules'] = [rule(7)]
      m1.answers['approvals.rules'] = [rule(7)]
      m2.answers['approvals.rules'] = [rule(7)]
      const rules = (await router.handle('approvals.rules', {})) as { id: number; projectId: string }[]
      expect(rules.map((r) => r.id)).toEqual([7, encodeNumber(1, 7), encodeNumber(2, 7)])
      expect(new Set(rules.map((r) => r.id)).size).toBe(3)
      expect(rules[2]!.projectId).toBe('m2.p1')

      await router.handle('approvals.deleteRule', { id: encodeNumber(2, 7) })
      expect(m2.calls.at(-1)).toEqual({ method: 'approvals.deleteRule', params: { id: 7 } })
      await router.handle('approvals.deleteRule', { id: 7 })
      expect(local.at(-1)).toEqual({ method: 'approvals.deleteRule', params: { id: 7 } })
      expect(m1.calls.filter((c) => c.method === 'approvals.deleteRule')).toEqual([])
    })

    it('splits the project order per machine', async () => {
      const { router, local, localAnswers, m1 } = rig()
      localAnswers['projects.reorder'] = [{ id: 'h1' }, { id: 'h2' }]
      m1.answers['projects.reorder'] = [{ id: 'b' }, { id: 'a' }]
      const r = (await router.handle('projects.reorder', { orderedIds: ['m1.b', 'h2', 'm1.a', 'h1'] })) as { id: string }[]
      expect(local.at(-1)!.params).toEqual({ orderedIds: ['h2', 'h1'] })
      expect(m1.calls).toEqual([{ method: 'projects.reorder', params: { orderedIds: ['b', 'a'] } }])
      expect(r.map((p) => p.id)).toEqual(['h1', 'h2', 'm1.b', 'm1.a'])
    })

    it('adds up the trash, and leaves out a machine that fails', async () => {
      const { router, localAnswers, m1, m2 } = rig()
      localAnswers['trash.list'] = { sessions: [{ id: 'h1', project: null }], bytes: 10 }
      m1.answers['trash.list'] = { sessions: [{ id: 'a', project: { id: 'p1', name: 'p', path: '/p', exists: true } }], bytes: 5 }
      m2.answers['trash.list'] = new Error('gone')
      expect(await router.handle('trash.list', {})).toEqual({
        sessions: [{ id: 'h1', project: null }, { id: 'm1.a', project: { id: 'm1.p1', name: 'p', path: '/p', exists: true }, machine: 'm1' }],
        bytes: 15,
      })
    })

    it('search hits name their machine’s sessions', async () => {
      const { router, localAnswers, m1 } = rig()
      localAnswers['messages.search'] = [{ sessionId: 'h1', seq: 1, snippet: 'x' }]
      m1.answers['messages.search'] = [{ sessionId: 'a', seq: 2, snippet: 'y' }]
      expect(await router.handle('messages.search', { query: 'x' })).toEqual([
        { sessionId: 'h1', seq: 1, snippet: 'x' },
        { sessionId: 'm1.a', seq: 2, snippet: 'y' },
      ])
    })
  })
})
