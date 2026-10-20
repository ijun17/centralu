/**
 * Work one session gives another is written down in the mailbox beside the old path (docs/plans/mailbox.md §8.1, slice 3):
 * every tool that delegates, over the real manager. The thread is the caller's own and `running`, its first message is the
 * caller's task as the caller wrote it (never the frame the child reads), and nothing in the mailbox wakes the child.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { delegationRecorder } from '../mail/delegation.js'
import { MailService } from '../mail/service.js'
import type { ThreadRow } from '../dev-services/store/mail.js'
import { crossWorld, type CrossHandle, type CrossWorld } from './cross-project.test-helpers.js'

let w: CrossWorld
let mail: MailService

beforeEach(async () => {
  w = await crossWorld()
  mail = new MailService(w.store.mail, { hostId: () => 'hub-aaaaaaaa' })
  w.mgr.useMail({ sessionGone: () => {}, sessionChanged: () => {}, delegated: delegationRecorder(mail, (id) => w.mgr.sessionInfo(id)) })
})
afterEach(async () => {
  await w.dispose()
})

const handleOf = (id: string): CrossHandle | undefined => w.adapters.get('claude')!.handles.get(id) ?? w.adapters.get('codex')!.handles.get(id)
const addr = (id: string) => mail.sessionAddress(id)
const threadsOf = (owner: string): ThreadRow[] => w.store.mail.threadsOfParty(addr(owner), 'owner')
const bodies = (t: ThreadRow) => w.store.mail.messagesAfter(t.id, 0).filter((m) => m.kind !== 'event').map((m) => [m.kind, m.sender, m.body])
const askAgents = () => w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')

describe('start_agent', () => {
  it('writes the task down as a thread the caller owns and the child is assigned, as the caller wrote it and not as the child reads it', async () => {
    askAgents()
    const s = await w.callerSession()
    const started = await w.mgr.startAgent(s, { task: 'Write the export\nand test it', wait: false })
    const child = started.ok ? started.sessionId : ''
    const [thread] = threadsOf(s)
    expect(thread).toMatchObject({ owner: addr(s), assignee: addr(child), origin: 'start_agent', state: 'running', projectId: w.caller.id, subject: 'Write the export' })
    expect(bodies(thread!)).toEqual([['assign', addr(s), 'Write the export\nand test it']])
    // The child read the frame, not the thread; and no mail is waiting for it
    expect(handleOf(child)!.sent[0]).toContain('Write the export')
    expect(handleOf(child)!.sent[0]).not.toBe('Write the export\nand test it')
    expect(mail.drain(addr(child), {}).messageIds).toEqual([])
  })

  it('a note into its running turn (agent_session send) goes in the same thread; at rest, after its answer, it does too', async () => {
    askAgents()
    const s = await w.callerSession()
    const started = await w.mgr.startAgent(s, { task: 'long job', wait: false })
    const child = started.ok ? started.sessionId : ''
    expect((await w.mgr.agentSession(s, { sessionId: child, action: 'send', text: 'use Chromium' })).ok).toBe(true)
    handleOf(child)!.answer('done')
    await w.until(() => w.mgr.sessionInfo(child)?.state !== 'working')
    const again = w.mgr.agentSession(s, { sessionId: child, action: 'send', text: 'and the linter' })
    await w.until(() => (handleOf(child)?.sent.length ?? 0) >= 3)
    handleOf(child)!.answer('linted')
    expect((await again).ok).toBe(true)
    const threads = threadsOf(s)
    expect(threads).toHaveLength(1)
    expect(bodies(threads[0]!).map((b) => [b[0], b[2]])).toEqual([
      ['assign', 'long job'],
      ['note', 'use Chromium'],
      ['note', 'and the linter'],
    ])
  })
})

describe('a fork of a busy session', () => {
  it('is one thread with one instruction, the fork’s own', async () => {
    askAgents()
    const requester = await w.callerSession()
    const started = await w.mgr.startAgent(requester, { task: 'first job', wait: false })
    const busy = started.ok ? started.sessionId : ''
    handleOf(busy)!.externalId = 'ext-busy'
    handleOf(busy)!.answer('first job done')
    await w.mgr.agentSession(requester, { sessionId: busy, action: 'wait' })
    await w.mgr.send(busy, "the person's own work")
    const claude = w.adapters.get('claude') as unknown as { forkConversation?: (id: string) => Promise<string>; readExternalHistory?: () => Promise<unknown[]> }
    claude.forkConversation = async (id) => `fork-of-${id}`
    claude.readExternalHistory = async () => []
    const forking = w.mgr.agentSession(requester, { sessionId: busy, action: 'send', text: 'read the logs', ifBusy: 'fork_read' })
    await w.until(() => w.mgr.listSessions().some((s) => s.forkedFrom === busy))
    const fork = w.mgr.listSessions().find((s) => s.forkedFrom === busy)!
    await w.until(() => (handleOf(fork.id)?.sent.length ?? 0) === 1)
    handleOf(fork.id)!.answer('logs read')
    expect(await forking).toMatchObject({ ok: true, via: 'fork' })
    const thread = w.store.mail.latestBetween(addr(requester), addr(fork.id))!
    expect(thread).toMatchObject({ origin: 'agent_session', state: 'running' })
    expect(bodies(thread)).toEqual([['assign', addr(requester), 'read the logs']])
  })

  it('the orchestrator’s fork, too: one instruction, once', async () => {
    askAgents()
    const worker = await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal' })
    handleOf(worker.id)!.externalId = 'ext-worker'
    await w.mgr.send(worker.id, "the person's own work")
    const claude = w.adapters.get('claude') as unknown as { forkConversation?: (id: string) => Promise<string>; readExternalHistory?: () => Promise<unknown[]> }
    claude.forkConversation = async (id) => `fork-of-${id}`
    claude.readExternalHistory = async () => []
    const orchestrator = (await w.mgr.orchestrator()).id
    await w.mgr.setProjectTrusted(w.caller.id, true)
    const tools = (w.mgr as unknown as { orchestratorToolsFor(id: string): import('../adapters/contract.js').OrchestratorTools }).orchestratorToolsFor(orchestrator)
    const r = await tools.sendToSession(worker.id, 'read the logs', false, 'fork_read')
    const forkId = r.ok && r.busy?.state === 'forked' ? r.busy.sessionId : ''
    const thread = w.store.mail.latestBetween(addr(orchestrator), addr(forkId))!
    expect(thread).toMatchObject({ origin: 'send_to_session', state: 'running' })
    expect(bodies(thread)).toEqual([['assign', addr(orchestrator), 'read the logs']])
  })
})

describe('a mailbox that fails', () => {
  it('breaks no delegation: the task still reaches the child, and nothing is written', async () => {
    w.mgr.useMail({ sessionGone: () => {}, sessionChanged: () => {}, delegated: () => { throw new Error('the store is busy') } })
    askAgents()
    const s = await w.callerSession()
    const started = await w.mgr.startAgent(s, { task: 'Write the export', wait: false })
    expect(started).toMatchObject({ ok: true, state: 'working' })
    expect(handleOf(started.ok ? started.sessionId : '')!.sent[0]).toContain('Write the export')
    expect(threadsOf(s)).toEqual([])
  })
})

describe('a request queued behind a busy session', () => {
  it('is written down when it is delivered, not when it is queued', async () => {
    askAgents()
    const s = await w.callerSession()
    const started = await w.mgr.startAgent(s, { task: 'first job', wait: false })
    const child = started.ok ? started.sessionId : ''
    handleOf(child)!.answer('first job done')
    await w.mgr.agentSession(s, { sessionId: child, action: 'wait' })
    // The person is using the child for a turn of their own: the request waits behind it
    await w.mgr.send(child, "the person's own work")
    const queued = await w.mgr.agentSession(s, { sessionId: child, action: 'send', text: 'add the index', ifBusy: 'queue' })
    expect(queued).toMatchObject({ ok: true, state: 'queued' })
    expect(bodies(threadsOf(s)[0]!).map((b) => b[2])).toEqual(['first job'])
    handleOf(child)!.answer("the person's answer")
    await w.until(() => (handleOf(child)?.sent.length ?? 0) === 3)
    expect(bodies(threadsOf(s)[0]!).map((b) => [b[0], b[2]])).toEqual([
      ['assign', 'first job'],
      ['note', 'add the index'],
    ])
  })
})

describe('an auto observer’s note into another caller’s turn', () => {
  it('is not work it gave: the owner’s thread has no note from it, and it owns no thread', async () => {
    askAgents()
    const owner = await w.callerSession()
    const observer = (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'auto' })).id
    const started = await w.mgr.startAgent(owner, { task: 'owner work', wait: false })
    const child = started.ok ? started.sessionId : ''
    expect(await w.mgr.agentSession(observer, { sessionId: child, action: 'send', text: 'observer note', ifBusy: 'note' })).toMatchObject({ ok: true, state: 'working' })
    expect(bodies(threadsOf(owner)[0]!).map((b) => b[2])).toEqual(['owner work'])
    expect(threadsOf(observer)).toEqual([])
  })
})

describe('ask_project', () => {
  it('writes the task down in the asked project’s session, which the caller owns a thread with, though the relations would refuse a post', async () => {
    const caller = await w.callerSession()
    const target = await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })
    w.store.permissions.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const call = w.mgr.askProject(caller, { project: w.target.id, session: target.id, task: 'export the sprites' })
    await w.until(() => (handleOf(target.id)?.sent.length ?? 0) === 1)
    handleOf(target.id)!.answer('done')
    expect(await call).toMatchObject({ ok: true })
    const [thread] = threadsOf(caller)
    expect(thread).toMatchObject({ assignee: addr(target.id), origin: 'ask_project', projectId: w.target.id, state: 'running' })
    expect(bodies(thread!)).toEqual([['assign', addr(caller), 'export the sprites']])
  })

  it('a task that was refused is written nowhere', async () => {
    const caller = await w.callerSession()
    await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })
    expect(await w.mgr.askProject(caller, { project: w.target.id, session: 'missing', task: 'export' })).toMatchObject({ ok: false, error: expect.stringContaining('No unique ordinary session') })
    expect(threadsOf(caller)).toEqual([])
  })

})

describe('the orchestrator’s send_to_session and create_session', () => {
  const setup = async () => {
    const p = { id: w.caller.id, path: w.caller.path }
    const worker = await w.mgr.createSession({ projectId: p.id, cwd: p.path, tool: 'claude', permissionPreset: 'normal' })
    const orchestrator = (await w.mgr.orchestrator()).id
    return { worker, orchestrator }
  }

  it('with reportBack the instruction is a thread the orchestrator owns; without it nothing is owed and nothing is written', async () => {
    const { worker, orchestrator } = await setup()
    await w.mgr.runOrchestratorTool(orchestrator, 'send_to_session', { sessionId: worker.id, text: 'just a note' })
    expect(threadsOf(orchestrator)).toEqual([])
    handleOf(worker.id)!.answer('ok')
    await w.mgr.runOrchestratorTool(orchestrator, 'send_to_session', { sessionId: worker.id, text: 'fix the test and tell me', reportBack: true })
    const [thread] = threadsOf(orchestrator)
    expect(thread).toMatchObject({ assignee: addr(worker.id), origin: 'send_to_session', state: 'running' })
    expect(bodies(thread!)).toEqual([['assign', addr(orchestrator), 'fix the test and tell me']])
  })

  it('create_session with a first message and reportBack, too', async () => {
    const { orchestrator } = await setup()
    const made = await w.mgr.runOrchestratorTool(orchestrator, 'create_session', { project: w.caller.id, firstMessage: 'start on the docs', reportBack: true })
    expect(made.isError).not.toBe(true)
    const [thread] = threadsOf(orchestrator)
    expect(thread).toMatchObject({ origin: 'create_session', state: 'running', projectId: w.caller.id })
    expect(bodies(thread!)).toEqual([['assign', addr(orchestrator), 'start on the docs']])
  })
})
