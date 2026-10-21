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
import { delegationRecorder, turnRecorder } from '../mail/delegation.js'
import { MailDelivery } from '../mail/delivery.js'
import { mailRelations } from '../mail/relations.js'
import { MailService } from '../mail/service.js'
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
    // The process is one an earlier build started, so a report to its owner is told the relayed way; the receive rule is the seat's
    expect(b.mgr.readsMail(child)).toBe(false)
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
