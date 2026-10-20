import { describe, expect, it } from 'vitest'
import { RpcMethods } from '@cc/protocol'
import { encodeNumber } from './machine-ids.js'
import { Qualifier } from './qualifier.js'
import { ROUTES } from './routes.js'
import { Router, keepUnseen, type RoutedMachine } from './router.js'

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

  it('rewrites every answer the way the qualifier does: a field it cannot read passes as it is (#850)', () => {
    const q = new Qualifier('m1', 1)
    const fields = ['terminals', 'runs', 'run', 'restarted', 'busy', 'cache', 'sessions', 'session', 'project', 'app', 'builder', 'sessionId', 'file']
    for (const [method, route] of Object.entries(ROUTES)) {
      const fix = 'result' in route ? route.result : undefined
      if (!fix) continue
      // What another build may send: nothing, a scalar, a list where an object was meant, fields of the wrong kind
      for (const odd of [undefined, null, 1, 'x', [], {}, { cache: { windows: {} } }, Object.fromEntries(fields.map((f) => [f, {}])), Object.fromEntries(fields.map((f) => [f, 1]))]) {
        expect(() => fix(odd, q), `${method} on ${JSON.stringify(odd)}`).not.toThrow()
      }
    }
    // A list read as an object was spread into one (`{ 0: … }`); a missing list was invented as an empty one
    expect(ROUTES['apps.create'].kind === 'project' && ROUTES['apps.create'].result?.([1], q)).toStrictEqual([1])
    expect(ROUTES['trash.restore'].kind === 'session' && ROUTES['trash.restore'].result?.(['x'], q)).toStrictEqual(['x'])
    expect(ROUTES['terminal.list'].kind === 'project' && ROUTES['terminal.list'].result?.({}, q)).toStrictEqual({})
    expect(ROUTES['agents.applyVersions'].kind === 'machine' && ROUTES['agents.applyVersions'].result?.({ restarted: ['s1'] }, q)).toStrictEqual({ restarted: ['m1.s1'] })
    // And what it can read is rewritten as before
    expect(ROUTES['commands.state'].kind === 'project' && ROUTES['commands.state'].result?.({ runs: [{ runId: 'r1' }, 3] }, q)).toStrictEqual({ runs: [{ runId: 'm1.r1' }, 3] })
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

  // #1377: the hub learns the person's choice from the call it routes, not from the machine echoing it
  it("tells the hub of a call to a linked machine's session before it goes, and how it ended", async () => {
    const seen: string[] = []
    const m1 = new FakeMachine('m1', 1)
    const router = new Router({
      local: async () => ({ ok: true }),
      machines: () => [m1],
      forwarding: (method, params) => {
        seen.push(`${method} ${JSON.stringify(params)}`)
        return (delivered) => void seen.push(`ended ${delivered}`)
      },
    })
    await router.handle('agents.send', { sessionId: 'm1.s1', text: 'hi', intent: 'takeover' })
    m1.answers['agents.send'] = new Error('Box is not reachable')
    await router.handle('agents.send', { sessionId: 'm1.s1', text: 'again', intent: 'task' }).catch(() => {})
    // The hub's own sessions are not routed: nothing to tell
    await router.handle('agents.send', { sessionId: 'abc', text: 'mine', intent: 'task' })
    expect(seen).toEqual([
      'agents.send {"sessionId":"m1.s1","text":"hi","intent":"takeover"}',
      'ended true',
      'agents.send {"sessionId":"m1.s1","text":"again","intent":"task"}',
      'ended false',
    ])
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

  it("reads a session's file with the session's id that machine knows, and refuses a session of another (#1209)", async () => {
    const { router, m1 } = rig()
    m1.answers['fs.readFile'] = { text: 'x', truncated: false, binary: false, bytes: 1 }
    await router.handle('fs.readFile', { projectId: 'm1.p1', path: 'a.ts', sessionId: 'm1.s1' })
    await router.handle('fs.readFile', { projectId: 'm1.p1', path: 'a.ts' })
    expect(m1.calls.map((c) => c.params)).toEqual([
      { projectId: 'p1', path: 'a.ts', sessionId: 's1' },
      { projectId: 'p1', path: 'a.ts' },
    ])
    await expect(router.handle('fs.readFile', { projectId: 'm1.p1', path: 'a.ts', sessionId: 's-hub' })).rejects.toThrow(/another machine/)
  })

  it('qualifies the id of the open session a past conversation is already imported as (#701)', async () => {
    const { router, m1 } = rig()
    m1.answers['agents.listExternalSessions'] = {
      supported: true,
      sessions: [
        { externalId: 'tool-1', tool: 'claude', title: 'open', updatedAt: 1, imported: true, importedAs: 'abc' },
        { externalId: 'tool-2', tool: 'claude', title: 'closed', updatedAt: 2, imported: false, importedAs: null },
      ],
    }
    const r = await router.handle('agents.listExternalSessions', { projectId: 'm1.p1', tool: 'claude' })
    expect(m1.calls).toEqual([{ method: 'agents.listExternalSessions', params: { projectId: 'p1', tool: 'claude' } }])
    // The tool's own conversation id stays; only the Centralu session id is the hub's to jump to
    expect(r).toMatchObject({
      sessions: [
        { externalId: 'tool-1', importedAs: 'm1.abc' },
        { externalId: 'tool-2', importedAs: null },
      ],
    })
  })

  it('qualifies the project a declined request names, so the screen can tell its own app from another (apps.errors)', async () => {
    const { router, m1 } = rig()
    const bundle = (denied: unknown) => ({ kind: 'tool', at: 1, message: 'm', stderr: [], tool: 't', args: null, runId: 'run-1', denied, text: 't' })
    const denied = { appId: 'todo', projectId: 'p1', name: 'Todo', capability: 'run_agent', text: 'start an agent' }
    m1.answers['apps.errors'] = { latest: bundle(denied), recent: [bundle(denied), bundle(null)] }
    const r = (await router.handle('apps.errors', { appId: 'todo', projectId: 'm1.p1' })) as {
      latest: { denied: { projectId: string }; runId: string }
      recent: { denied: { projectId: string } | null }[]
    }
    expect(r.latest.denied.projectId).toBe('m1.p1')
    expect(r.latest.runId).toBe('run-1')
    expect(r.recent.map((b) => b.denied?.projectId ?? null)).toEqual(['m1.p1', null])
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

  it("makes a new project on the machine it is for, which names its own ~/Centralu (#515)", async () => {
    const { router, local, m2 } = rig()
    m2.answers['projects.createPreview'] = { parent: 'C:\\Users\\me\\Centralu', path: 'C:\\Users\\me\\Centralu\\game', error: null }
    expect(await router.handle('projects.createPreview', { name: 'game', machine: 'm2' })).toEqual(m2.answers['projects.createPreview'])
    m2.answers['projects.create'] = { id: 'p6', path: 'C:\\Users\\me\\Centralu\\game', name: 'game' }
    expect(await router.handle('projects.create', { name: 'game', machine: 'm2' })).toMatchObject({ id: 'm2.p6', machine: 'm2' })
    expect(m2.calls).toEqual([
      { method: 'projects.createPreview', params: { name: 'game' } },
      { method: 'projects.create', params: { name: 'game' } },
    ])
    // Without a machine it is this computer's
    await router.handle('projects.create', { name: 'here' })
    expect(local).toEqual([{ method: 'projects.create', params: { name: 'here' } }])
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

    it('opens a remote user-folder app’s pinned view on the machine `machine` names, and only there', async () => {
      const { router, local, m1, m2 } = rig()
      m2.answers['apps.openView'] = { instanceId: 'inst-u', tool: 'show', resourceUri: 'ui://notes/main', toolInput: {}, toolResult: { content: [] }, runId: 'r1' }
      expect(await router.handle('apps.openView', { appId: 'notes', projectId: null, machine: 'm2' })).toMatchObject({ instanceId: 'm2.inst-u' })
      // The parameter does not travel: on that machine it is its own app
      expect(m2.calls).toEqual([{ method: 'apps.openView', params: { appId: 'notes', projectId: null } }])
      // Without `machine`, the hub's own user-folder app; with a project, the project names the machine
      await router.handle('apps.openView', { appId: 'notes', projectId: null })
      await router.handle('apps.openView', { appId: 'board', projectId: 'm1.p1', machine: 'm2' })
      expect(local).toEqual([{ method: 'apps.openView', params: { appId: 'notes', projectId: null } }])
      expect(m1.calls).toEqual([{ method: 'apps.openView', params: { appId: 'board', projectId: 'p1' } }])
      await expect(router.handle('apps.openView', { appId: 'notes', projectId: null, machine: 'm9' })).rejects.toThrow(/No linked machine m9/)
    })

    it.each([
      { projectId: 'm1.p1', machine: undefined, appId: 'board', localProject: 'p1' },
      { projectId: null, machine: 'm1', appId: 'notes', localProject: null },
    ])('recovers a keyed view on its own machine without recalling home ($appId)', async ({ projectId, machine, appId, localProject }) => {
      const { router, local, m1 } = rig()
      const openKey = 'aabbccdd-1234-4567-8123-aabbccddeeff'
      m1.answers['apps.recoverView'] = { instanceId: 'inst-aaaaaaaaaaaaaaaa', tool: 'home', resourceUri: 'ui://board/main', toolInput: {}, toolResult: { content: [] }, runId: 'once' }
      expect(await router.handle('apps.recoverView', { appId, projectId, ...(machine ? { machine } : {}), openKey, lease: true }))
        .toMatchObject({ instanceId: 'm1.inst-aaaaaaaaaaaaaaaa', runId: 'once' })
      expect(m1.calls).toEqual([{ method: 'apps.recoverView', params: { appId, projectId: localProject, openKey } }])
      expect(local).toEqual([])
    })

    it('opens a linked machine’s view without the window’s lease, which only the hub’s own views carry (#392)', async () => {
      const { router, local, m1, m2 } = rig()
      m1.answers['apps.openView'] = { instanceId: 'inst-aaaaaaaaaaaaaaaa', tool: 'show', resourceUri: 'ui://board/main', toolInput: {}, toolResult: { content: [] }, runId: 'r1' }
      m2.answers['apps.openView'] = { instanceId: 'inst-u', tool: 'show', resourceUri: 'ui://notes/main', toolInput: {}, toolResult: { content: [] }, runId: 'r1' }
      const openKey = 'aabbccdd-1234-4567-8123-aabbccddeeff'
      // That machine sees the hub's link, not the window, so a lease there would be tied to the wrong connection
      await router.handle('apps.openView', { appId: 'board', projectId: 'm1.p1', lease: true, openKey })
      await router.handle('apps.openView', { appId: 'notes', projectId: null, machine: 'm2', lease: true, openKey })
      await router.handle('apps.openView', { appId: 'notes', projectId: null, lease: true, openKey })
      expect(m1.calls).toEqual([{ method: 'apps.openView', params: { appId: 'board', projectId: 'p1', openKey } }])
      expect(m2.calls).toEqual([{ method: 'apps.openView', params: { appId: 'notes', projectId: null, openKey } }])
      expect(local).toEqual([{ method: 'apps.openView', params: { appId: 'notes', projectId: null, lease: true, openKey } }])
    })

    it('hands the hub’s own handler the window’s connection whatever the route, and never a linked machine (#392)', async () => {
      const seen: { method: string; client: number | undefined }[] = []
      const m1 = new FakeMachine('m1', 1)
      const router = new Router({
        local: async (method, _p, ctx) => {
          seen.push({ method, client: ctx?.client })
          return { instanceId: 'own-instance-0000', tool: 'show', resourceUri: 'ui://x/main', toolInput: {}, toolResult: { content: [] }, runId: 'r' }
        },
        machines: () => [m1],
      })
      const ctx = { client: 7 }
      await router.handle('apps.openView', { appId: 'board', projectId: 'p1', lease: true }, ctx)
      await router.handle('apps.openView', { appId: 'notes', projectId: null, lease: true }, ctx)
      await router.handle('apps.holdViews', { instanceIds: ['own-instance-0000'] }, ctx)
      await router.handle('apps.closeView', { instanceId: 'own-instance-0000' }, ctx)
      await router.handle('agents.send', { sessionId: 's1', text: 'x' }, ctx)
      expect(seen).toEqual(['apps.openView', 'apps.openView', 'apps.holdViews', 'apps.closeView', 'agents.send'].map((method) => ({ method, client: 7 })))
      await router.handle('apps.openView', { appId: 'board', projectId: 'm1.p1', lease: true }, ctx)
      expect(m1.calls).toEqual([{ method: 'apps.openView', params: { appId: 'board', projectId: 'p1' } }])
    })

    it('a remote user-folder app’s own calls go to the machine `machine` names: runs, secrets, versions, the builder, Restart (plan §11.9)', async () => {
      const { router, local, m2 } = rig()
      const named = { appId: 'notes', projectId: null, machine: 'm2' }
      const calls: [string, Record<string, unknown>][] = [
        ['apps.runs', { ...named, limit: 100 }],
        ['apps.restart', named],
        ['apps.errors', named],
        ['apps.permissions', named],
        ['apps.forgetPermission', { ...named, capability: 'agent:claude' }],
        ['apps.usage', named],
        ['apps.sendError', { ...named, at: 5 }],
        ['apps.builder', named],
        ['apps.createBuilder', named],
        ['apps.setSecret', { ...named, name: 'TOKEN', value: 'x' }],
        ['apps.versions', named],
        ['apps.restoreVersion', { ...named, id: 'v1' }],
        ['apps.askBuilder', { ...named, text: 'fix it' }],
      ]
      for (const [method, params] of calls) await router.handle(method, params)
      // On that machine it is its own user-folder app: the parameter does not travel
      expect(m2.calls).toEqual(calls.map(([method, params]) => ({ method, params: (({ machine: _m, ...rest }) => rest)(params) })))
      expect(local).toEqual([])
      // Without `machine`, the hub's own app of that id, as before
      for (const [method, params] of calls) await router.handle(method, (({ machine: _m, ...rest }) => rest)(params))
      expect(local.map((c) => c.method)).toEqual(calls.map(([m]) => m))
      expect(m2.calls).toHaveLength(calls.length)
    })

    it('removes a machine’s user-folder app on that machine only, never this computer’s app of the same id (plan §11.10)', async () => {
      const { router, local, m1, m2 } = rig()
      await router.handle('apps.remove', { appId: 'notes', projectId: null, machine: 'm2' })
      // There it is its own app: the parameter does not travel, and neither the hub nor another machine hears of it
      expect(m2.calls).toEqual([{ method: 'apps.remove', params: { appId: 'notes', projectId: null } }])
      expect(local).toEqual([])
      expect(m1.calls).toEqual([])
      // Without `machine`, this computer's own app, and only it
      await router.handle('apps.remove', { appId: 'notes', projectId: null })
      expect(local).toEqual([{ method: 'apps.remove', params: { appId: 'notes', projectId: null } }])
      expect(m2.calls).toHaveLength(1)
      // A machine nobody linked removes nothing anywhere
      await expect(router.handle('apps.remove', { appId: 'notes', projectId: null, machine: 'm9' })).rejects.toThrow(/No linked machine m9/)
      expect(local).toHaveLength(1)
    })

    it('qualifies a remote app’s runs, so the panel’s link reaches the agent session on that machine', async () => {
      const { router, m1 } = rig()
      m1.answers['apps.runs'] = [{ id: 'r1', projectId: null, appId: 'notes', callerSessionId: 's1', sessionId: 's9', parentRunId: null }]
      expect(await router.handle('apps.runs', { appId: 'notes', projectId: null, machine: 'm1', limit: 10 })).toEqual([
        { id: 'r1', projectId: null, appId: 'notes', callerSessionId: 'm1.s1', sessionId: 'm1.s9', parentRunId: null },
      ])
    })

    it('asking a builder from a view names one machine: its instance and `machine` must agree', async () => {
      const { router, m1, m2 } = rig()
      await router.handle('apps.askBuilder', { appId: 'notes', projectId: null, machine: 'm1', text: 'x', instanceId: 'm1.inst' })
      expect(m1.calls).toEqual([{ method: 'apps.askBuilder', params: { appId: 'notes', projectId: null, text: 'x', instanceId: 'inst' } }])
      await expect(
        router.handle('apps.askBuilder', { appId: 'notes', projectId: null, machine: 'm2', text: 'x', instanceId: 'm1.inst' }),
      ).rejects.toThrow(/only the machine it is open on/)
      expect(m2.calls).toEqual([])
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

    it('qualifies the new owner a handoff on that machine gave a session (#693), so the sidebar hangs it there', () => {
      const q = new Qualifier('m1', 1)
      expect(q.event({ type: 'session_owner', sessionId: 's1', askedBy: 'heir', parentSessionId: null })).toEqual({
        type: 'session_owner', sessionId: 'm1.s1', askedBy: 'm1.heir', parentSessionId: null,
      })
    })
  })

  it("qualifies the sessions a machine's prompt cache figures name, so the hub's screen can open them", async () => {
    const { router, m1 } = rig()
    const session = { sessionId: 's1', name: 'Work', requests: 1, inputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 9, rebuilds: 1 }
    const window = { id: '5h', label: 'last 5 h', since: '2026-10-12T10:00:00.000Z', requests: 1, inputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 9, rebuilds: 1, sessions: [session] }
    m1.answers['agents.usage'] = { supported: true, usage: null, cache: { writes: true, countingSince: '2026-10-12T00:00:00.000Z', windows: [window] } }
    expect(await router.handle('agents.usage', { tool: 'claude', machine: 'm1' })).toMatchObject({
      cache: { windows: [{ sessions: [{ sessionId: 'm1.s1', name: 'Work' }] }] },
    })
    // A machine whose host predates the figures answers without them, and that passes as it is
    m1.answers['agents.usage'] = { supported: true, usage: null }
    expect(await router.handle('agents.usage', { tool: 'claude', machine: 'm1' })).toEqual({ supported: true, usage: null })
  })

  describe('the limits of a linked machine logged in to the same account (#726)', () => {
    const limits = { plan: 'max', windows: [{ id: 'weekly_all', label: 'Weekly', percent: 61, resetsAt: null, scope: null }], daily: [] }
    const cache = { writes: true, countingSince: '2026-10-12T00:00:00.000Z', windows: [] }

    it('answers with the hub’s own limits, labelled, and asks the machine only for its cache figures', async () => {
      const { router, local, localAnswers, m1 } = rig()
      localAnswers['agents.account'] = { loggedIn: true, fingerprint: 'same' }
      localAnswers['agents.usage'] = { supported: true, usage: limits }
      m1.answers['agents.account'] = { loggedIn: true, fingerprint: 'same' }
      m1.answers['agents.usage'] = (p: unknown) => ((p as { limits?: boolean }).limits === false ? { supported: true, usage: null, cache } : { supported: false, reason: 'A running session is required to read usage', usage: null })
      expect(await router.handle('agents.usage', { tool: 'claude', machine: 'm1' })).toEqual({ supported: true, usage: limits, sameAccountAsHub: true, cache })
      expect(local.map((c) => c.method)).toEqual(['agents.account', 'agents.usage'])
      expect(m1.calls).toEqual([
        { method: 'agents.account', params: { tool: 'claude' } },
        { method: 'agents.usage', params: { tool: 'claude', limits: false } },
      ])
    })

    it('asks the machine for its limits when the accounts differ', async () => {
      const { router, local, localAnswers, m1 } = rig()
      localAnswers['agents.account'] = { loggedIn: true, fingerprint: 'mine' }
      m1.answers['agents.account'] = { loggedIn: true, fingerprint: 'theirs' }
      m1.answers['agents.usage'] = { supported: true, usage: { ...limits, windows: [] } }
      expect(await router.handle('agents.usage', { tool: 'claude', machine: 'm1' })).toEqual({ supported: true, usage: { ...limits, windows: [] } })
      expect(local.map((c) => c.method)).toEqual(['agents.account'])
      expect(m1.calls.at(-1)).toEqual({ method: 'agents.usage', params: { tool: 'claude' } })
    })

    it('never takes two logins that do not say their account for the same one', async () => {
      const { router, localAnswers, m1 } = rig()
      localAnswers['agents.account'] = { loggedIn: true, fingerprint: null }
      m1.answers['agents.account'] = { loggedIn: true, fingerprint: null }
      m1.answers['agents.usage'] = { supported: false, reason: 'Claude Code is not logged in on this computer', usage: null }
      expect(await router.handle('agents.usage', { tool: 'claude', machine: 'm1' })).toEqual({ supported: false, reason: 'Claude Code is not logged in on this computer', usage: null })
    })

    it('asks the machine as before when its host does not know the account question, or the hub has no limits of its own to give', async () => {
      const { router, localAnswers, m1 } = rig()
      localAnswers['agents.account'] = { loggedIn: true, fingerprint: 'same' }
      m1.answers['agents.account'] = new Error('Unknown method agents.account')
      m1.answers['agents.usage'] = { supported: true, usage: limits }
      expect(await router.handle('agents.usage', { tool: 'claude', machine: 'm1' })).toEqual({ supported: true, usage: limits })
      m1.answers['agents.account'] = { loggedIn: true, fingerprint: 'same' }
      localAnswers['agents.usage'] = { supported: false, reason: 'no answer', usage: null }
      expect(await router.handle('agents.usage', { tool: 'claude', machine: 'm1' })).toEqual({ supported: true, usage: limits })
    })

    it('leaves a call for this computer alone', async () => {
      const { router, local, m1 } = rig()
      await router.handle('agents.usage', { tool: 'claude' })
      expect(local).toEqual([{ method: 'agents.usage', params: { tool: 'claude' } }])
      expect(m1.calls).toEqual([])
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

    // #1219: a trust card names one machine's apps, and a machine that does not answer must not read as one with none
    it('lists one machine apps alone when apps.list names it, and its failure is an error, not an empty list', async () => {
      const { router, local, m1, m2 } = rig()
      m1.answers['apps.list'] = [{ appId: 'notes', projectId: 'p1' }]
      m2.answers['apps.list'] = [{ appId: 'other', projectId: 'p9' }]
      expect(await router.handle('apps.list', { machine: 'm1' })).toEqual([expect.objectContaining({ appId: 'notes', projectId: 'm1.p1', machine: 'm1' })])
      expect(m1.calls).toEqual([{ method: 'apps.list', params: {} }])
      expect(m2.calls).toEqual([])
      expect(local).toEqual([])
      m1.answers['apps.list'] = new Error('dropped')
      await expect(router.handle('apps.list', { machine: 'm1' })).rejects.toThrow()
      // Without a machine it is the merge it always was: a machine that fails is left out
      expect(await router.handle('apps.list', {})).toEqual(expect.arrayContaining([expect.objectContaining({ appId: 'other' })]))
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

    // #841 item 4: the trash read without a machine was shown as the whole trash
    it('names each machine whose trash it could not read, and only when one was missed', async () => {
      const { router, localAnswers, m1, m2 } = rig()
      localAnswers['trash.list'] = { sessions: [], bytes: 0 }
      m1.reachable = false
      m2.answers['trash.list'] = new Error('dropped')
      expect(await router.handle('trash.list', {})).toEqual({
        sessions: [],
        bytes: 0,
        unreached: [
          { machineId: 'm1', name: 'Machine m1' },
          { machineId: 'm2', name: 'Machine m2' },
        ],
      })
      m1.reachable = true
      m1.answers['trash.list'] = { sessions: [], bytes: 5 }
      m2.answers['trash.list'] = { sessions: [], bytes: 7 }
      expect(await router.handle('trash.list', {})).toEqual({ sessions: [], bytes: 12 })
    })

    // #841 item 4: a machine left out made "the trash is empty" true of the hub alone
    it('names each machine it could not empty the trash of among what failed', async () => {
      const { router, localAnswers, m1, m2 } = rig()
      localAnswers['trash.empty'] = { purged: 1, failed: [] }
      m1.reachable = false
      m2.answers['trash.empty'] = new Error('dropped')
      const r = (await router.handle('trash.empty', {})) as { purged: number; failed: { sessionId: string; name: string; error: string }[] }
      expect(r.purged).toBe(1)
      expect(r.failed).toEqual([
        { sessionId: 'm1', name: 'Machine m1', error: expect.stringContaining('could not be reached') },
        { sessionId: 'm2', name: 'Machine m2', error: expect.stringContaining('could not be reached') },
      ])
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

    it('keeps the person’s order across machines on the hub, and lists the projects in it (#734)', async () => {
      const saved: string[][] = []
      const order = { read: () => saved.at(-1) ?? [], write: (ids: readonly string[]) => void saved.push([...ids]) }
      const local: { method: string; params: unknown }[] = []
      const localAnswers: Record<string, unknown> = { 'projects.reorder': [{ id: 'h2' }, { id: 'h1' }], 'projects.list': [{ id: 'h2' }, { id: 'h1' }, { id: 'h3' }] }
      const m1 = new FakeMachine('m1', 1)
      m1.answers['projects.reorder'] = [{ id: 'b' }, { id: 'a' }]
      m1.answers['projects.list'] = [{ id: 'b' }, { id: 'a' }]
      const m2 = new FakeMachine('m2', 2)
      m2.answers['projects.list'] = [{ id: 'c' }]
      const router = new Router({ local: async (method, params) => (local.push({ method, params }), localAnswers[method]), machines: () => [m1, m2], order })

      const r = (await router.handle('projects.reorder', { orderedIds: ['m1.b', 'h2', 'm1.a', 'h1'] })) as { id: string }[]
      expect(saved).toEqual([['m1.b', 'h2', 'm1.a', 'h1']])
      // Each machine still keeps its own order
      expect(local.at(-1)!.params).toEqual({ orderedIds: ['h2', 'h1'] })
      expect(m1.calls).toEqual([{ method: 'projects.reorder', params: { orderedIds: ['b', 'a'] } }])
      // m2 was named in none of it, and its project is still in the answer (the window replaces its list with it)
      expect(r.map((p) => p.id)).toEqual(['m1.b', 'h2', 'm1.a', 'h1', 'm2.c'])
      expect(m2.calls.filter((c) => c.method === 'projects.reorder')).toEqual([])
      // A project the order does not name yet (h3, added since; m2's, a machine linked since) goes at the end
      const listed = (await router.handle('projects.list', {})) as { id: string }[]
      expect(listed.map((p) => p.id)).toEqual(['m1.b', 'h2', 'm1.a', 'h1', 'h3', 'm2.c'])
    })

    /** A hub with two machines and a kept order, for the cases below */
    function ordered(kept: string[]) {
      const saved: string[][] = [kept]
      const order = { read: () => saved.at(-1)!, write: (ids: readonly string[]) => void saved.push([...ids]) }
      const local: { method: string; params: unknown }[] = []
      const hubIds = ['h1', 'h2']
      const localAnswers: Record<string, unknown> = {
        'projects.list': () => hubIds.map((id) => ({ id })),
        'projects.reorder': (p: { orderedIds: string[] }) => [...p.orderedIds.filter((id) => hubIds.includes(id)), ...hubIds.filter((id) => !p.orderedIds.includes(id))].map((id) => ({ id })),
      }
      const m1 = new FakeMachine('m1', 1)
      const m2 = new FakeMachine('m2', 2)
      for (const m of [m1, m2]) {
        const own = m === m1 ? ['a', 'b'] : ['c']
        m.answers['projects.list'] = () => own.map((id) => ({ id }))
        m.answers['projects.reorder'] = (p: { orderedIds: string[] }) => p.orderedIds.map((id) => ({ id }))
      }
      const router = new Router({
        local: async (method, params) => {
          local.push({ method, params })
          const a = localAnswers[method]
          return typeof a === 'function' ? (a as (p: unknown) => unknown)(params) : a
        },
        machines: () => [m1, m2],
        order,
      })
      const ids = async (method: string, params: unknown) => ((await router.handle(method, params)) as { id: string }[]).map((p) => p.id)
      return { router, saved, local, m1, m2, hubIds, ids }
    }

    it('a stale window’s order keeps the projects it did not know in their kept place (#734)', async () => {
      // The window never saw m2.c (its machine came back after it last read): it moves h1 to the top
      const { saved, m2, ids } = ordered(['m1.a', 'm2.c', 'h1', 'h2', 'm1.b'])
      expect(await ids('projects.reorder', { orderedIds: ['h1', 'm1.a', 'h2', 'm1.b'] })).toEqual(['h1', 'm1.a', 'm2.c', 'h2', 'm1.b'])
      expect(saved.at(-1)).toEqual(['h1', 'm1.a', 'm2.c', 'h2', 'm1.b'])
      // m2 keeps its own order too, from the full list
      expect(m2.calls).toContainEqual({ method: 'projects.reorder', params: { orderedIds: ['c'] } })
      expect(keepUnseen(['b'], ['x', 'a', 'b', 'y'])).toEqual(['x', 'a', 'b', 'y'])
      expect(keepUnseen(['b', 'a'], ['a', 'x', 'b'])).toEqual(['b', 'a', 'x'])
    })

    it('refuses an order that is not a list of ids before keeping or sending anything (#734)', async () => {
      const { router, saved, local, m1 } = ordered(['h1'])
      await expect(router.handle('projects.reorder', { orderedIds: 'h1' })).rejects.toThrow()
      await expect(router.handle('projects.reorder', {})).rejects.toThrow()
      expect(saved).toEqual([['h1']])
      expect(local).toEqual([])
      expect(m1.calls).toEqual([])
    })

    it('forgets a project the hub no longer lists, but keeps a linked machine’s it cannot see (#734)', async () => {
      const { saved, ids } = ordered(['gone', 'm1.a', 'h1', 'h2', 'm1.b', 'm1.lost', 'zz.x'])
      await ids('projects.reorder', { orderedIds: ['h2', 'h1', 'm1.a', 'm1.b', 'm2.c'] })
      // `gone` and `zz.x` (a machine no longer linked) are not listed; m1.lost may be out of reach on m1
      expect(saved.at(-1)).toEqual(['h2', 'h1', 'm1.a', 'm1.b', 'm1.lost', 'm2.c'])
    })

    it('a machine that is away keeps its mirrored projects in their place, in the list and in a reorder (#734)', async () => {
      const { m1, ids } = ordered(['m1.a', 'h1', 'm1.b', 'h2', 'm2.c'])
      m1.reachable = false
      m1.mirror.projects = [{ id: 'a' }, { id: 'b' }]
      expect(await ids('projects.list', {})).toEqual(['m1.a', 'h1', 'm1.b', 'h2', 'm2.c'])
      // The window moves h2 to the top; m1 cannot take its part, and its projects stay where they were among the rest
      expect(await ids('projects.reorder', { orderedIds: ['h2', 'm1.a', 'h1', 'm1.b', 'm2.c'] })).toEqual(['h2', 'm1.a', 'h1', 'm1.b', 'm2.c'])
    })

    it('a machine that comes back with new projects lists them at the end, its known ones in place (#734)', async () => {
      const { m1, ids } = ordered(['m1.a', 'h1', 'h2', 'm2.c', 'm1.b'])
      m1.answers['projects.list'] = () => [{ id: 'a' }, { id: 'b' }, { id: 'new' }]
      expect(await ids('projects.list', {})).toEqual(['m1.a', 'h1', 'h2', 'm2.c', 'm1.b', 'm1.new'])
    })

    it('a new project on the hub goes at the end of the list, with machines linked as with none (#734)', async () => {
      const linked = ordered(['m1.a', 'h1', 'm2.c', 'h2', 'm1.b'])
      linked.hubIds.push('h3')
      expect((await linked.ids('projects.list', {})).at(-1)).toBe('h3')
      const alone = new Router({ local: async () => [{ id: 'h1' }, { id: 'h2' }, { id: 'h3' }], machines: () => [], order: { read: () => ['h2', 'h1'], write: () => {} } })
      expect(((await alone.handle('projects.list', {})) as { id: string }[]).at(-1)!.id).toBe('h3')
    })

    it('with no machine linked, lists the hub’s projects in its own order whatever was kept (#734)', async () => {
      const order = { read: () => ['m1.b', 'h2', 'h1'], write: () => {} }
      const router = new Router({ local: async () => [{ id: 'h1' }, { id: 'h2' }], machines: () => [], order })
      expect(((await router.handle('projects.list', {})) as { id: string }[]).map((p) => p.id)).toEqual(['h1', 'h2'])
    })

    it('saves the project order on the machines that can take it while another is away, and gives the away one’s projects back as they were, marked', async () => {
      const { local, localAnswers, m1, m2 } = rig()
      localAnswers['projects.reorder'] = [{ id: 'h1' }]
      m1.reachable = false
      m1.mirror.projects = [{ id: 'a', path: '/srv/a', name: 'a' }, { id: 'b', path: '/srv/b', name: 'b' }]
      m2.answers['projects.reorder'] = [{ id: 'd' }, { id: 'c' }]
      // One that drops mid-call counts as away too
      const m3 = new FakeMachine('m3', 3)
      m3.answers['projects.reorder'] = new Error('dropped')
      m3.mirror.projects = [{ id: 'e', path: '/srv/e', name: 'e' }]
      const routed = new Router({ local: async (method, params) => (local.push({ method, params }), localAnswers[method]), machines: () => [m1, m2, m3] })
      const r = (await routed.handle('projects.reorder', { orderedIds: ['m1.b', 'm2.d', 'h1', 'm1.a', 'm2.c', 'm3.e'] })) as { id: string; unreachable?: boolean }[]
      expect(local.at(-1)!.params).toEqual({ orderedIds: ['h1'] })
      expect(m2.calls).toEqual([{ method: 'projects.reorder', params: { orderedIds: ['d', 'c'] } }])
      expect(r.map((p) => [p.id, p.unreachable === true])).toEqual([
        ['h1', false],
        ['m1.a', true],
        ['m1.b', true],
        ['m2.d', false],
        ['m2.c', false],
        ['m3.e', true],
      ])
    })

    it('adds up the trash, and leaves out a machine that fails, naming it', async () => {
      const { router, localAnswers, m1, m2 } = rig()
      localAnswers['trash.list'] = { sessions: [{ id: 'h1', project: null }], bytes: 10 }
      m1.answers['trash.list'] = { sessions: [{ id: 'a', project: { id: 'p1', name: 'p', path: '/p', exists: true } }], bytes: 5 }
      m2.answers['trash.list'] = new Error('gone')
      expect(await router.handle('trash.list', {})).toEqual({
        sessions: [{ id: 'h1', project: null }, { id: 'm1.a', project: { id: 'm1.p1', name: 'p', path: '/p', exists: true }, machine: 'm1' }],
        bytes: 15,
        unreached: [{ machineId: 'm2', name: 'Machine m2' }],
      })
    })

    /*
     * #378 review: an app's run, and the delete of its session, happen on the machine its app runs on (`apps.runs` routes
     * there). Its record is that machine's: listed with its name, and read and deleted there, so the Runs panel's
     * "in Settings → Archive" is true for a linked machine's app too.
     */
    it('lists a machine’s app-agent run records under its name, and reads and deletes them there', async () => {
      const { router, local, localAnswers, m1 } = rig()
      localAnswers['trash.list'] = { sessions: [], runs: [{ runId: 'run_h', app: { id: 'notes', projectId: 'p1' }, bytes: 7 }], bytes: 7 }
      m1.answers['trash.list'] = { sessions: [{ id: 'a', project: null }], runs: [{ runId: 'run_m', app: { id: 'notes', projectId: 'p9' }, bytes: 30 }], bytes: 35 }
      expect(await router.handle('trash.list', {})).toEqual({
        sessions: [{ id: 'm1.a', project: null, machine: 'm1' }],
        runs: [
          { runId: 'run_h', app: { id: 'notes', projectId: 'p1' }, bytes: 7 },
          { runId: 'run_m', app: { id: 'notes', projectId: 'm1.p9' }, bytes: 30, machine: 'm1' },
        ],
        bytes: 42,
      })

      m1.answers['trash.readRun'] = { request: 'q', answer: 'a', messages: [{ sessionId: 's9', seq: 1, role: 'user', kind: 'text', payload: { text: 'q' }, ts: 1 }] }
      expect(await router.handle('trash.readRun', { runId: 'run_m', limit: 50, machine: 'm1' })).toMatchObject({ messages: [{ sessionId: 'm1.s9', seq: 1 }] })
      m1.answers['trash.purgeRuns'] = { purged: 1 }
      expect(await router.handle('trash.purgeRuns', { runIds: ['run_m'], machine: 'm1' })).toEqual({ purged: 1 })
      expect(m1.calls.filter((c) => c.method !== 'trash.list')).toEqual([
        { method: 'trash.readRun', params: { runId: 'run_m', limit: 50 } },
        { method: 'trash.purgeRuns', params: { runIds: ['run_m'] } },
      ])
      // The hub's own record, with no machine, stays on the hub
      await router.handle('trash.readRun', { runId: 'run_h' })
      expect(local.at(-1)).toEqual({ method: 'trash.readRun', params: { runId: 'run_h' } })
    })

    // #418: a session's subagent steps, held and in the trash, name their machine's session and project
    it('adds up the subagent steps of every machine, in the trash and held, each naming its machine', async () => {
      const { router, localAnswers, m1, m2 } = rig()
      const held = (id: string, project: { id: string; name: string } | null) => ({ sessionId: id, name: 'work', tool: 'claude', project, runs: 1, steps: 3, bytes: 30 })
      localAnswers['trash.list'] = { sessions: [], bytes: 30, subagentSteps: [{ ...held('h1', null), deletedAt: 2 }] }
      m1.answers['trash.list'] = { sessions: [], bytes: 30, subagentSteps: [{ ...held('a', { id: 'p1', name: 'p' }), deletedAt: 1 }] }
      // A machine on a build before #418 says nothing of them
      m2.answers['trash.list'] = { sessions: [], bytes: 0 }
      expect(await router.handle('trash.list', {})).toEqual({
        sessions: [],
        bytes: 60,
        subagentSteps: [
          { ...held('h1', null), deletedAt: 2 },
          { ...held('m1.a', { id: 'm1.p1', name: 'p' }), deletedAt: 1, machine: 'm1' },
        ],
      })
      localAnswers['subagents.usage'] = { sessions: [held('h1', null)] }
      m1.answers['subagents.usage'] = { sessions: [held('a', { id: 'p1', name: 'p' })] }
      m2.answers['subagents.usage'] = new Error('gone')
      expect(await router.handle('subagents.usage', {})).toEqual({
        sessions: [held('h1', null), { ...held('m1.a', { id: 'm1.p1', name: 'p' }), machine: 'm1' }],
        unreached: [{ machineId: 'm2', name: 'Machine m2' }],
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
