import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentAdapter, HistoryMessage, OrchestratorTools } from '../adapters/contract.js'
import type { PermissionPreset, ToolName } from '@cc/protocol'
import { CrossAdapter, crossWorld, type CrossWorld } from './cross-project.test-helpers.js'
import { SessionManager } from './manager.js'
import { runOrchestratorTool } from './orchestrator-tools.js'

/**
 * Requests to a busy session (#677): when B asks A for work while A runs a turn that is not B's, Centralu does not
 * decide for B. The request tool returns the choices (note, queue, fork), or takes the one B passed as `ifBusy`. A note
 * joins the running turn (auto only); a queue is delivered as a new turn when that turn ends, and survives a host
 * swap; a fork is a sub-session from a copy of A's conversation, linked to B, under A in the sidebar, in a worktree of
 * its own when the work may edit files.
 */

describe('requests to a busy session (#677)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    await w.dispose()
  })

  const claude = () => w.adapters.get('claude')!
  const handleOf = (id: string) => claude().handles.get(id)!
  const session = async (preset: PermissionPreset = 'normal') =>
    (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: preset })).id
  const info = (id: string) => w.mgr.listSessions().find((s) => s.id === id)!
  /** B with a child A it started, which the person is now using for a turn of their own */
  const busyChild = async (preset: PermissionPreset = 'normal') => {
    w.store.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const b = await session(preset)
    const started = await w.mgr.startAgent(b, { task: 'first job', wait: false })
    if (!started.ok) throw new Error(started.error)
    const a = started.sessionId
    // A has a conversation of its own to copy
    handleOf(a).externalId = 'ext-a'
    handleOf(a).answer('first job done')
    await w.mgr.agentSession(b, { sessionId: a, action: 'wait' })
    await w.mgr.send(a, "the person's own work")
    return { a, b }
  }
  const reportsTo = (b: string, a: string) =>
    w.store.loadMessages(b, 50).filter((m) => m.role === 'user' && JSON.stringify(m.payload).includes('The assigned work finished') && (m.payload as { from?: { sessionId: string } }).from?.sessionId === a)

  it('returns the choices and sends nothing when the requester names none', async () => {
    const { a, b } = await busyChild()
    expect(await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'more work' })).toMatchObject({
      ok: true,
      state: 'busy',
      sessionId: a,
      sessionState: 'working',
      choices: [
        { choice: 'note', available: false, why: expect.stringContaining('auto') },
        { choice: 'queue', available: true },
        // The Claude fake cannot fork until a test gives it the way
        { choice: 'fork', available: false, why: expect.stringContaining('cannot fork') },
      ],
    })
    expect(handleOf(a).sent).toHaveLength(2)
    // The model reads each choice and the call that takes it
    const text = (await runOrchestratorTool({ agentSession: (o) => w.mgr.agentSession(b, o) } as OrchestratorTools, 'agent_session', { sessionId: a, action: 'send', text: 'more work' }, { sessionId: b, profile: 'reader' })).text
    expect(text).toContain('nothing was sent')
    expect(text).toContain('ifBusy="queue"')
  })

  it('a note joins the running turn for an auto requester only', async () => {
    const { a, b } = await busyChild('auto')
    const noted = await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'use Chromium', ifBusy: 'note' })
    expect(noted).toMatchObject({ ok: true, state: 'working', via: 'note' })
    expect(handleOf(a).sent).toHaveLength(3)
    expect(handleOf(a).sent[2]).toContain('use Chromium')
  })

  it('a queue holds the request and delivers it as a new turn when the running one ends, then tells the requester', async () => {
    const { a, b } = await busyChild()
    const queued = await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'add the index', ifBusy: 'queue' })
    expect(queued).toMatchObject({ ok: true, state: 'queued', position: 1, queueId: expect.stringMatching(/^qr-/) })
    expect(w.store.listQueuedRequests()).toHaveLength(1)
    expect(handleOf(a).sent).toHaveLength(2)
    expect(await w.mgr.agentSession(b, { sessionId: a, action: 'status' })).toMatchObject({ state: 'queued', position: 1 })
    // The first job's report is already there
    const before = reportsTo(b, a).length

    handleOf(a).answer("the person's answer")
    await w.until(() => handleOf(a).sent.length === 3)
    expect(handleOf(a).sent[2]).toContain('add the index')
    expect(handleOf(a).sent[2]).toContain("Centralu's start_agent")
    expect(w.store.listQueuedRequests()).toEqual([])
    // The person's turn was not reported as the assigned work; the queued one is, once it ends
    expect(reportsTo(b, a)).toHaveLength(before)
    handleOf(a).answer('index added')
    await w.until(() => reportsTo(b, a).length === before + 1)
    expect(JSON.stringify(reportsTo(b, a).at(-1)!.payload)).toContain('index added')
  })

  it('delivers two queued requests one turn at a time, in the order they came', async () => {
    const { a, b } = await busyChild()
    const c = await session('auto')
    await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'first in line', ifBusy: 'queue' })
    expect(await w.mgr.agentSession(c, { sessionId: a, action: 'send', text: 'second in line', ifBusy: 'queue' })).toMatchObject({ state: 'queued', position: 2 })
    handleOf(a).answer("the person's answer")
    await w.until(() => handleOf(a).sent.length === 3)
    await new Promise((r) => setTimeout(r, 30))
    expect(handleOf(a).sent).toHaveLength(3)
    expect(handleOf(a).sent[2]).toContain('first in line')
    handleOf(a).answer('first done')
    await w.until(() => handleOf(a).sent.length === 4)
    expect(handleOf(a).sent[3]).toContain('second in line')
  })

  it('withdraws a queued request on stop', async () => {
    const { a, b } = await busyChild()
    await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'never mind', ifBusy: 'queue' })
    expect(await w.mgr.agentSession(b, { sessionId: a, action: 'stop' })).toMatchObject({ ok: true, state: 'stopped' })
    handleOf(a).answer("the person's answer")
    await new Promise((r) => setTimeout(r, 30))
    expect(handleOf(a).sent).toHaveLength(2)
    expect(w.store.listQueuedRequests()).toEqual([])
  })

  it('queues through ask_project and send_to_session too, framed as each tool frames its work', async () => {
    const target = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const asker = await w.callerSession()
    await w.mgr.send(target, "the person's own work")
    expect(await w.mgr.askProject(asker, { project: w.target.id, task: 'export it' })).toMatchObject({ ok: true, state: 'busy' })
    expect(await w.mgr.askProject(asker, { project: w.target.id, task: 'export it', ifBusy: 'queue' })).toMatchObject({ ok: true, state: 'queued', position: 1 })
    expect(await w.mgr.askProject(asker, { project: w.target.id, session: target })).toMatchObject({ ok: true, state: 'queued' })

    const orch = await w.mgr.orchestrator()
    const tools = (w.mgr as unknown as { orchestratorToolsFor(id: string): OrchestratorTools }).orchestratorToolsFor(orch.id)
    expect(await tools.sendToSession(target, 'and tidy up', false)).toMatchObject({ ok: true, busy: { state: 'busy' } })
    expect(await tools.sendToSession(target, 'and tidy up', false, 'queue')).toMatchObject({ ok: true, busy: { state: 'queued', position: 2 } })

    handleOf(target).answer("the person's answer")
    await w.until(() => handleOf(target).sent.length === 2)
    expect(handleOf(target).sent[1]).toContain("through Centralu's ask_project")
    handleOf(target).answer('exported')
    expect(await w.mgr.askProject(asker, { project: w.target.id, session: target })).toMatchObject({ ok: true, state: 'done', answer: 'exported' })
    await w.until(() => handleOf(target).sent.length === 3)
    expect(handleOf(target).sent[2]).toBe('and tidy up')
  })

  it('a note from send_to_session needs an auto orchestrator', async () => {
    const worker = await session()
    await w.mgr.send(worker, "the person's own work")
    const orch = await w.mgr.orchestrator()
    const tools = (w.mgr as unknown as { orchestratorToolsFor(id: string): OrchestratorTools }).orchestratorToolsFor(orch.id)
    expect(await tools.sendToSession(worker, 'also this', false, 'note')).toMatchObject({ ok: false, error: expect.stringContaining('auto') })
    await w.mgr.updateSettings(orch.id, { permissionPreset: 'auto' })
    expect(await tools.sendToSession(worker, 'also this', false, 'note')).toMatchObject({ ok: true, busy: { state: 'noted' } })
    expect(handleOf(worker).sent).toEqual(["the person's own work", 'also this'])
  })

  describe('a fork', () => {
    /** The fake CLI copies a conversation the way Claude's forkSession and Codex's thread/fork do: a new id, the same history */
    const forks: { from: string; cwd: string; to: string }[] = []
    const history = new Map<string, HistoryMessage[]>()
    beforeEach(() => {
      forks.length = 0
      const fake = claude() as CrossAdapter & {
        forkConversation?: (id: string, cwd: string) => Promise<string>
        readExternalHistory?: (id: string) => Promise<HistoryMessage[]>
      }
      history.set('ext-a', [{ role: 'user', text: 'first job' }, { role: 'assistant', text: 'first job done' }])
      fake.forkConversation = async (id, cwd) => {
        const to = `fork-of-${id}-${forks.length}`
        forks.push({ from: id, cwd, to })
        history.set(to, [...(history.get(id) ?? [])])
        return to
      }
      fake.readExternalHistory = async (id) => history.get(id) ?? []
    })

    const git = (cwd: string) => {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd })
      writeFileSync(join(cwd, 'README.md'), 'x')
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.'], { cwd })
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd })
    }

    it('starts from a copy of the busy session\'s conversation, in a worktree of its own, linked to the requester', async () => {
      git(w.caller.path)
      const { a, b } = await busyChild()
      const forking = w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'review the schema', ifBusy: 'fork' })
      await w.until(() => w.mgr.listSessions().some((s) => s.forkedFrom === a))
      const fork = w.mgr.listSessions().find((s) => s.forkedFrom === a)!
      // The copy is of A's conversation, taken from the folder A runs in; the original is left running
      expect(forks).toEqual([{ from: 'ext-a', cwd: w.caller.path, to: 'fork-of-ext-a-0' }])
      expect(handleOf(fork.id).opts.resumeExternalId).toBe('fork-of-ext-a-0')
      expect(w.store.loadMessages(fork.id, 50).map((m) => (m.payload as { text?: string }).text)).toEqual(
        expect.arrayContaining(['first job', 'first job done']),
      )
      expect(info(a).state).toBe('working')
      // Its own folder: two agents never write one
      expect(fork.worktree).toBeTruthy()
      expect(handleOf(fork.id).opts.cwd).not.toBe(w.caller.path)
      expect(fork).toMatchObject({ askedBy: b, forkedFrom: a, permissionPreset: 'normal' })
      await w.until(() => handleOf(fork.id).sent.length === 1)
      expect(handleOf(fork.id).sent[0]).toContain('review the schema')
      // B owns the fork's turn: its answer comes back to B
      handleOf(fork.id).answer('schema reviewed')
      expect(await forking).toMatchObject({ ok: true, state: 'done', sessionId: fork.id, via: 'fork', forkedFrom: a, answer: 'schema reviewed' })
    })

    it('fork_read shares the busy session\'s folder under at most safe, and its turn reports to the requester', async () => {
      const { a, b } = await busyChild()
      const orch = await w.mgr.orchestrator()
      w.mgr.setProjectTrusted(w.caller.id, true)
      const tools = (w.mgr as unknown as { orchestratorToolsFor(id: string): OrchestratorTools }).orchestratorToolsFor(orch.id)
      const r = await tools.sendToSession(a, 'read the logs', false, 'fork_read')
      expect(r).toMatchObject({ ok: true, busy: { state: 'forked', forkedFrom: a } })
      const forkId = r.busy?.state === 'forked' ? r.busy.sessionId : ''
      expect(info(forkId)).toMatchObject({ forkedFrom: a, permissionPreset: 'safe', worktree: null })
      expect(handleOf(forkId).opts.cwd).toBe(w.caller.path)
      // Its question goes to the orchestrator, which gave it the turn (#676)
      handleOf(forkId).event({ type: 'question_request', sessionId: forkId, requestId: 'q-f', questions: [{ question: 'Which log?', header: '', options: [], multiSelect: false }] })
      await w.until(() => w.store.loadMessages(orch.id, 20).some((m) => JSON.stringify(m.payload).includes('asking a question')))
      expect(await tools.readSession(forkId)).toMatchObject({ cards: [{ requestId: 'q-f', kind: 'question' }] })
      handleOf(forkId).event({ type: 'question_resolved', sessionId: forkId, requestId: 'q-f' })
      // The orchestrator is told when the fork's turn ends, as for any work it does not wait on
      handleOf(forkId).answer('logs read')
      await w.until(() => w.store.loadMessages(orch.id, 20).some((m) => JSON.stringify(m.payload).includes('The assigned work finished')))
      void b
    })

    it('is not offered by a CLI that cannot fork, nor across projects', async () => {
      const { a, b } = await busyChild()
      delete (claude() as { forkConversation?: unknown }).forkConversation
      expect(await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'x' })).toMatchObject({ choices: [{}, {}, { choice: 'fork', available: false, why: expect.stringContaining('cannot fork') }] })
      expect(await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'x', ifBusy: 'fork' })).toMatchObject({ ok: false, error: expect.stringContaining('cannot fork') })
      expect(w.mgr.listSessions().filter((s) => s.forkedFrom)).toEqual([])
    })

    it('follows start_agent\'s gates: an untrusted project, or the per-project ceiling, refuses it', async () => {
      const { a, b } = await busyChild()
      w.mgr.setProjectTrusted(w.caller.id, false)
      expect(await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'x', ifBusy: 'fork_read' })).toMatchObject({ ok: false, error: expect.stringContaining('not trusted') })
      w.mgr.setProjectTrusted(w.caller.id, true)
      w.mgr.setUiPreferences({ agentCeiling: 1 })
      // B's earlier child is at rest; one running child fills a ceiling of one
      const runner = await w.mgr.startAgent(b, { task: 'keep busy', wait: false })
      expect(runner).toMatchObject({ ok: true })
      expect(await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'x', ifBusy: 'fork_read' })).toMatchObject({ ok: false, error: expect.stringContaining('already working') })
      expect(w.mgr.listSessions().filter((s) => s.forkedFrom)).toEqual([])
    })
  })
})

describe('a queued request across a host swap (#677)', () => {
  let w: CrossWorld
  const hosts: SessionManager[] = []
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    for (const h of hosts.splice(0)) await h.disposeAll()
    await w.dispose()
  })

  const next = (kept: string[]) => {
    const claude = new CrossAdapter('claude')
    const host = new SessionManager(w.store, new Map<ToolName, AgentAdapter>([['claude', claude], ['codex', new CrossAdapter('codex')]]), () => {}, undefined, undefined, { keptSessions: new Set(kept) })
    hosts.push(host)
    return { host, claude }
  }
  const queuedFor = async () => {
    w.store.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const b = (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal' })).id
    const started = await w.mgr.startAgent(b, { task: 'first job', wait: false })
    if (!started.ok) throw new Error(started.error)
    const a = started.sessionId
    // A conversation the next host can resume
    w.adapters.get('claude')!.handles.get(a)!.externalId = 'ext-a'
    w.adapters.get('claude')!.handles.get(a)!.answer('done')
    await w.mgr.agentSession(b, { sessionId: a, action: 'wait' })
    await w.mgr.send(a, "the person's own work")
    expect(await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'queued work', ifBusy: 'queue' })).toMatchObject({ state: 'queued' })
    return { a, b }
  }

  it('is delivered by the next host when the kept session\'s turn ends there', async () => {
    const { a } = await queuedFor()
    await w.mgr.detachAll()
    expect(w.store.listQueuedRequests()).toHaveLength(1)
    const { host, claude } = next([a])
    await host.adoptKept([{ sessionId: a, tool: 'claude', process: {} as never }])
    await new Promise((r) => setTimeout(r, 30))
    // Still the person's turn: nothing yet
    expect(claude.handles.get(a)!.sent).toEqual([])
    claude.handles.get(a)!.event({ type: 'state_change', sessionId: a, state: 'working' })
    claude.handles.get(a)!.answer("the person's answer")
    await w.until(() => claude.handles.get(a)!.sent.length === 1)
    expect(claude.handles.get(a)!.sent[0]).toContain('queued work')
    expect(w.store.listQueuedRequests()).toEqual([])
  })

  it('is delivered at once by a next host that finds the session at rest', async () => {
    const { a } = await queuedFor()
    await w.mgr.detachAll()
    const { claude } = next([])
    await w.until(() => (claude.handles.get(a)?.sent.length ?? 0) === 1)
    expect(claude.handles.get(a)!.sent[0]).toContain('queued work')
  })
})

describe('the queue delivers each request once, in turn, through restarts and swaps (#684 review)', () => {
  let w: CrossWorld
  const hosts: SessionManager[] = []
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    for (const h of hosts.splice(0)) await h.disposeAll()
    await w.dispose()
  })

  const claude = () => w.adapters.get('claude')!
  const handleOf = (id: string) => claude().handles.get(id)!
  /** A next host whose Claude takes as long to start a process as the test lets it (a sleeping session waking) */
  const nextHost = (gated: boolean) => {
    const adapter = new CrossAdapter('claude')
    let release!: () => void
    const gate = gated ? new Promise<void>((r) => (release = r)) : Promise.resolve()
    const starts: string[] = []
    const create = adapter.createSession.bind(adapter)
    adapter.createSession = async (opts, emit) => {
      starts.push(opts.sessionId)
      await gate
      return create(opts, emit)
    }
    const host = new SessionManager(w.store, new Map<ToolName, AgentAdapter>([['claude', adapter], ['codex', new CrossAdapter('codex')]]), () => {}, undefined, undefined, {})
    hosts.push(host)
    return { host, adapter, starts, release: () => release() }
  }
  const toolsOf = (mgr: SessionManager, id: string) => (mgr as unknown as { orchestratorToolsFor(id: string): OrchestratorTools }).orchestratorToolsFor(id)
  /** A session the person is using, with a conversation to resume, and the orchestrator's request queued behind its turn */
  const queuedBehindThePerson = async () => {
    const a = (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal' })).id
    handleOf(a).externalId = 'ext-a'
    await w.mgr.send(a, "the person's own work")
    const orch = await w.mgr.orchestrator()
    expect(await toolsOf(w.mgr, orch.id).sendToSession(a, 'first', false, 'queue')).toMatchObject({ ok: true, busy: { state: 'queued', position: 1 } })
    return { a, orch: orch.id }
  }

  it('does not stall behind a restart the turn\'s end set off', async () => {
    const { a } = await queuedBehindThePerson()
    // A setting changed during the turn restarts the process when the turn ends
    expect(await w.mgr.updateSettings(a, { effort: 'high' })).toMatchObject({ applied: 'after_turn' })
    // The new process takes a moment to start, as a real one does: the drain the turn's end scheduled runs meanwhile
    const create = claude().createSession.bind(claude())
    claude().createSession = async (opts, emit) => {
      await new Promise((r) => setTimeout(r, 50))
      return create(opts, emit)
    }
    const before = handleOf(a)
    before.answer("the person's answer")
    await w.until(() => handleOf(a) !== before && handleOf(a).sent.includes('first'))
    expect(w.store.listQueuedRequests()).toEqual([])
  })

  it('keeps the session busy while it wakes for a queued request, and lets one request in at a time', async () => {
    const { a, orch } = await queuedBehindThePerson()
    await w.mgr.detachAll()
    // The next host finds the session asleep, with the request still queued: waking it takes a while
    const next = nextHost(true)
    await w.until(() => next.starts.includes(a))
    expect(w.store.listQueuedRequests()).toEqual([expect.objectContaining({ text: 'first', deliveringAt: expect.any(Number) })])
    const tools = toolsOf(next.host, orch)
    // Busy while it wakes: another request is not let in beside the one being delivered
    expect(await tools.sendToSession(a, 'second', false)).toMatchObject({ ok: true, busy: { state: 'busy' } })
    expect(await tools.sendToSession(a, 'second', false, 'queue')).toMatchObject({ ok: true, busy: { state: 'queued', position: 2 } })
    next.release()
    await w.until(() => next.adapter.handles.get(a)?.sent.includes('first') ?? false)
    await new Promise((r) => setTimeout(r, 30))
    expect(next.adapter.handles.get(a)!.sent).toEqual(['first'])
    // Delivered once its turn started; the second waits for that turn to end
    expect(w.store.listQueuedRequests().map((r) => r.text)).toEqual(['second'])
    next.adapter.handles.get(a)!.answer('first done')
    await w.until(() => next.adapter.handles.get(a)!.sent.length === 2)
    expect(next.adapter.handles.get(a)!.sent).toEqual(['first', 'second'])
  })

  it('is delivered by the next host when a swap comes while the session wakes for it', async () => {
    const { a } = await queuedBehindThePerson()
    await w.mgr.detachAll()
    const waking = nextHost(true)
    await w.until(() => waking.starts.includes(a))
    // The host leaves before the session took the request
    await waking.host.detachAll()
    expect(w.store.listQueuedRequests()).toEqual([expect.objectContaining({ text: 'first' })])
    const after = nextHost(false)
    await w.until(() => after.adapter.handles.get(a)?.sent.includes('first') ?? false)
    expect(w.store.listQueuedRequests()).toEqual([])
  })

  it('holds a retried request once', async () => {
    const { a, orch } = await queuedBehindThePerson()
    const tools = toolsOf(w.mgr, orch)
    const first = w.store.listQueuedRequests()[0]!.id
    expect(await tools.sendToSession(a, 'first', false, 'queue')).toMatchObject({ busy: { state: 'queued', queueId: first, position: 1 } })
    expect(await tools.sendToSession(a, 'another', false, 'queue')).toMatchObject({ busy: { state: 'queued', position: 2 } })
    expect(w.store.listQueuedRequests().map((r) => r.text)).toEqual(['first', 'another'])
  })
})
