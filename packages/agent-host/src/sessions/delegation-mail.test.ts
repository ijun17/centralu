/**
 * Work one session gives another is written down in the mailbox beside the old path (docs/plans/mailbox.md §9.1): every tool that delegates,
 * over the real manager. Each delegation is a task of its own from the caller to the child, its body the caller's words as written (never the
 * frame the child reads), written delivered and read, so nothing in the mailbox wakes the child.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MailRow } from '../dev-services/store/mailbox.js'
import type { HostMail } from '../mail/host-mail.js'
import { crossWorld, type CrossHandle, type CrossWorld } from './cross-project.test-helpers.js'
import { addressOf as addr, mailReader, wireHostMail } from './host-mail.test-helpers.js'
import { turnsOf } from '../dev-services/store/mailbox-turns.test-helpers.js'

let w: CrossWorld
let m: HostMail
let read: ReturnType<typeof mailReader>

beforeEach(async () => {
  w = await crossWorld()
  m = wireHostMail(w.mgr, w.store)
  read = mailReader(w.store)
})
afterEach(async () => {
  m.delivery.stop()
  vi.restoreAllMocks()
  await w.dispose()
})

const handleOf = (id: string): CrossHandle | undefined => w.adapters.get('claude')!.handles.get(id) ?? w.adapters.get('codex')!.handles.get(id)
/** Every task `owner` gave any session of this host, oldest first */
const tasksFrom = (owner: string): MailRow[] =>
  w.mgr
    .listSessions()
    .flatMap((s) => read.tasks(addr(owner), s.id))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))
const bodies = (tasks: MailRow[]) => tasks.map((t) => t.body)
const askAgents = () => w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')

describe('start_agent', () => {
  it('writes the task down from the caller to the child, as the caller wrote it and not as the child reads it, delivered and read', async () => {
    askAgents()
    const s = await w.callerSession()
    const started = await w.mgr.startAgent(s, { task: 'Write the export\nand test it', wait: false })
    const child = started.ok ? started.sessionId : ''
    const [task] = read.tasks(addr(s), child)
    expect(task).toMatchObject({ kind: 'task', sender: addr(s), origin: 'start_agent', body: 'Write the export\nand test it', senderProject: w.caller.id })
    expect(read.taskRow(task!.id, child)).toMatchObject({ recipientProject: w.caller.id, deliveredAt: expect.any(Number), readAt: expect.any(Number), settled: null })
    // The child read the frame, not the task; and no mail is waiting for it
    expect(handleOf(child)!.sent[0]).toContain('Write the export')
    expect(handleOf(child)!.sent[0]).not.toBe('Write the export\nand test it')
    expect(m.service.drain(addr(child), {}).messageIds).toEqual([])
  })

  it('a note into its running turn (agent_session send) is a task of its own; at rest, after its answer, so is the next', async () => {
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
    const tasks = read.tasks(addr(s), child)
    expect(tasks.map((t) => [t.origin, t.body])).toEqual([
      ['start_agent', 'long job'],
      ['agent_session', 'use Chromium'],
      ['agent_session', 'and the linter'],
    ])
    expect(new Set(tasks.map((t) => t.id)).size).toBe(3)
  })
})

describe('a call that returns the answer reports the work', () => {
  it('start_agent that waits: the report replies to the task with the answer as a fact, it is recorded as told, the task is reported, and nothing wakes the caller', async () => {
    askAgents()
    const s = await w.callerSession()
    const call = w.mgr.startAgent(s, { task: 'long job' })
    await w.until(() => w.mgr.listSessions().some((x) => x.askedBy === s))
    const child = w.mgr.listSessions().find((x) => x.askedBy === s)!.id
    await w.until(() => (handleOf(child)?.sent.length ?? 0) === 1)
    handleOf(child)!.answer('all done')
    expect(await call).toMatchObject({ ok: true, state: 'done', answer: 'all done' })
    const [task] = read.tasks(addr(s), child)
    expect(read.taskRow(task!.id, child)).toMatchObject({ settled: 'reported' })
    const reports = read.reportsOn(task!.id)
    expect(reports.map((r) => r.facts.outcome)).toEqual(['finished'])
    // The session's words are a fact of the report, never in Centralu's body
    expect(reports[0]!.body).not.toContain('all done')
    expect(reports[0]!.facts.answer).toBe('all done')
    expect(read.row(reports[0]!.id, addr(s))).toMatchObject({ deliveredAt: expect.any(Number), readAt: expect.any(Number) })
    expect(m.service.drain(addr(s), {}).messageIds).toEqual([])
  })

  it('a later agent_session wait that collects a turn given without waiting does the same', async () => {
    askAgents()
    const s = await w.callerSession()
    const started = await w.mgr.startAgent(s, { task: 'long job', wait: false })
    const child = started.ok ? started.sessionId : ''
    const waiting = w.mgr.agentSession(s, { sessionId: child, action: 'wait' })
    handleOf(child)!.answer('collected')
    expect(await waiting).toMatchObject({ ok: true, state: 'done', answer: 'collected' })
    const [task] = read.tasks(addr(s), child)
    expect(read.taskRow(task!.id, child)).toMatchObject({ settled: 'reported' })
    expect(read.reportsOn(task!.id)).toHaveLength(1)
  })

  it('ask_project: the answer it returns reports the task', async () => {
    const caller = await w.callerSession()
    const target = await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })
    w.store.permissions.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const call = w.mgr.askProject(caller, { project: w.target.id, session: target.id, task: 'export the sprites' })
    await w.until(() => (handleOf(target.id)?.sent.length ?? 0) === 1)
    handleOf(target.id)!.answer('exported')
    expect(await call).toMatchObject({ ok: true })
    const [task] = read.tasks(addr(caller), target.id)
    expect(read.taskRow(task!.id, target.id)).toMatchObject({ settled: 'reported' })
    expect(read.reportsOn(task!.id)[0]).toMatchObject({ facts: expect.objectContaining({ outcome: 'finished', answer: 'exported' }) })
  })

  it('a turn that left the child’s own background work running is not yet the work’s end: the task stays open', async () => {
    askAgents()
    const s = await w.callerSession()
    const started = await w.mgr.startAgent(s, { task: 'start the watcher', wait: false })
    const child = started.ok ? started.sessionId : ''
    handleOf(child)!.event({ type: 'background_tasks', sessionId: child, live: [{ id: 't1', kind: 'shell', description: 'pnpm dev', status: 'running' }] })
    const waiting = w.mgr.agentSession(s, { sessionId: child, action: 'wait' })
    handleOf(child)!.answer('watcher started')
    expect(await waiting).toMatchObject({ ok: true, state: 'done' })
    const [task] = read.tasks(addr(s), child)
    expect(read.taskRow(task!.id, child)).toMatchObject({ settled: null })
    expect(read.reportsOn(task!.id).map((r) => r.facts.outcome)).not.toContain('finished')
  })

  it('reading where a finished child stands (status) marks the report the mailbox holds for the caller read', async () => {
    askAgents()
    const s = await w.callerSession()
    const started = await w.mgr.startAgent(s, { task: 'long job', wait: false })
    const child = started.ok ? started.sessionId : ''
    const [task] = read.tasks(addr(s), child)
    handleOf(child)!.answer('done')
    await w.until(() => read.reportsOn(task!.id).length === 1)
    const report = read.reportsOn(task!.id)[0]!
    expect(read.row(report.id, addr(s))).toMatchObject({ readAt: null })
    expect(await w.mgr.agentSession(s, { sessionId: child, action: 'status' })).toMatchObject({ ok: true })
    expect(read.row(report.id, addr(s))).toMatchObject({ readAt: expect.any(Number) })
  })

  it('ask_project whose session fails reports the failure', async () => {
    const caller = await w.callerSession()
    const target = await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })
    w.store.permissions.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const call = w.mgr.askProject(caller, { project: w.target.id, session: target.id, task: 'export the sprites' })
    await w.until(() => (handleOf(target.id)?.sent.length ?? 0) === 1)
    handleOf(target.id)!.event({ type: 'error', sessionId: target.id, error: { code: 'internal', message: 'You have hit your usage limit', retryable: false } })
    expect(await call).toMatchObject({ ok: false })
    const failed = read.reportsOn(read.tasks(addr(caller), target.id)[0]!.id)[0]
    // The kind of the error, not its words: they are its tool's, and the owner reads them with read_session
    expect(failed).toMatchObject({ facts: expect.objectContaining({ outcome: 'failed', error: 'usage_limit' }) })
    expect(failed?.body).not.toContain('usage limit')
  })

  it('a wait that failed reports the failure', async () => {
    askAgents()
    const s = await w.callerSession()
    const started = await w.mgr.startAgent(s, { task: 'long job', wait: false })
    const child = started.ok ? started.sessionId : ''
    const waiting = w.mgr.agentSession(s, { sessionId: child, action: 'wait' })
    handleOf(child)!.event({ type: 'error', sessionId: child, error: { code: 'internal', message: 'You have hit your usage limit', retryable: false } })
    expect(await waiting).toMatchObject({ ok: false })
    const [task] = read.tasks(addr(s), child)
    const failed = read.reportsOn(task!.id)[0]
    expect(failed).toMatchObject({ facts: expect.objectContaining({ outcome: 'failed', error: 'usage_limit' }) })
    expect(failed?.body).not.toContain('usage limit')
    expect(read.taskRow(task!.id, child)).toMatchObject({ settled: 'reported' })
  })
})

describe('the turns of a delegated child', () => {
  it('each is recorded with who started it and its task: the task’s caller, the person, a later instruction, and how each ended', async () => {
    askAgents()
    const s = await w.callerSession()
    const started = await w.mgr.startAgent(s, { task: 'long job', wait: false })
    const child = started.ok ? started.sessionId : ''
    const [first] = read.tasks(addr(s), child)
    const turnsOfChild = () => turnsOf(w.store, child).map((t) => [t.startedBy, t.messageId, t.outcome])
    expect(turnsOfChild()).toEqual([['caller', first!.id, null]])
    handleOf(child)!.event({ type: 'tool_call', sessionId: child, callId: 'c1', summary: { tool: 'Bash', title: 'ls', paths: [] } })
    handleOf(child)!.answer('done')
    await w.until(() => turnsOfChild()[0]![2] !== null)
    // The person works in the child: a turn of their own, of no task
    await w.mgr.inputs.send(child, 'my own work')
    handleOf(child)!.answer('their answer')
    await w.until(() => turnsOfChild().length === 2 && turnsOfChild()[1]![2] !== null)
    // The caller’s later instruction is a task of its own, and the turn it starts is that task's
    const again = w.mgr.agentSession(s, { sessionId: child, action: 'send', text: 'and the linter' })
    await w.until(() => turnsOfChild().length === 3)
    handleOf(child)!.answer('linted')
    await again
    const [, second] = read.tasks(addr(s), child)
    expect(second).toMatchObject({ body: 'and the linter' })
    expect(turnsOfChild()).toEqual([
      ['caller', first!.id, 'acted'],
      ['person', null, 'empty'],
      ['caller', second!.id, 'empty'],
    ])
  })
})

describe('a fork of a busy session', () => {
  it('is given one task, the fork’s own instruction', async () => {
    askAgents()
    const requester = await w.callerSession()
    const started = await w.mgr.startAgent(requester, { task: 'first job', wait: false })
    const busy = started.ok ? started.sessionId : ''
    handleOf(busy)!.externalId = 'ext-busy'
    handleOf(busy)!.answer('first job done')
    await w.mgr.agentSession(requester, { sessionId: busy, action: 'wait' })
    await w.mgr.inputs.send(busy, "the person's own work")
    const claude = w.adapters.get('claude') as unknown as { forkConversation?: (id: string) => Promise<string>; readExternalHistory?: () => Promise<unknown[]> }
    claude.forkConversation = async (id) => `fork-of-${id}`
    claude.readExternalHistory = async () => []
    const forking = w.mgr.agentSession(requester, { sessionId: busy, action: 'send', text: 'read the logs', ifBusy: 'fork_read' })
    await w.until(() => w.mgr.listSessions().some((s) => s.forkedFrom === busy))
    const fork = w.mgr.listSessions().find((s) => s.forkedFrom === busy)!
    await w.until(() => (handleOf(fork.id)?.sent.length ?? 0) === 1)
    handleOf(fork.id)!.answer('logs read')
    expect(await forking).toMatchObject({ ok: true, via: 'fork' })
    const tasks = read.tasks(addr(requester), fork.id)
    expect(tasks.map((t) => [t.origin, t.body])).toEqual([['agent_session', 'read the logs']])
    expect(read.taskRow(tasks[0]!.id, fork.id)).toMatchObject({ settled: 'reported' })
    // The busy session was given nothing more
    expect(bodies(read.tasks(addr(requester), busy))).toEqual(['first job'])
  })

  it('the Assistant’s fork, too: one task, once', async () => {
    askAgents()
    const worker = await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal' })
    handleOf(worker.id)!.externalId = 'ext-worker'
    await w.mgr.inputs.send(worker.id, "the person's own work")
    const claude = w.adapters.get('claude') as unknown as { forkConversation?: (id: string) => Promise<string>; readExternalHistory?: () => Promise<unknown[]> }
    claude.forkConversation = async (id) => `fork-of-${id}`
    claude.readExternalHistory = async () => []
    const assistant = (await w.mgr.assistant()).id
    await w.mgr.setProjectTrusted(w.caller.id, true)
    const tools = (w.mgr as unknown as { centraluToolsFor(id: string): import('../adapters/contract.js').CentraluTools }).centraluToolsFor(assistant)
    const r = await tools.sendToSession(worker.id, 'read the logs', false, 'fork_read')
    const forkId = r.ok && r.busy?.state === 'forked' ? r.busy.sessionId : ''
    const tasks = read.tasks(addr(assistant), forkId)
    expect(tasks.map((t) => [t.origin, t.body])).toEqual([['send_to_session', 'read the logs']])
    expect(read.taskRow(tasks[0]!.id, forkId)).toMatchObject({ settled: null })
    expect(read.tasks(addr(assistant), worker.id)).toEqual([])
  })
})

describe('the turn a child’s report starts in its caller', () => {
  it('is a turn of its own kind, not a caller’s send, of no task', async () => {
    askAgents()
    const parent = await w.callerSession()
    const started = await w.mgr.startAgent(parent, { task: 'long job', wait: false })
    const child = started.ok ? started.sessionId : ''
    // The parent cannot read mail, so the old way tells it, and the notice starts its turn
    const real = w.mgr.tools.toolProfileOf.bind(w.mgr.tools)
    vi.spyOn(w.mgr.tools, 'toolProfileOf').mockImplementation((id: string) => (id === parent ? 'scoped' : real(id)))
    handleOf(child)!.answer('done')
    await w.until(() => (handleOf(parent)?.sent.length ?? 0) === 1)
    expect(turnsOf(w.store, parent).map((t) => [t.startedBy, t.messageId])).toEqual([['report', null]])
  })
})

describe('a mailbox that fails', () => {
  it('breaks no delegation: the task still reaches the child, and nothing is written', async () => {
    w.mgr.mail.useMail({ sessionGone: () => {}, sessionChanged: () => {}, delegated: () => { throw new Error('the store is busy') } })
    askAgents()
    const s = await w.callerSession()
    const started = await w.mgr.startAgent(s, { task: 'Write the export', wait: false })
    expect(started).toMatchObject({ ok: true, state: 'working' })
    expect(handleOf(started.ok ? started.sessionId : '')!.sent[0]).toContain('Write the export')
    expect(tasksFrom(s)).toEqual([])
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
    await w.mgr.inputs.send(child, "the person's own work")
    const queued = await w.mgr.agentSession(s, { sessionId: child, action: 'send', text: 'add the index', ifBusy: 'queue' })
    expect(queued).toMatchObject({ ok: true, state: 'queued' })
    expect(bodies(read.tasks(addr(s), child))).toEqual(['first job'])
    handleOf(child)!.answer("the person's answer")
    await w.until(() => (handleOf(child)?.sent.length ?? 0) === 3)
    expect(read.tasks(addr(s), child).map((t) => [t.origin, t.body])).toEqual([
      ['start_agent', 'first job'],
      ['agent_session', 'add the index'],
    ])
  })
})

describe('an auto observer’s note into another caller’s turn', () => {
  it('is not work it gave: the owner has one task, and the observer gave none', async () => {
    askAgents()
    const owner = await w.callerSession()
    const observer = (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'auto' })).id
    const started = await w.mgr.startAgent(owner, { task: 'owner work', wait: false })
    const child = started.ok ? started.sessionId : ''
    expect(await w.mgr.agentSession(observer, { sessionId: child, action: 'send', text: 'observer note', ifBusy: 'note' })).toMatchObject({ ok: true, state: 'working' })
    expect(bodies(read.tasks(addr(owner), child))).toEqual(['owner work'])
    expect(tasksFrom(observer)).toEqual([])
  })
})

describe('ask_project', () => {
  it('writes the task down to the asked project’s session, though the relations would refuse a message', async () => {
    const caller = await w.callerSession()
    const target = await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })
    w.store.permissions.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const call = w.mgr.askProject(caller, { project: w.target.id, session: target.id, task: 'export the sprites' })
    await w.until(() => (handleOf(target.id)?.sent.length ?? 0) === 1)
    handleOf(target.id)!.answer('done')
    expect(await call).toMatchObject({ ok: true })
    const tasks = read.tasks(addr(caller), target.id)
    expect(tasks.map((t) => [t.origin, t.sender, t.body])).toEqual([['ask_project', addr(caller), 'export the sprites']])
    expect(read.taskRow(tasks[0]!.id, target.id)).toMatchObject({ recipientProject: w.target.id, settled: 'reported' })
  })

  it('a task that was refused is written nowhere', async () => {
    const caller = await w.callerSession()
    await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })
    expect(await w.mgr.askProject(caller, { project: w.target.id, session: 'missing', task: 'export' })).toMatchObject({ ok: false, error: expect.stringContaining('No unique ordinary session') })
    expect(tasksFrom(caller)).toEqual([])
  })
})

describe('the Assistant’s send_to_session and create_session', () => {
  const setup = async () => {
    const p = { id: w.caller.id, path: w.caller.path }
    const worker = await w.mgr.createSession({ projectId: p.id, cwd: p.path, tool: 'claude', permissionPreset: 'normal' })
    const assistant = (await w.mgr.assistant()).id
    return { worker, assistant }
  }

  it('with reportBack the instruction is a task from the Assistant; without it nothing is owed and nothing is written', async () => {
    const { worker, assistant } = await setup()
    await w.mgr.runCentraluTool(assistant, 'send_to_session', { sessionId: worker.id, text: 'just a note' })
    expect(tasksFrom(assistant)).toEqual([])
    handleOf(worker.id)!.answer('ok')
    await w.mgr.runCentraluTool(assistant, 'send_to_session', { sessionId: worker.id, text: 'fix the test and tell me', reportBack: true })
    const tasks = read.tasks(addr(assistant), worker.id)
    expect(tasks.map((t) => [t.origin, t.sender, t.body])).toEqual([['send_to_session', addr(assistant), 'fix the test and tell me']])
    expect(read.taskRow(tasks[0]!.id, worker.id)).toMatchObject({ settled: null })
  })

  it('create_session with a first message and reportBack, too', async () => {
    const { assistant } = await setup()
    const made = await w.mgr.runCentraluTool(assistant, 'create_session', { project: w.caller.id, firstMessage: 'start on the docs', reportBack: true })
    expect(made.isError).not.toBe(true)
    const tasks = tasksFrom(assistant)
    expect(tasks.map((t) => [t.origin, t.sender, t.body])).toEqual([['create_session', addr(assistant), 'start on the docs']])
    const child = w.mgr.listSessions().find((s) => read.tasks(addr(assistant), s.id).length > 0)!
    expect(read.taskRow(tasks[0]!.id, child.id)).toMatchObject({ recipientProject: w.caller.id, settled: null })
  })
})
