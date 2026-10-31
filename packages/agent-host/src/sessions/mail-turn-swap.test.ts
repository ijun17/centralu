/**
 * The turn records across a host swap (docs/plans/mailbox.md §6, §4.2): a session the keeper kept goes on in its turn under the next
 * host, whose start must not close that turn's row as lost, so that its end is recorded; the rows of everything else are.
 */
import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { answerRecorder, delegationRecorder, reportRecorder, turnRecorder } from '../mail/delegation.js'
import { MailDelivery } from '../mail/delivery.js'
import { mailRelations } from '../mail/relations.js'
import { MailService } from '../mail/service.js'
import { takeOverFromEarlierBuild } from '../mail/adoption.js'
import { MailTurns } from '../mail/turns.js'
import { SessionManager, type AgentProcessHost } from './manager.js'

class FakeProcess extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  exitCode = null
  killed = false
  kill() {
    return true
  }
}

class Handle implements SessionHandle {
  externalId: string | null
  sent: string[] = []
  constructor(
    readonly sessionId: string,
    readonly opts: CreateSessionOpts,
    private emit: EventSink,
  ) {
    this.externalId = opts.resumeExternalId ?? `ext-${sessionId}`
  }
  send(text: string) {
    this.sent.push(text)
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
  }
  answer(text: string) {
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text })
    this.emit({ type: 'turn_complete', sessionId: this.sessionId })
  }
  respondApproval() {
    return false
  }
  interrupt() {}
  async dispose() {}
  async detach() {}
}

class Adapter implements AgentAdapter {
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: true,
  }
  handles = new Map<string, Handle>()
  readonly tool: ToolName = 'claude'
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'fake' }
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    const h = new Handle(opts.sessionId, opts, emit)
    this.handles.set(opts.sessionId, h)
    return h
  }
}

const processes: AgentProcessHost = { spawn: () => new FakeProcess() }

let store: Store
let root: string
const hosts: SessionManager[] = []

beforeEach(() => {
  store = new Store()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-mail-turn-swap-')))
})
afterEach(async () => {
  for (const mgr of hosts.splice(0)) await mgr.disposeAll()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** One host of the mailbox: the manager, the turn records it keeps, and the claude adapter behind it */
function host(kept: ReadonlySet<string> = new Set()) {
  const claude = new Adapter()
  const events: NormalizedEvent[] = []
  const mgr = new SessionManager(store, new Map<ToolName, AgentAdapter>([['claude', claude]]), (e) => events.push(e), undefined, join(root, 'worktrees'), { processes, keptSessions: kept })
  mgr.prLookup = async () => null
  hosts.push(mgr)
  const mail = new MailService(store.mail, { hostId: () => 'hub-aaaaaaaa' })
  const turns = new MailTurns(store.mail, { keepOpen: (id) => mgr.keptInTurn(id) })
  mgr.useMail({
    sessionGone: () => {},
    sessionChanged: () => {},
    sessionEvent: (e, ended) => turns.observe(e, ended),
    delegated: delegationRecorder(mail, (id) => mgr.sessionInfo(id), turns),
    answered: answerRecorder(mail, store.mail),
    report: reportRecorder(mail, store.mail),
    waitingOn: (ownerId, childId) => mail.waitingOn(mail.sessionAddress(ownerId), mail.sessionAddress(childId)),
    turnStarted: turnRecorder(mail, store.mail, turns),
  })
  return { mgr, claude, mail, turns }
}

async function parentAndChild(h: ReturnType<typeof host>) {
  const project = await h.mgr.addProject(root)
  await h.mgr.setProjectTrusted(project.id, true)
  store.permissions.setProjectConsent(project.id, project.id, 'agents')
  const parent = (await h.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
  const started = await h.mgr.startAgent(parent, { task: 'long work', wait: false })
  if (!started.ok) throw new Error(started.error)
  return { parent, child: started.sessionId, project }
}

describe('a session the keeper handed over after a swap', () => {
  it('can still be mailed (the person’s reply is not refused) and is woken by the mail that was waiting for it', async () => {
    const a = host()
    const { child } = await parentAndChild(a)
    a.claude.handles.get(child)!.answer('first turn')
    // Mail written under the old host, still waiting when it leaves
    const waiting = a.mail.open('person', { kind: 'assign', subject: 'More', body: 'also run the linter', assignee: a.mail.sessionAddress(child) })
    await a.mgr.detachAll()

    const b = host(new Set([child]))
    await b.mgr.adoptKept([{ sessionId: child, tool: 'claude', process: new FakeProcess() }])
    // The process is one an earlier build started; the receive rule is the seat's, as for any other
    expect(b.mgr.canReadMail(child)).toBe(true)
    const policy = mailRelations({
      session: (id) => b.mgr.sessionInfo(id),
      ...b.mgr.mailSeats(() => true),
      inThread: (threadId, address) => store.mail.participants(threadId).some((p) => p.address === address && p.leftAt === null),
    })
    const mail = new MailService(store.mail, { hostId: () => 'hub-aaaaaaaa', policy, now: () => Date.now() + 10_000 })
    const reply = mail.post(waiting.thread.id, 'person', { kind: 'note', body: 'and the formatter' })
    expect(reply.message.body).toBe('and the formatter')
    const opened = mail.open('person', { kind: 'assign', subject: 'New', body: 'a new thread', assignee: mail.sessionAddress(child) })
    expect(opened.thread.assignee).toBe(mail.sessionAddress(child))

    const delivery = new MailDelivery(mail, store.mail, b.mgr.mailSessions(), { now: () => Date.now() + 60_000, schedule: () => () => {} })
    delivery.start()
    try {
      await delivery.process(mail.sessionAddress(child))
    } finally {
      delivery.stop()
    }
    const sent = b.claude.handles.get(child)!.sent
    expect(sent.some((t) => t.includes('also run the linter'))).toBe(true)
    expect(sent.some((t) => t.includes('and the formatter'))).toBe(true)
    expect(store.mail.receiptsOf(waiting.message.id)[0]).toMatchObject({ attempts: 1 })
  })
})

describe('an owner the keeper handed over after a swap', () => {
  it('hears of its child’s end by mail alone, like any other owner: no relayed message goes into its process', async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    await a.mgr.detachAll()

    const b = host(new Set([parent, child]))
    await b.mgr.adoptKept([
      { sessionId: parent, tool: 'claude', process: new FakeProcess() },
      { sessionId: child, tool: 'claude', process: new FakeProcess() },
    ])
    await b.mgr.send(child, 'carry on', undefined, { sessionId: parent, name: 'parent' })
    b.claude.handles.get(child)!.answer('all done')
    const reports = () => store.mail.messagesAfter(store.mail.threadsOfParty(b.mail.sessionAddress(parent), 'owner')[0]!.id, 0).filter((m) => m.kind === 'report' && m.sender === 'centralu')
    await until(() => store.mail.threadsOfParty(b.mail.sessionAddress(parent), 'owner').length > 0 && reports().length === 1)
    // The mailbox tells it; the relayed message that told a process of an earlier build is not sent
    await new Promise((r) => setTimeout(r, 30))
    expect(b.claude.handles.get(parent)!.sent.filter((t) => t.includes(`sourceSessionId: ${child}`))).toEqual([])
    // ... and the mailbox does wake it with the report: the mail is handed to the adopted process
    // (its own turn, which the swap kept, ends first: mail waits for a turn's end)
    b.claude.handles.get(parent)!.answer('its own turn ends')
    await until(() => b.mgr.mailSessions().receiver(parent).kind === 'ready')
    const later = new MailService(store.mail, { hostId: () => 'hub-aaaaaaaa', now: () => Date.now() + 300_000 })
    const delivery = new MailDelivery(later, store.mail, b.mgr.mailSessions(), { now: () => Date.now() + 300_000, schedule: () => () => {} })
    delivery.start()
    try {
      await delivery.process(b.mail.sessionAddress(parent))
    } finally {
      delivery.stop()
    }
    expect(store.mail.receiptsOf(reports()[0]!.id)[0]).toMatchObject({ attempts: 1 })
    expect(b.claude.handles.get(parent)!.sent.some((t) => t.includes("Centralu's mail"))).toBe(true)
  })
})

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 200 && !ok(); i++) await new Promise((r) => setTimeout(r, 10))
  if (!ok()) throw new Error('the condition did not come')
}
const marksOf = (h: ReturnType<typeof host>) => (h.mgr as unknown as { children: { awaitingReport: ReadonlyMap<string, string> } }).children.awaitingReport

describe('a parent that waits for what it handed on, across a swap', () => {
  it('keeps its mark with the swap, and its end is reported once, at the real end', async () => {
    const a = host()
    a.mgr.setUiPreferences({ agentDepth: 3 })
    const { parent, child } = await parentAndChild(a)
    const helper = await a.mgr.startAgent(child, { task: 'write the tests', wait: false })
    expect(helper.ok).toBe(true)
    a.claude.handles.get(child)!.answer('handed the tests on')
    const work = () => store.mail.threadsOfParty(a.mail.sessionAddress(parent), 'owner')[0]!
    const reports = () => store.mail.messagesAfter(work().id, 0).filter((m) => m.kind === 'report' && m.sender === 'centralu')
    await until(() => reports().length === 1)
    expect(reports()[0]!.facts).toMatchObject({ outcome: 'paused', waitingOn: [expect.any(String)] })
    expect(work().state).toBe('running')
    expect(marksOf(a).get(child)).toBe(parent)
    await a.mgr.detachAll()

    // The next host: the child's process is kept, at rest, and what it handed on is still going
    const b = host(new Set([child]))
    await b.mgr.adoptKept([{ sessionId: child, tool: 'claude', process: new FakeProcess() }])
    expect(marksOf(b).get(child)).toBe(parent)
    expect(work().state).toBe('running')
    // The helper is done; the session has a turn of its own, and ends it
    const handed = store.mail.threadsOfParty(b.mail.sessionAddress(child), 'owner')[0]!
    b.mail.update(handed.id, b.mail.sessionAddress(child), { state: 'done', outcome: 'finished' })
    await b.mgr.send(child, 'carry on', undefined, { sessionId: parent, name: 'parent' })
    b.claude.handles.get(child)!.answer('all done')
    await until(() => reports().length === 2)
    expect(reports().map((m) => m.facts.outcome)).toEqual(['paused', 'finished'])
    expect(work().state).toBe('review')
    expect(marksOf(b).has(child)).toBe(false)
    // Once: nothing follows
    await new Promise((r) => setTimeout(r, 30))
    expect(reports()).toHaveLength(2)
    // Nor a notice of a turn that "ended in the swap"
    expect(store.mail.messagesAfter(work().id, 0).some((m) => String(m.body).includes('swap'))).toBe(false)
  })

  it('a kept session at rest whose helper is gone has no pause to keep: its mark is dropped as before', async () => {
    const a = host()
    a.mgr.setUiPreferences({ agentDepth: 3 })
    const { parent, child } = await parentAndChild(a)
    await a.mgr.startAgent(child, { task: 'write the tests', wait: false })
    a.claude.handles.get(child)!.answer('handed the tests on')
    await until(() => marksOf(a).get(child) === parent && store.mail.threadsOfParty(a.mail.sessionAddress(child), 'owner').length === 1)
    // The helper's thread is going while its session is there
    expect(store.mail.waitingOnSessions(parent, child)).toBe(1)
    // The helper's session was archived while the old host served: nobody is on its thread
    a.mail.sessionGone(store.mail.threadsOfParty(a.mail.sessionAddress(child), 'owner')[0]!.assignee!.split('/')[1]!)
    await a.mgr.detachAll()
    const b = host(new Set([child]))
    await b.mgr.adoptKept([{ sessionId: child, tool: 'claude', process: new FakeProcess() }])
    expect(marksOf(b).has(child)).toBe(false)
  })
})

describe('a rollback to an earlier build, then forward', () => {
  it('closes the helper’s thread the earlier build finished: the parent’s next turn end is reported, not taken for the same pause', async () => {
    const a = host()
    a.mgr.setUiPreferences({ agentDepth: 3 })
    const { parent, child } = await parentAndChild(a)
    const helperStarted = await a.mgr.startAgent(child, { task: 'write the tests', wait: false })
    const helper = helperStarted.ok ? helperStarted.sessionId : ''
    a.claude.handles.get(child)!.answer('handed the tests on')
    const work = () => store.mail.threadsOfParty(a.mail.sessionAddress(parent), 'owner')[0]!
    const reports = () => store.mail.messagesAfter(work().id, 0).filter((m) => m.kind === 'report' && m.sender === 'centralu')
    await until(() => reports().length === 1)
    const part = store.mail.threadsOfParty(a.mail.sessionAddress(child), 'owner')[0]!
    expect(part).toMatchObject({ state: 'running', parentId: work().id })
    // The helper finishes. An earlier build serving instead of this one would report it the old way (its marks cleared) and leave the thread as it is
    a.claude.handles.get(helper)!.answer('the tests are written')
    await until(() => store.mail.thread(part.id)?.state === 'review')
    await a.mgr.detachAll()
    store.children.clearReportMark(helper)
    store.mail.updateThread(part.id, { state: 'running' }, Date.now(), false)

    // This build again: without the step, the parent still counts the helper as going
    const b = host(new Set([child]))
    await b.mgr.adoptKept([{ sessionId: child, tool: 'claude', process: new FakeProcess() }])
    expect(b.mail.waitingOn(b.mail.sessionAddress(parent), b.mail.sessionAddress(child))).toBe(1)
    const result = takeOverFromEarlierBuild(b.mail, store, { info: (id) => b.mgr.sessionInfo(id), depth: () => 0, paused: () => null })
    expect(result.closed).toBe(1)
    expect(store.mail.thread(part.id)?.state).toBe('review')
    expect(b.mail.waitingOn(b.mail.sessionAddress(parent), b.mail.sessionAddress(child))).toBe(0)

    // The owner sends more work, and the session ends its turn: the work's end is reported, once
    const again = b.mgr.agentSession(parent, { sessionId: child, action: 'send', text: 'and then?' })
    await until(() => (b.claude.handles.get(child)?.sent.length ?? 0) >= 1)
    b.claude.handles.get(child)!.answer('all done')
    expect(await again).toMatchObject({ ok: true })
    expect(reports().map((m) => m.facts.outcome)).toEqual(['paused', 'finished'])
    expect(work().state).toBe('review')
  })
})

describe('the turn of a session the keeper kept', () => {
  it('stays open across the swap, and its end is recorded by the next host; the open rows of the rest are closed lost', async () => {
    const a = host()
    const { child } = await parentAndChild(a)
    expect(store.mail.turnsOf(child)).toEqual([expect.objectContaining({ startedBy: 'caller', endedAt: null, threadId: expect.any(String) })])
    // A turn of a session that is not kept (its process went with the old host)
    store.mail.startTurn({ sessionId: 'gone-with-the-old-host', turnSeq: 1, threadId: null, startedBy: 'person', startedAt: 1 })
    await a.mgr.detachAll()

    const b = host(new Set([child]))
    await b.mgr.adoptKept([{ sessionId: child, tool: 'claude', process: new FakeProcess() }])
    // What the delivery does when it starts
    b.turns.closeStale()
    expect(store.mail.turnsOf(child)).toEqual([expect.objectContaining({ startedBy: 'caller', endedAt: null, outcome: null })])
    expect(store.mail.turnsOf('gone-with-the-old-host')).toEqual([expect.objectContaining({ outcome: 'lost' })])
    expect(b.turns.current(child)).toMatchObject({ by: 'caller' })

    b.claude.handles.get(child)!.answer('finished under the new host')
    expect(store.mail.turnsOf(child)).toEqual([expect.objectContaining({ startedBy: 'caller', outcome: 'empty' })])
    expect(store.mail.hasOpenTurn(store.mail.turnsOf(child)[0]!.threadId!)).toBe(false)
  })

  it('is closed lost when the session is not in its turn any more: it finished while the old host let go', async () => {
    const a = host()
    const { child } = await parentAndChild(a)
    a.claude.handles.get(child)!.answer('finished during the swap')
    // The old host did not see the end (a crash): the row is still open in the store
    store.mail.startTurn({ sessionId: child, turnSeq: 9, threadId: null, startedBy: 'caller', startedAt: 1 })
    await a.mgr.detachAll()
    const b = host(new Set([child]))
    await b.mgr.adoptKept([{ sessionId: child, tool: 'claude', process: new FakeProcess() }])
    b.turns.closeStale()
    expect(store.mail.turnsOf(child).find((t) => t.turnSeq === 9)).toMatchObject({ outcome: 'lost' })
  })
})
