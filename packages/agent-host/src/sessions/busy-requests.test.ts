import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
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
    w.store.messages.loadMessages(b, 50).filter((m) => m.role === 'user' && JSON.stringify(m.payload).includes('The assigned work finished') && (m.payload as { from?: { sessionId: string } }).from?.sessionId === a)

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

  const QUESTION = [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: '' }] }]

  it('names an open question as one in the busy answer (#428)', async () => {
    const { a, b } = await busyChild()
    handleOf(a).event({ type: 'question_request', sessionId: a, requestId: 'q1', questions: QUESTION })
    expect(await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'more work' })).toMatchObject({ state: 'busy', sessionState: 'waiting on a question' })
  })

  it('a request queued behind a card raised between turns goes in once the card is answered (#428)', async () => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const b = await session()
    const started = await w.mgr.startAgent(b, { task: 'first job', wait: false })
    if (!started.ok) throw new Error(started.error)
    const a = started.sessionId
    handleOf(a).answer('first job done')
    await w.mgr.agentSession(b, { sessionId: a, action: 'wait' })
    // Between turns, the tool asks the person something (a background agent, say)
    handleOf(a).event({ type: 'question_request', sessionId: a, requestId: 'q-bg', questions: QUESTION })
    expect(await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'add the index', ifBusy: 'queue' })).toMatchObject({ state: 'queued' })
    // The drain queuing schedules runs while the card stands, and holds the request
    await new Promise((r) => setTimeout(r, 20))
    const sent = handleOf(a).sent.length
    expect(handleOf(a).sent.at(-1)).not.toContain('add the index')
    // Answered: the session goes back to rest by the host's own statement, not a turn's end, and the request goes in
    handleOf(a).event({ type: 'question_resolved', sessionId: a, requestId: 'q-bg' })
    expect(info(a).state).toBe('waiting_input')
    await w.until(() => handleOf(a).sent.length === sent + 1)
    expect(handleOf(a).sent.at(-1)).toContain('add the index')
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
    expect(w.store.children.listQueuedRequests()).toHaveLength(1)
    expect(handleOf(a).sent).toHaveLength(2)
    expect(await w.mgr.agentSession(b, { sessionId: a, action: 'status' })).toMatchObject({ state: 'queued', position: 1 })
    // The first job's report is already there
    const before = reportsTo(b, a).length

    handleOf(a).answer("the person's answer")
    await w.until(() => handleOf(a).sent.length === 3)
    expect(handleOf(a).sent[2]).toContain('add the index')
    expect(handleOf(a).sent[2]).toContain("Centralu's start_agent")
    expect(w.store.children.listQueuedRequests()).toEqual([])
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
    expect(w.store.children.listQueuedRequests()).toEqual([])
  })

  it('queues through ask_project and send_to_session too, framed as each tool frames its work', async () => {
    const target = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
    w.store.permissions.setProjectConsent(w.caller.id, w.target.id, 'delegate')
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

  describe('a queued ask is delivered only while what it rests on holds', () => {
    /** An ask_project request queued behind the person's own turn in the target project */
    const queuedAsk = async () => {
      const target = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
      w.store.permissions.setProjectConsent(w.caller.id, w.target.id, 'delegate')
      const asker = await w.callerSession()
      await w.mgr.send(target, "the person's own work")
      expect(await w.mgr.askProject(asker, { project: w.target.id, task: 'export it', ifBusy: 'queue' })).toMatchObject({ ok: true, state: 'queued' })
      return { target, asker }
    }
    const toldNotDelivered = (asker: string) =>
      w.store.messages.loadMessages(asker, 50).some((m) => JSON.stringify(m.payload).includes('was not delivered'))
    /** The person's turn ends, and the queue empties: a request still in it is delivered or refused now */
    const turnEnds = async (target: string) => {
      handleOf(target).answer("the person's answer")
      await w.until(() => w.store.children.listQueuedRequests().length === 0)
    }

    it("is withdrawn when the caller's project loses trust, and the caller is told", async () => {
      const { target, asker } = await queuedAsk()
      void w.mgr.setProjectTrusted(w.caller.id, false)
      expect(w.store.children.listQueuedRequests()).toEqual([])
      await turnEnds(target)
      expect(handleOf(target).sent).toEqual(["the person's own work"])
      await w.until(() => toldNotDelivered(asker))
    })

    it('is withdrawn when the person revokes the pair in Settings', async () => {
      const { target, asker } = await queuedAsk()
      w.mgr.revokeProjectConsent(w.caller.id, w.target.id, 'delegate')
      expect(w.store.children.listQueuedRequests()).toEqual([])
      await turnEnds(target)
      expect(handleOf(target).sent).toEqual(["the person's own work"])
      await w.until(() => toldNotDelivered(asker))
    })

    it('is withdrawn when the asked project is removed, and the caller is told', async () => {
      const { asker } = await queuedAsk()
      const removing = w.mgr.deleteProject(w.target.id)
      expect(w.store.children.listQueuedRequests()).toEqual([])
      await removing
      await w.until(() => toldNotDelivered(asker))
    })

    it("stays for an auto caller when its project loses trust, as auto's reach does", async () => {
      const { target, asker } = await queuedAsk()
      await w.mgr.updateSettings(asker, { permissionPreset: 'auto' })
      void w.mgr.setProjectTrusted(w.caller.id, false)
      expect(w.store.children.listQueuedRequests()).toHaveLength(1)
      await turnEnds(target)
      expect(handleOf(target).sent[1]).toContain('export it')
    })

    it('is not delivered when the trust is gone by the time the turn ends', async () => {
      const { target, asker } = await queuedAsk()
      // Taken away at the store (as another host would), so only the read at delivery can see it
      w.store.projects.setProjectTrusted(w.caller.id, false)
      await turnEnds(target)
      expect(handleOf(target).sent).toEqual(["the person's own work"])
      expect(w.store.children.listQueuedRequests()).toEqual([])
      await w.until(() => toldNotDelivered(asker))
    })
  })

  describe('a request only auto let through, once the caller is no longer auto', () => {
    const lower = (id: string) => w.mgr.updateSettings(id, { permissionPreset: 'normal' })
    /** Lowered where only the read at delivery can see it, as if no settings change had run on this host */
    const lowerQuietly = (id: string) => {
      ;(w.mgr as unknown as { meta: Map<string, { permissionPreset: PermissionPreset }> }).meta.get(id)!.permissionPreset = 'normal'
    }
    const told = (id: string) => w.store.messages.loadMessages(id, 50).some((m) => JSON.stringify(m.payload).includes('was not delivered'))
    /** An auto asker queues an ask to a busy session of the other project, with no consent remembered for the pair */
    const autoAsk = async () => {
      const target = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
      const asker = await w.callerSession()
      await w.mgr.updateSettings(asker, { permissionPreset: 'auto' })
      await w.mgr.send(target, "the person's own work")
      expect(await w.mgr.askProject(asker, { project: w.target.id, task: 'export it', ifBusy: 'queue' })).toMatchObject({ ok: true, state: 'queued' })
      return { target, asker }
    }
    /** An auto session queues a send to a busy session of its project it did not start */
    const autoSend = async () => {
      const other = await session()
      const sender = await session('auto')
      await w.mgr.send(other, "the person's own work")
      expect(await w.mgr.agentSession(sender, { sessionId: other, action: 'send', text: 'tidy up', ifBusy: 'queue' })).toMatchObject({ ok: true, state: 'queued' })
      return { other, sender }
    }
    const endsWithNothingDelivered = async (target: string) => {
      handleOf(target).answer("the person's answer")
      await w.until(() => w.store.children.listQueuedRequests().length === 0)
      expect(handleOf(target).sent).toEqual(["the person's own work"])
    }

    it('an ask with no consent for the pair is dropped when the caller is moved off auto', async () => {
      const { target, asker } = await autoAsk()
      await lower(asker)
      expect(w.store.children.listQueuedRequests()).toEqual([])
      await endsWithNothingDelivered(target)
      await w.until(() => told(asker))
    })

    it('an ask with no consent for the pair is refused at delivery when the caller is no longer auto', async () => {
      const { target, asker } = await autoAsk()
      lowerQuietly(asker)
      await endsWithNothingDelivered(target)
      await w.until(() => told(asker))
    })

    /*
     * Queued under a remembered consent, then the person revoked it while the caller was auto: the row stayed, as auto's
     * reach does, but nothing marked it as resting on auto alone, so it was delivered once the caller left auto (#838).
     */
    const consentedThenRevoked = async () => {
      const target = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
      w.store.permissions.setProjectConsent(w.caller.id, w.target.id, 'delegate')
      const asker = await w.callerSession()
      await w.mgr.updateSettings(asker, { permissionPreset: 'auto' })
      await w.mgr.send(target, "the person's own work")
      expect(await w.mgr.askProject(asker, { project: w.target.id, task: 'export it', ifBusy: 'queue' })).toMatchObject({ ok: true, state: 'queued' })
      w.mgr.revokeProjectConsent(w.caller.id, w.target.id, 'delegate')
      // Kept, as auto's reach is
      expect(w.store.children.listQueuedRequests()).toHaveLength(1)
      return { target, asker }
    }

    it('an ask whose consent the person revoked while the caller was auto is dropped when the caller leaves auto', async () => {
      const { target, asker } = await consentedThenRevoked()
      await lower(asker)
      expect(w.store.children.listQueuedRequests()).toEqual([])
      await endsWithNothingDelivered(target)
      await w.until(() => told(asker))
    })

    it('the same ask is refused at delivery when the caller is no longer auto', async () => {
      const { target, asker } = await consentedThenRevoked()
      lowerQuietly(asker)
      await endsWithNothingDelivered(target)
      await w.until(() => told(asker))
    })

    it('an ask the pair has consent for still goes in', async () => {
      const { target, asker } = await autoAsk()
      w.store.permissions.setProjectConsent(w.caller.id, w.target.id, 'delegate')
      await lower(asker)
      expect(w.store.children.listQueuedRequests()).toHaveLength(1)
      handleOf(target).answer("the person's answer")
      await w.until(() => handleOf(target).sent.length === 2)
      expect(handleOf(target).sent[1]).toContain('export it')
    })

    it('a send to a session it did not start is dropped when the caller is moved off auto', async () => {
      const { other, sender } = await autoSend()
      await lower(sender)
      expect(w.store.children.listQueuedRequests()).toEqual([])
      await endsWithNothingDelivered(other)
      await w.until(() => told(sender))
    })

    it('a send to a session it did not start is refused at delivery when the caller is no longer auto', async () => {
      const { other, sender } = await autoSend()
      lowerQuietly(sender)
      await endsWithNothingDelivered(other)
      await w.until(() => told(sender))
    })
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
      expect(w.store.messages.loadMessages(fork.id, 50).map((m) => (m.payload as { text?: string }).text)).toEqual(
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
      await w.until(() => w.store.messages.loadMessages(orch.id, 20).some((m) => JSON.stringify(m.payload).includes('asking a question')))
      expect(await tools.readSession(forkId)).toMatchObject({ cards: [{ requestId: 'q-f', kind: 'question' }] })
      handleOf(forkId).event({ type: 'question_resolved', sessionId: forkId, requestId: 'q-f' })
      // The orchestrator is told when the fork's turn ends, as for any work it does not wait on
      handleOf(forkId).answer('logs read')
      await w.until(() => w.store.messages.loadMessages(orch.id, 20).some((m) => JSON.stringify(m.payload).includes('The assigned work finished')))
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

    /*
     * A fork starts an agent, so it keeps to the agent depth (#867) under every preset, auto included: the requester B is
     * itself a child here, and A is B's child the person is using.
     */
    it('follows the agent depth: a requester at it is refused fork and fork_read under auto, and allowed once it is raised', async () => {
      w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
      w.mgr.setUiPreferences({ agentDepth: 2 })
      const top = await session('auto')
      const middle = await w.mgr.startAgent(top, { task: 'middle job', wait: false })
      if (!middle.ok) throw new Error(middle.error)
      const b = middle.sessionId
      const inner = await w.mgr.startAgent(b, { task: 'first job', wait: false })
      if (!inner.ok) throw new Error(inner.error)
      const a = inner.sessionId
      handleOf(a).externalId = 'ext-a'
      handleOf(a).answer('first job done')
      await w.mgr.agentSession(b, { sessionId: a, action: 'wait' })
      await w.mgr.send(a, "the person's own work")

      w.mgr.setUiPreferences({ agentDepth: 1 })
      const setting = 'How deep agents may start agents'
      expect(await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'x' })).toMatchObject({
        choices: expect.arrayContaining([{ choice: 'fork', available: false, why: expect.stringContaining(setting) }]),
      })
      for (const ifBusy of ['fork', 'fork_read'] as const) {
        expect(await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'x', ifBusy })).toMatchObject({
          ok: false,
          error: expect.stringContaining(`No fork of "${info(a).name}": this session is 1 level below a session the person started, and "${setting}"`),
        })
      }
      expect(w.mgr.listSessions().filter((s) => s.forkedFrom)).toEqual([])

      w.mgr.setUiPreferences({ agentDepth: 2 })
      const forking = w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'read it', ifBusy: 'fork_read' })
      await w.until(() => w.mgr.listSessions().some((s) => s.forkedFrom === a))
      const fork = w.mgr.listSessions().find((s) => s.forkedFrom === a)!
      await w.until(() => handleOf(fork.id).sent.length === 1)
      handleOf(fork.id).answer('read')
      expect(await forking).toMatchObject({ ok: true, via: 'fork', forkedFrom: a })
      // The fork is two levels down, and keeps that when B is deleted
      w.mgr.setUiPreferences({ agentDepth: 3 })
      await w.mgr.trashSession(b)
      expect(await w.mgr.startAgent(fork.id, { task: 'deeper', wait: false })).toMatchObject({ ok: true })
      w.mgr.setUiPreferences({ agentDepth: 2 })
      expect(await w.mgr.startAgent(fork.id, { task: 'deeper still', wait: false })).toMatchObject({ ok: false, error: expect.stringContaining('2 levels below') })
    })

    it("withdraws a fork's card when the project loses trust, and makes no fork", async () => {
      const { a, b } = await busyChild('safe')
      // A safe requester with no remembered consent gets the card
      w.mgr.revokeProjectConsent(w.caller.id, w.caller.id, 'agents')
      const forking = w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'x', ifBusy: 'fork_read' })
      await w.until(() => info(b).pendingApproval?.detail.kind === 'agent_start')
      void w.mgr.setProjectTrusted(w.caller.id, false)
      expect(info(b).pendingApproval).toBeFalsy()
      expect(await forking).toMatchObject({ ok: false, error: expect.stringContaining('not trusted') })
      expect(forks).toEqual([])
      expect(w.mgr.listSessions().filter((s) => s.forkedFrom)).toEqual([])
    })

    it("refuses an approval of a fork's card that comes after the project's trust is gone", async () => {
      const { a, b } = await busyChild('safe')
      w.mgr.revokeProjectConsent(w.caller.id, w.caller.id, 'agents')
      const forking = w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'x', ifBusy: 'fork_read' })
      await w.until(() => info(b).pendingApproval?.detail.kind === 'agent_start')
      // Taken away at the store, so only the read after the answer can see it
      w.store.projects.setProjectTrusted(w.caller.id, false)
      w.mgr.respondApproval(b, info(b).pendingApproval!.requestId, 'allow')
      expect(await forking).toMatchObject({ ok: false, error: expect.stringContaining('not trusted') })
      expect(forks).toEqual([])
      expect(w.mgr.listSessions().filter((s) => s.forkedFrom)).toEqual([])
    })

    /** The fake CLI's copy waits until the test lets it finish, so something can change while the fork is being made */
    const slowCopy = () => {
      const fake = claude() as CrossAdapter & { forkConversation?: (id: string, cwd: string) => Promise<string> }
      const copy = fake.forkConversation!
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const state = { started: false, release: () => release() }
      fake.forkConversation = async (id, cwd) => {
        state.started = true
        await gate
        return copy(id, cwd)
      }
      return state
    }
    const taskReached = (words: string) => [...claude().handles.values()].filter((h) => h.sent.some((t) => t.includes(words)))

    it('starts a fork at the requester\'s preset as it is when the fork is made, lowered while the copy was taken', async () => {
      git(w.caller.path)
      const { a, b } = await busyChild()
      const copy = slowCopy()
      const forking = w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'review it', ifBusy: 'fork' })
      await w.until(() => copy.started)
      // Asked for at normal, the lower of the two presets then; the requester is safe by the time the fork starts
      await w.mgr.updateSettings(b, { permissionPreset: 'safe' })
      copy.release()
      await w.until(() => taskReached('review it').length === 1)
      const fork = w.mgr.listSessions().find((s) => s.forkedFrom === a)!
      expect(fork.permissionPreset).toBe('safe')
      expect(handleOf(fork.id).opts.permissionPreset).toBe('safe')
      handleOf(fork.id).answer('reviewed')
      expect(await forking).toMatchObject({ ok: true, answer: 'reviewed' })
    })

    it('gives no task to a fork whose requester was lowered below it while its session was being made', async () => {
      git(w.caller.path)
      const { a, b } = await busyChild()
      const make = w.mgr.createSession.bind(w.mgr)
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let making = false
      vi.spyOn(w.mgr, 'createSession').mockImplementation(async (...args) => {
        making = true
        await gate
        return make(...args)
      })
      const forking = w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'review it', ifBusy: 'fork' })
      await w.until(() => making)
      // The session is being made at normal; the requester is now safe
      await w.mgr.updateSettings(b, { permissionPreset: 'safe' })
      release()
      expect(await forking).toMatchObject({ ok: false, error: expect.stringContaining('lowered to safe') })
      expect(await forking).toMatchObject({ ok: false, error: expect.stringContaining('moved to the trash') })
      expect(w.mgr.listSessions().filter((s) => s.forkedFrom)).toEqual([])
      expect(taskReached('review it')).toEqual([])
    })

    it("gives no task to a fork whose project lost trust while it was being made", async () => {
      const { a, b } = await busyChild()
      const copy = slowCopy()
      const forking = w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'read it', ifBusy: 'fork_read' })
      await w.until(() => copy.started)
      w.store.projects.setProjectTrusted(w.caller.id, false)
      copy.release()
      expect(await forking).toMatchObject({ ok: false, error: expect.stringContaining('not trusted') })
      expect(w.mgr.listSessions().filter((s) => s.forkedFrom)).toEqual([])
      expect(taskReached('read it')).toEqual([])
    })

    it('two forks at once take one place under a ceiling of one', async () => {
      const { a, b } = await busyChild()
      w.mgr.setUiPreferences({ agentCeiling: 1 })
      const calls = [
        w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'one', ifBusy: 'fork_read' }),
        w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'two', ifBusy: 'fork_read' }),
      ]
      // One call is refused at once; the other's fork takes its task and waits for its answer
      let settled = 0
      for (const c of calls) void c.then(() => settled++)
      await w.until(() => settled === 1 && w.mgr.listSessions().some((s) => s.forkedFrom === a && (claude().handles.get(s.id)?.sent.length ?? 0) > 0))
      const made = w.mgr.listSessions().filter((s) => s.forkedFrom)
      expect(made).toHaveLength(1)
      handleOf(made[0]!.id).answer('done')
      const results = await Promise.all(calls)
      expect(results.filter((r) => !r.ok && r.error.includes('already working'))).toHaveLength(1)
      expect(results.filter((r) => r.ok)).toHaveLength(1)
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
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
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
    expect(w.store.children.listQueuedRequests()).toHaveLength(1)
    const { host, claude } = next([a])
    await host.adoptKept([{ sessionId: a, tool: 'claude', process: {} as never }])
    await new Promise((r) => setTimeout(r, 30))
    // Still the person's turn: nothing yet
    expect(claude.handles.get(a)!.sent).toEqual([])
    claude.handles.get(a)!.event({ type: 'state_change', sessionId: a, state: 'working' })
    claude.handles.get(a)!.answer("the person's answer")
    await w.until(() => claude.handles.get(a)!.sent.length === 1)
    expect(claude.handles.get(a)!.sent[0]).toContain('queued work')
    expect(w.store.children.listQueuedRequests()).toEqual([])
  })

  it.each(['marked by this build', 'written by an older build'] as const)(
    'an ask only auto let through is not delivered by the next host once its caller is no longer auto (%s)',
    async (row) => {
      const target = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
      const asker = await w.callerSession()
      await w.mgr.updateSettings(asker, { permissionPreset: 'auto' })
      // A conversation the next host can resume
      w.adapters.get('claude')!.handles.get(target)!.externalId = 'ext-t'
      await w.mgr.send(target, "the person's own work")
      expect(await w.mgr.askProject(asker, { project: w.target.id, task: 'export it', ifBusy: 'queue' })).toMatchObject({ state: 'queued' })
      await w.mgr.detachAll()
      // Lowered where no settings change ran on a host that held the queue (as when it was lowered mid-delivery)
      w.store.sessions.upsertSession({ ...w.store.sessions.listSessions().find((x) => x.id === asker)!, permissionPreset: 'normal' })
      if (row === 'written by an older build') {
        ;(w.store as unknown as { db: { prepare(sql: string): { run(): void } } }).db.prepare('UPDATE queued_requests SET opened_by_auto = NULL').run()
      }
      const { claude } = next([])
      await w.until(() => w.store.children.listQueuedRequests().length === 0)
      expect(claude.handles.get(target)?.sent ?? []).toEqual([])
      await w.until(() => w.store.messages.loadMessages(asker, 50).some((m) => JSON.stringify(m.payload).includes('The asking session is no longer auto')))
    },
  )

  /*
   * A newer build may queue through a tool this one does not know (#384): another word in `queued_requests.via`, left
   * for whichever host serves the store next. It used to pass the delivery gate, which checks only the tools it names,
   * and go in framed as an ask_project without that tool's gates. A request this build cannot read is not delivered,
   * and not dropped either: the row stays for a build that knows the tool, and the requests behind it still go.
   */
  it('is not delivered by a next host that does not know the tool it was queued through, and stays for one that does', async () => {
    const { a, b } = await queuedFor()
    expect(await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'second in line', ifBusy: 'queue' })).toMatchObject({ state: 'queued' })
    await w.mgr.detachAll()
    ;(w.store as unknown as { db: { prepare(sql: string): { run(): void } } }).db.prepare(`UPDATE queued_requests SET via = 'hand_off' WHERE text = 'queued work'`).run()
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { claude } = next([])
    await w.until(() => (claude.handles.get(a)?.sent.length ?? 0) === 1)
    expect(claude.handles.get(a)!.sent[0]).toContain('second in line')
    expect(claude.handles.get(a)!.sent.join(' | ')).not.toContain('queued work')
    expect(w.store.children.listQueuedRequests()).toMatchObject([{ via: 'hand_off', text: 'queued work' }])
    expect(said.mock.calls.map((c) => String(c[0])).join(' | ')).toContain('"hand_off"')
    said.mockRestore()
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
    expect(w.store.children.listQueuedRequests()).toEqual([])
  })

  it('keeps the session busy while it wakes for a queued request, and lets one request in at a time', async () => {
    const { a, orch } = await queuedBehindThePerson()
    await w.mgr.detachAll()
    // The next host finds the session asleep, with the request still queued: waking it takes a while
    const next = nextHost(true)
    await w.until(() => next.starts.includes(a))
    expect(w.store.children.listQueuedRequests()).toEqual([expect.objectContaining({ text: 'first', deliveringAt: expect.any(Number) })])
    const tools = toolsOf(next.host, orch)
    // Busy while it wakes: another request is not let in beside the one being delivered
    expect(await tools.sendToSession(a, 'second', false)).toMatchObject({ ok: true, busy: { state: 'busy' } })
    expect(await tools.sendToSession(a, 'second', false, 'queue')).toMatchObject({ ok: true, busy: { state: 'queued', position: 2 } })
    next.release()
    await w.until(() => next.adapter.handles.get(a)?.sent.includes('first') ?? false)
    await new Promise((r) => setTimeout(r, 30))
    expect(next.adapter.handles.get(a)!.sent).toEqual(['first'])
    // Delivered once its turn started; the second waits for that turn to end
    expect(w.store.children.listQueuedRequests().map((r) => r.text)).toEqual(['second'])
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
    expect(w.store.children.listQueuedRequests()).toEqual([expect.objectContaining({ text: 'first' })])
    const after = nextHost(false)
    await w.until(() => after.adapter.handles.get(a)?.sent.includes('first') ?? false)
    expect(w.store.children.listQueuedRequests()).toEqual([])
  })

  it('holds a retried request once', async () => {
    const { a, orch } = await queuedBehindThePerson()
    const tools = toolsOf(w.mgr, orch)
    const first = w.store.children.listQueuedRequests()[0]!.id
    expect(await tools.sendToSession(a, 'first', false, 'queue')).toMatchObject({ busy: { state: 'queued', queueId: first, position: 1 } })
    expect(await tools.sendToSession(a, 'another', false, 'queue')).toMatchObject({ busy: { state: 'queued', position: 2 } })
    expect(w.store.children.listQueuedRequests().map((r) => r.text)).toEqual(['first', 'another'])
  })
})
