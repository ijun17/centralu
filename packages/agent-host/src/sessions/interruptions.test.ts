import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import { INTERRUPTED_BY_TOOL, type AgentAdapter, type AgentProcess, type CreateSessionOpts, type EventSink, type SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { PERSON } from '../mail/address.js'
import { personReportRecorder, personWorkRecorder } from '../mail/delegation.js'
import { MailService } from '../mail/service.js'
import type { UpdateResumeFolder } from '../lifecycle/update-resume.js'
import { memoryUpdateFolder } from '../lifecycle/update-resume.test-helpers.js'
import { isNetworkFailure, RECONNECTING_FLAG_MS } from './interruptions.js'
import { SessionManager, type AgentProcessHost } from './manager.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * Sessions stopped by a network outage or a quit (#698). On 2026-10-15 the internet dropped twice while several child
 * sessions were working: the Claude children ended in `error` and needed a "continue" message by hand, and the
 * orchestrator that had started them was not told. A Codex child's interrupted turn was reported as finished, and a
 * full quit reset sessions mid-turn to `idle` with no mark in their conversation.
 */

describe('which failures the network caused', () => {
  it.each([
    // Claude Code, from the real store (2026-10-14/15)
    'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)',
    "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)",
    'API Error: No response from API (waited 3m). If a proxy or gateway on your network holds responses until they complete, raise API_TIMEOUT_MS',
    'API Error: Connection lost while your computer was asleep',
    'API Error: Your computer went to sleep mid-response. The response above may be incomplete.',
    'API Error: Request timed out.',
    // The CLI's own wording of a connection failure (claude-agent-sdk 0.3.263's bundled CLI)
    'API Error: fetch failed',
    'API Error: Connection dropped (ECONNRESET)',
    'API Error: Connection dropped (UND_ERR_SOCKET)',
    'API Error: No internet route — check your connection or VPN (ENETUNREACH)',
    'API Error: Unable to connect to API. Check your internet connection',
    'API Error: Request timed out. Check your internet connection and proxy settings',
    // Codex, the reasons host.log recorded for its reconnects
    'stream disconnected before completion: failed to lookup address information: nodename nor servname provided, or not known',
    'stream disconnected before completion: Transport error: network error: error decoding response body',
    'Reconnecting... waiting for network (Connection failed: error sending request)',
  ])('network: %s', (message) => {
    expect(isNetworkFailure(message)).toBe(true)
  })

  it.each([
    'unexpected status 401 Unauthorized: Unknown error, url: https://api.openai.com/v1/responses',
    "The 'opus[1m]' model is not supported",
    'Turn failed: error_max_turns',
    'Could not stop: the turn already ended',
    // A crash's message ends with whatever the process printed last: a word there says nothing of the turn
    'Claude Code process exited with code 1. stderr: TypeError: fetch failed (ECONNREFUSED)',
    // Generic words outside the API's own sentences: an MCP server, a dev server the agent ran
    'MCP error -32000: Connection closed',
    // A certificate or proxy setting: continuing fails the same way until the person fixes it
    'API Error: Unable to connect to API: SSL certificate verification failed. Check your proxy or corporate SSL certificates',
    // fetch failed from a tool, not from the API call
    'WebFetch: fetch failed for https://example.com',
    'Bash failed: network error while installing packages',
  ])('not the network, since continuing would fail the same way: %s', (message) => {
    expect(isNetworkFailure(message)).toBe(false)
  })
})

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
    readonly emit: EventSink,
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
  /** A turn the CLI opened by itself (a Monitor firing), which then fails as Claude Code fails after its retries */
  ownTurnFails(message: string) {
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text: 'checking the build' })
    this.emit({ type: 'error', sessionId: this.sessionId, error: { code: 'internal', message, retryable: true } })
  }
  respondApproval() {
    return false
  }
  interrupt() {}
  async dispose() {}
}

class Adapter implements AgentAdapter {
  descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false,
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

const processes: AgentProcessHost = { spawn: () => new FakeProcess() as unknown as AgentProcess }
const ECONNREFUSED = 'API Error: Connection refused — a firewall or proxy may be blocking it (ECONNREFUSED)'

let store: Store
let root: string
let events: NormalizedEvent[]
const hosts: SessionManager[] = []

beforeEach(() => {
  store = new Store()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-interruptions-')))
  events = []
})
afterEach(async () => {
  vi.useRealTimers()
  for (const mgr of hosts.splice(0)) await mgr.disposeAll()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** `updateResume`: the data folder's lists of the turns an update cut (#1618, lifecycle/update-resume.ts) */
function host(o: { updateResume?: UpdateResumeFolder } = {}) {
  const claude = new Adapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', claude]])
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, join(root, 'worktrees'), {
    processes,
    keptSessions: new Set(),
    ...(o.updateResume ? { updateResume: o.updateResume } : {}),
  })
  mgr.prLookup = async () => null
  hosts.push(mgr)
  return { mgr, claude }
}

async function parentAndChild(h: ReturnType<typeof host>) {
  const project = await h.mgr.addProject(root)
  h.mgr.setProjectTrusted(project.id, true)
  store.permissions.setProjectConsent(project.id, project.id, 'agents')
  const parent = (await h.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
  const started = await h.mgr.startAgent(parent, { task: 'fix the sidebar indent', wait: false })
  if (!started.ok) throw new Error(started.error)
  return { parent, child: started.sessionId, project }
}

/** The report texts stored in the parent's conversation that name the child */
const reportsTo = (parent: string, child: string) =>
  store.messages.loadMessages(parent, 50).map((m) => JSON.stringify(m.payload)).filter((t) => t.includes('[Centralu] The assigned work') && t.includes(child))
/** The start's quit notices are taken on its first timer tick; this waits past it */
const startNoticesRan = () => new Promise<void>((r) => setTimeout(() => setImmediate(r), 0))
/** The host.log lines saying an asker is told of a stop; the decision is taken with the event that ended the turn */
const toldLines = (log: { mock: { calls: unknown[][] } }) => log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('no report was owed for; telling'))
const info = (h: ReturnType<typeof host>, id: string) => h.mgr.listSessions().find((s) => s.id === id)!
const interruptions = (id: string) => events.filter((e) => e.type === 'interruption' && e.sessionId === id)

describe('a turn the network stopped (#698)', () => {
  it("2026-10-15: a child's own turn fails with ECONNREFUSED; it is marked network and its asker is told, though no report was owed", async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    const kid = a.claude.handles.get(child)!
    // The work it was given finished and was reported; the mark is gone
    kid.answer('waiting on pnpm verify with a Monitor')
    await eventually(() => reportsTo(parent, child).length === 1)
    expect(store.children.listReportMarks()).toEqual([])

    kid.ownTurnFails(ECONNREFUSED)
    expect(info(a, child)).toMatchObject({ state: 'error', interruption: { reason: 'network', detail: ECONNREFUSED } })
    // A window reads the error first, then why
    const types = events.filter((e) => e.sessionId === child).map((e) => e.type)
    expect(types.lastIndexOf('interruption')).toBeGreaterThan(types.lastIndexOf('error'))
    expect(interruptions(child).at(-1)).toMatchObject({ interruption: { reason: 'network' } })

    await eventually(() => reportsTo(parent, child).length === 2)
    const told = reportsTo(parent, child)[1]!
    expect(told).toContain('stopped before finishing: a network error ended its turn')
    expect(told).toContain('ECONNREFUSED')
    // The same sentence the person's Continue sends
    expect(told).toContain('Continue where you stopped. Check what already happened before repeating a step.')
    expect(told).not.toContain('The assigned work finished')
    expect(a.claude.handles.get(parent)!.sent.filter((t) => t.includes(`sourceSessionId: ${child}`))).toHaveLength(2)
  })

  it('a report that was owed says the network stopped it, not that the work failed', async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    a.claude.handles.get(child)!.emit({ type: 'error', sessionId: child, error: { code: 'internal', message: ECONNREFUSED, retryable: true } })
    await eventually(() => reportsTo(parent, child).length === 1)
    expect(reportsTo(parent, child)[0]).toContain('stopped before finishing: a network error ended its turn')
    expect(reportsTo(parent, child)[0]).not.toContain('The assigned work failed')
  })

  it('is kept across a restart, and cleared when the session works again', async () => {
    const a = host()
    const project = await a.mgr.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    await a.mgr.send(s.id, 'go')
    a.claude.handles.get(s.id)!.ownTurnFails(ECONNREFUSED)
    expect(store.sessions.listSessions().find((x) => x.id === s.id)?.interruption).toMatchObject({ reason: 'network' })

    await a.mgr.send(s.id, 'Continue where you stopped.')
    expect(info(a, s.id).interruption).toBeNull()
    expect(interruptions(s.id).at(-1)).toMatchObject({ interruption: null })
    expect(store.sessions.listSessions().find((x) => x.id === s.id)?.interruption).toBeNull()
  })

  it('an error the network did not cause leaves no interruption, and nobody unasked is told', async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    const kid = a.claude.handles.get(child)!
    kid.answer('done')
    await eventually(() => reportsTo(parent, child).length === 1)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Put back after this test, or every later test in the file writes its errors nowhere (#845)
    onTestFinished(() => log.mockRestore())
    kid.ownTurnFails('unexpected status 401 Unauthorized')
    expect(info(a, child)).toMatchObject({ state: 'error', interruption: null })
    // The decision to tell is taken with the event: nothing was decided now, so nothing is on its way
    expect(toldLines(log)).toEqual([])
    expect(reportsTo(parent, child)).toHaveLength(1)
  })
})

/** A parent that starts a child and waits for its answer in the same call */
async function waitingParent(h: ReturnType<typeof host>) {
  const project = await h.mgr.addProject(root)
  h.mgr.setProjectTrusted(project.id, true)
  store.permissions.setProjectConsent(project.id, project.id, 'agents')
  const parent = (await h.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
  const call = h.mgr.startAgent(parent, { task: 'fix the sidebar indent', wait: true })
  await eventually(() => h.claude.handles.size === 2)
  const child = [...h.claude.handles.keys()].find((id) => id !== parent)!
  await eventually(() => (h.claude.handles.get(child)?.sent.length ?? 0) > 0)
  return { parent, child, call }
}

describe('a caller waiting on the turn (#698)', () => {
  it('reads the network failure from its own wait, and is not told a second time', async () => {
    const a = host()
    const { parent, child, call } = await waitingParent(a)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Put back after this test, or every later test in the file writes its errors nowhere (#845)
    onTestFinished(() => log.mockRestore())
    a.claude.handles.get(child)!.emit({ type: 'error', sessionId: child, error: { code: 'internal', message: ECONNREFUSED, retryable: true } })
    expect(toldLines(log)).toEqual([])
    const r = await call
    expect(JSON.stringify(r)).toContain('ECONNREFUSED')
    expect(reportsTo(parent, child)).toEqual([])
  })

  it("stops waiting when the tool interrupts the turn: no turn_complete follows an interrupt now", async () => {
    const a = host()
    const { child, call } = await waitingParent(a)
    a.claude.handles.get(child)!.emit({ type: 'state_change', sessionId: child, state: 'waiting_input', reason: INTERRUPTED_BY_TOOL })
    const r = await call
    expect(JSON.stringify(r)).toContain('its tool interrupted the turn before it finished')
  })
})

describe('errors that did not end a running turn (#698)', () => {
  it('a crash is not a network stop, whatever its stderr says', async () => {
    const a = host()
    const project = await a.mgr.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    await a.mgr.send(s.id, 'go')
    a.claude.handles.get(s.id)!.emit({ type: 'error', sessionId: s.id, error: { code: 'adapter_crashed', message: `${ECONNREFUSED}. stderr: fetch failed`, retryable: true } })
    expect(info(a, s.id).interruption ?? null).toBeNull()
    expect(interruptions(s.id)).toEqual([])
  })

  it('an error at rest stops no turn, so it offers nothing to continue', async () => {
    const a = host()
    const project = await a.mgr.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    await a.mgr.send(s.id, 'go')
    a.claude.handles.get(s.id)!.answer('done')
    a.claude.handles.get(s.id)!.emit({ type: 'error', sessionId: s.id, error: { code: 'internal', message: ECONNREFUSED, retryable: true } })
    expect(info(a, s.id)).toMatchObject({ state: 'error', interruption: null })
    expect(interruptions(s.id)).toEqual([])
  })
})

describe('a turn its tool interrupted (#698)', () => {
  it('is reported to the orchestrator as stopped before finishing, never as finished', async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    a.claude.handles.get(child)!.emit({ type: 'state_change', sessionId: child, state: 'waiting_input', reason: INTERRUPTED_BY_TOOL })
    await eventually(() => reportsTo(parent, child).length === 1)
    expect(reportsTo(parent, child)[0]).toContain('stopped before finishing: its tool interrupted the turn')
    // Nothing to do with the network: no waiting for it
    expect(reportsTo(parent, child)[0]).toContain('send it a message to go on, the same one')
    expect(reportsTo(parent, child)[0]).not.toContain('network')
    expect(info(a, child).interruption).toMatchObject({ reason: 'interrupted' })
  })

  it("the person's Stop is not an interruption to flag: they know", async () => {
    const a = host()
    const project = await a.mgr.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    await a.mgr.send(s.id, 'go')
    a.claude.handles.get(s.id)!.emit({ type: 'state_change', sessionId: s.id, state: 'waiting_input', reason: 'interrupted' })
    expect(info(a, s.id).interruption ?? null).toBeNull()
    expect(interruptions(s.id)).toEqual([])
  })
})

describe('a turn a quit stopped (#698)', () => {
  it('a start that resets a session mid-turn to idle leaves a line in its conversation and marks it quit', async () => {
    const a = host()
    const project = await a.mgr.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    await a.mgr.send(s.id, 'a long job')
    expect(store.sessions.listSessions().find((x) => x.id === s.id)?.state).toBe('working')

    // "Quit completely": the process is gone, and the next start finds the row still working
    const b = host()
    expect(info(b, s.id)).toMatchObject({ state: 'idle', interruption: { reason: 'quit' } })
    const last = store.messages.loadMessages(s.id, 5).at(-1)!
    expect(last.payload).toMatchObject({ type: 'notice', level: 'warning', from: 'Centralu' })
    expect(JSON.stringify(last.payload)).toContain('Centralu quit or restarted while this turn was running')
    expect(info(b, s.id).lastSeq).toBe(last.seq)
  })

  it('work the person owns (a script started the session, §8.1): the next start reports the quit to their Inbox and closes the thread', async () => {
    const a = host()
    const project = await a.mgr.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    const mail = new MailService(store.mail, { hostId: () => 'hub-aaaaaaaa' })
    personWorkRecorder(mail, () => ({ projectId: project.id, depth: 0 }))(s.id, 'a long job')
    await a.mgr.send(s.id, 'a long job')
    expect(mail.personOwes(mail.sessionAddress(s.id))).toBe(true)

    const b = host()
    // The mailbox is wired in the same tick as the host is made, before the start's first moment
    b.mgr.useMail({
      sessionGone: () => {},
      sessionChanged: () => {},
      sessionEvent: () => {},
      personWork: {
        started: personWorkRecorder(mail, () => ({ projectId: project.id, depth: 0 })),
        owes: (id) => mail.personOwes(mail.sessionAddress(id)),
        report: personReportRecorder(mail, store.mail),
      },
    })
    const thread = () => store.mail.latestBetween(PERSON, mail.sessionAddress(s.id))!
    await eventually(() => thread().state === 'review')
    const report = store.mail.messagesAfter(thread().id, 0).find((m) => m.sender === 'centralu' && m.kind === 'report')!
    expect(report.facts).toMatchObject({ outcome: 'quit' })
    expect(report.body).toContain('Centralu quit or restarted during its turn')
    expect(mail.personOwes(mail.sessionAddress(s.id))).toBe(false)
    // The start after that finds the session at rest and says nothing more
    host()
    await startNoticesRan()
    expect(store.mail.messagesAfter(thread().id, 0).filter((m) => m.sender === 'centralu' && m.kind === 'report')).toHaveLength(1)
  })

  it('a session at rest is left alone by the next start', async () => {
    const a = host()
    const project = await a.mgr.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    await a.mgr.send(s.id, 'short')
    a.claude.handles.get(s.id)!.answer('done')
    const before = store.messages.loadMessages(s.id, 10).length
    const b = host()
    expect(info(b, s.id)).toMatchObject({ state: 'waiting_input', interruption: null })
    expect(store.messages.loadMessages(s.id, 10)).toHaveLength(before)
  })

  it('the next start tells an asker that delegated without waiting, once per child, and only while the asker exists', async () => {
    const a = host()
    const { parent, child, project } = await parentAndChild(a)
    // A second child whose asker is deleted before the quit: nobody is left to tell
    const gone = (await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
    const orphan = await a.mgr.startAgent(gone, { task: 'other work', wait: false })
    if (!orphan.ok) throw new Error(orphan.error)
    await a.mgr.trashSession(gone)

    const b = host()
    await eventually(() => reportsTo(parent, child).length === 1)
    expect(reportsTo(parent, child)[0]).toContain('stopped before finishing: Centralu quit or restarted during its turn')
    expect(reportsTo(parent, child)[0]).not.toContain('network')
    expect(info(b, orphan.sessionId).interruption).toMatchObject({ reason: 'quit' })

    // The child is at rest now: the start after that tells nobody again, once its notices have had their moment
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Put back after this test, or every later test in the file writes its errors nowhere (#845)
    onTestFinished(() => log.mockRestore())
    host()
    await startNoticesRan()
    expect(toldLines(log)).toEqual([])
    expect(reportsTo(parent, child)).toHaveLength(1)
  })

  it('a requester the same quit cut is not woken at launch: its own Continue covers its children', async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    // The orchestrator was mid-turn too, waiting on its child, when the app quit
    await a.mgr.send(parent, 'keep going while the child works')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Put back after this test, or every later test in the file writes its errors nowhere (#845)
    onTestFinished(() => log.mockRestore())
    const b = host()
    await startNoticesRan()
    expect(toldLines(log)).toEqual([])
    expect(reportsTo(parent, child)).toEqual([])
    // Nothing resumed it, so its own stop is still there for the person to see and continue
    expect(b.claude.handles.has(parent)).toBe(false)
    expect(info(b, parent)).toMatchObject({ state: 'idle', interruption: { reason: 'quit' } })
    expect(info(b, child).interruption).toMatchObject({ reason: 'quit' })
  })

  it('when the session owed the report is gone, the notice falls back to the turn giver, then the one that started it', async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    // The report is owed to a session deleted since; the child was started by the parent
    store.children.setReportMark(child, 'a-session-deleted-since')
    host()
    await eventually(() => reportsTo(parent, child).length === 1)
    expect(reportsTo(parent, child)[0]).toContain('Centralu quit or restarted during its turn')
  })

  it("the orchestrator's list says which children stopped and why", async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    const b = host()
    expect(info(b, child).interruption).toMatchObject({ reason: 'quit' })
    const r = await b.mgr.runOrchestratorTool(parent, 'read_session', {})
    const row = r.text.split('\n').find((l) => l.includes(child))!
    expect(row).toContain('stopped: Centralu quit during its turn')
  })
})

/*
 * #1618 (owner, 2026-10-26): a linked hub's update no longer waits for the turns on a machine. The host it stops lists the
 * sessions in a turn as it lets them go (`host.stop { forUpdate }`), and the host it starts continues each of those turns
 * once, as the person's Continue would, through Centralu's channel. On 2026-10-26 the hub updated a linked Windows machine
 * at once with two children in a turn: both turns ended, and their parent had to send each a note by hand to carry on
 */
describe("a turn a linked hub's update cut (#1618)", () => {
  /** What went into the session's process since it was continued: Centralu's note, never a message of the person's */
  const sentTo = (h: ReturnType<typeof host>, id: string) => h.claude.handles.get(id)?.sent ?? []
  const lines = (id: string) => store.messages.loadMessages(id, 50).map((m) => JSON.stringify(m.payload))
  /** The data folder's lists of the turns an update cut, played by a map */
  const folder = memoryUpdateFolder
  /** The hub's update stops the host: what is in a turn is listed as the sessions are let go of */
  const stopForUpdate = async (h: ReturnType<typeof host>) => {
    h.mgr.stopForUpdate()
    await h.mgr.disposeAll()
  }

  it("is listed by the stop, continued once with Centralu's note; its parent hears it goes on, and the report is the continued turn's end", async () => {
    const f = folder()
    const a = host({ updateResume: f })
    const { parent, child } = await parentAndChild(a)
    expect(info(a, child).state).toBe('working')
    await stopForUpdate(a)
    // The turn the stop ended, and only it (the parent was at rest), with where its conversation ended then
    const listedAt = store.messages.nextSeq(child) - 1
    expect(f.turns()).toEqual([{ id: child, seq: listedAt }])

    const b = host({ updateResume: f })
    // A hub reading the machine before the note went in sees a turn running, not one that ended
    expect(info(b, child)).toMatchObject({ state: 'working' })
    expect(info(b, child).interruption ?? null).toBeNull()
    // And a hub whose link is back before the note went in is told the turn goes on: named from the start (#1626 review)
    expect(sentTo(b, child)).toHaveLength(0)
    expect(b.mgr.updateContinued().map((c) => c.sessionId)).toEqual([child])
    await eventually(() => sentTo(b, child).length === 1)
    expect(sentTo(b, child)[0]).toContain('Centralu on this machine was updated while your turn was running')
    expect(sentTo(b, child)[0]).toContain('Continue where you stopped. Check what already happened before repeating a step.')
    // Sent: its list goes
    await eventually(() => f.ids() === null)
    // And the conversation is past the listed row: a list left behind could name no later turn (#1626 review 1b)
    expect(store.messages.nextSeq(child) - 1).toBeGreaterThan(listedAt)
    expect(b.mgr.updateContinued().map((c) => c.sessionId)).toEqual([child])
    // Not the person's message: no user row, and the line says what happened
    expect(store.messages.loadMessages(child, 50).filter((m) => m.role === 'user')).toHaveLength(1)
    expect(lines(child).some((l) => l.includes('Centralu was updated during this turn, which stopped it; Centralu continued it'))).toBe(true)
    expect(lines(child).some((l) => l.includes('Centralu quit or restarted while this turn was running'))).toBe(false)

    // The parent is told once that the turn goes on, not that it stopped
    await eventually(() => reportsTo(parent, child).length === 1)
    expect(reportsTo(parent, child)[0]).toContain('cut short by an update of Centralu on its machine, and Centralu continued it there')
    expect(reportsTo(parent, child)[0]).toContain('Its report follows when that turn ends')
    expect(reportsTo(parent, child)[0]).not.toContain('stopped before finishing')

    // The continued turn's end is the report, once
    b.claude.handles.get(child)!.answer('Sidebar indent fixed.')
    await eventually(() => reportsTo(parent, child).length === 2)
    expect(reportsTo(parent, child)[1]).toContain('The assigned work finished')
    await startNoticesRan()
    expect(reportsTo(parent, child)).toHaveLength(2)
    expect(sentTo(b, child)).toHaveLength(1)
  })

  it('a host stopped again before the Continue went in leaves the turn listed, and the one after it continues it once (#1618 review D2)', async () => {
    const f = folder()
    const a = host({ updateResume: f })
    const { child } = await parentAndChild(a)
    await stopForUpdate(a)
    // The new version's host comes up, then is stopped at once (its check failed, and the update puts the old one back)
    const b = host({ updateResume: f })
    await stopForUpdate(b)
    expect(sentTo(b, child)).toHaveLength(0)
    expect(f.ids()).toEqual([child])
    const c = host({ updateResume: f })
    await eventually(() => sentTo(c, child).length === 1)
    await eventually(() => f.ids() === null)
    // And a start after that finds nothing listed and sends nothing again
    c.claude.handles.get(child)!.answer('done')
    await c.mgr.disposeAll()
    const d = host({ updateResume: f })
    await startNoticesRan()
    await new Promise((r) => setTimeout(r, 50))
    expect(d.claude.handles.has(child)).toBe(false)
  })

  it('a list left behind (a file held open when it was to go) continues no later turn there (#1626 review)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const f = folder()
    const a = host({ updateResume: f })
    const { child } = await parentAndChild(a)
    await stopForUpdate(a)
    // A virus scanner holds the list when the next host is done with it: it cannot be removed
    const remove = f.remove
    f.remove = () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    }
    const b = host({ updateResume: f })
    await eventually(() => sentTo(b, child).length === 1)
    expect(f.ids()).toEqual([child])
    b.claude.handles.get(child)!.answer('Sidebar indent fixed.')
    await eventually(() => info(b, child).state !== 'working')
    // Later the person gives it a new turn, and their own stop (a quit, `serve --stop`) cuts it
    await b.mgr.send(child, 'now the header')
    await b.mgr.disposeAll()
    f.remove = remove
    const c = host({ updateResume: f })
    // A quit's turn, told as one: not continued, not said to be an update's
    expect(info(c, child)).toMatchObject({ state: 'idle', interruption: { reason: 'quit' } })
    await startNoticesRan()
    await new Promise((r) => setTimeout(r, 50))
    expect(c.claude.handles.has(child)).toBe(false)
    expect(lines(child).filter((l) => l.includes('Centralu continued it'))).toHaveLength(1)
    // And the list that names the turn long over goes now
    expect(f.ids()).toBeNull()
  })

  it('a list a virus scanner holds for a moment when the next host starts is read again, and its turn is continued (#1626 review)', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    const f = folder()
    const a = host({ updateResume: f })
    const { child } = await parentAndChild(a)
    await stopForUpdate(a)
    // Held under FileShare.None when the next host reads it (EBUSY), free a moment later
    const read = f.read
    let held = 2
    f.read = (name) => {
      if (held-- > 0) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      return read(name)
    }
    const b = host({ updateResume: f })
    // Not a quit's: working all the while, and one Continue goes in
    expect(info(b, child)).toMatchObject({ state: 'working' })
    await eventually(() => sentTo(b, child).length === 1)
    expect(said.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('EBUSY') && l.includes('reading it again'))).toHaveLength(2)
    await eventually(() => f.ids() === null)
  })

  it('a list a host from before #1618 never read (a rollback) continues no turn that host or a later stop began (#1626 review)', async () => {
    const f = folder()
    const a = host({ updateResume: f })
    const { child } = await parentAndChild(a)
    await stopForUpdate(a)
    // Rolled back to a host that knows no list: the turn ends as a quit's there, and the person continues it by hand
    const old = host()
    expect(info(old, child)).toMatchObject({ state: 'idle', interruption: { reason: 'quit' } })
    await old.mgr.send(child, 'Continue')
    // Updated again by hand: the person's stop of that host cuts the turn they gave it
    await old.mgr.disposeAll()
    const b = host({ updateResume: f })
    expect(info(b, child)).toMatchObject({ state: 'idle', interruption: { reason: 'quit' } })
    await startNoticesRan()
    await new Promise((r) => setTimeout(r, 50))
    expect(b.claude.handles.has(child)).toBe(false)
    expect(f.ids()).toBeNull()
  })

  it('a list that cannot be written is said with the error, and those turns end as a stop\'s always did', async () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    const f = folder()
    f.add = () => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    }
    const a = host({ updateResume: f })
    const { parent, child } = await parentAndChild(a)
    await stopForUpdate(a)
    expect(said.mock.calls.map((c) => String(c[0])).some((l) => l.includes('could not be listed') && l.includes('EPERM: operation not permitted'))).toBe(true)
    const b = host({ updateResume: f })
    expect(info(b, child)).toMatchObject({ state: 'idle', interruption: { reason: 'quit' } })
    await eventually(() => reportsTo(parent, child).length === 1)
    expect(reportsTo(parent, child)[0]).toContain('Centralu quit or restarted')
  })

  it('a Continue the tool takes while a second update stops the host is left to the next host, which continues and tells it once (#1626 review)', async () => {
    const f = folder()
    const a = host({ updateResume: f })
    const { parent, child } = await parentAndChild(a)
    await stopForUpdate(a)
    const b = host({ updateResume: f })
    // The tool takes the note late: after the second update's stop began
    let accept: (() => void) | undefined
    const create = b.claude.createSession.bind(b.claude)
    b.claude.createSession = async (opts, emit) => {
      const h = await create(opts, emit)
      if (opts.sessionId !== child) return h
      return Object.assign(h, {
        sendTracked: (text: string, observer?: { accepted?: () => void }) => {
          h.send(text)
          return new Promise<void>((r) => {
            accept = () => {
              observer?.accepted?.()
              r()
            }
          })
        },
      })
    }
    await eventually(() => accept !== undefined)
    const stopping = stopForUpdate(b)
    accept!()
    await stopping
    // A host leaving settles nothing: the first stop's list stays, and its own stop lists the turn again, the note included
    expect(reportsTo(parent, child)).toHaveLength(0)
    expect(f.files.size).toBe(2)
    expect(f.ids()).toEqual([child])
    // The next host continues it, and its parent hears it once
    const c = host({ updateResume: f })
    await eventually(() => sentTo(c, child).length === 1)
    await eventually(() => reportsTo(parent, child).length === 1)
    expect(reportsTo(parent, child)[0]).toContain('Centralu continued it there')
    await eventually(() => f.ids() === null)
    await startNoticesRan()
    expect(reportsTo(parent, child)).toHaveLength(1)
    // The conversation shows one Continue: the leaving host wrote no line of its own for the note it handed over late
    expect(lines(child).filter((l) => l.includes('Centralu continued it'))).toHaveLength(1)
  })

  it('a host that starts to leave while the session wakes sends it no note, and the next host sends the one (#1626 review)', async () => {
    const f = folder()
    const a = host({ updateResume: f })
    const { parent, child } = await parentAndChild(a)
    await stopForUpdate(a)
    const b = host({ updateResume: f })
    // The tool is slow to start the process: a second update's stop begins meanwhile
    let release: (() => void) | undefined
    const create = b.claude.createSession.bind(b.claude)
    b.claude.createSession = async (opts, emit) => {
      if (opts.sessionId === child) await new Promise<void>((r) => (release = r))
      return create(opts, emit)
    }
    await eventually(() => release !== undefined)
    const stopping = stopForUpdate(b)
    release!()
    await stopping
    expect(sentTo(b, child)).toHaveLength(0)
    expect(lines(child).filter((l) => l.includes('Centralu continued it'))).toHaveLength(0)
    const c = host({ updateResume: f })
    await eventually(() => sentTo(c, child).length === 1)
    await eventually(() => reportsTo(parent, child).length === 1)
    expect(lines(child).filter((l) => l.includes('Centralu continued it'))).toHaveLength(1)
  })

  it('lists only what is in a turn when the host stops: not a session the person stopped, nor one at rest; a stop not for an update lists nothing', async () => {
    const f = folder()
    const a = host({ updateResume: f })
    const project = await a.mgr.addProject(root)
    const open = async () => (await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
    const [cut, stopped, rest] = [await open(), await open(), await open()]
    for (const id of [cut, stopped]) await a.mgr.send(id, 'a long job')
    // The person's Stop, which the host took before the update stopped it
    a.claude.handles.get(stopped)!.emit({ type: 'state_change', sessionId: stopped, state: 'waiting_input', reason: 'interrupted' })
    await stopForUpdate(a)
    expect(f.ids()).toEqual([cut])
    const b = host({ updateResume: f })
    await eventually(() => sentTo(b, cut).length === 1)
    await startNoticesRan()
    expect(b.claude.handles.has(stopped)).toBe(false)
    expect(b.claude.handles.has(rest)).toBe(false)
    expect(info(b, stopped)).toMatchObject({ state: 'waiting_input' })
    expect(lines(stopped).some((l) => l.includes('Centralu continued it'))).toBe(false)

    // The person's own stop (a quit, `serve --stop`) with the continued turn running: listed for no one, it ends as before
    await b.mgr.disposeAll()
    expect(f.ids()).toBeNull()
    const c = host({ updateResume: f })
    expect(info(c, cut)).toMatchObject({ state: 'idle', interruption: { reason: 'quit' } })
  })

  it('a wake before the Continue went in (a window that sees the machine back) keeps the turn, and the Continue goes in once (#1618 review D4)', async () => {
    const f = folder()
    const a = host({ updateResume: f })
    const { parent, child } = await parentAndChild(a)
    await stopForUpdate(a)
    const from = events.length
    const b = host({ updateResume: f })
    // The window's wake, in the same moment as the start's own Continue
    const woken = b.mgr.resumeSession(child)
    await eventually(() => sentTo(b, child).length === 1)
    expect((await woken).resumed).toBe(true)
    await startNoticesRan()
    await new Promise((r) => setTimeout(r, 50))
    expect(sentTo(b, child)).toHaveLength(1)
    // Never at rest in between, which a hub would read as the turn's end
    const states = events.slice(from).flatMap((e) => (e.type === 'state_change' && e.sessionId === child ? [e.state] : []))
    expect(states.every((s) => s === 'working')).toBe(true)
    await eventually(() => reportsTo(parent, child).length === 1)
    expect(reportsTo(parent, child)[0]).toContain('Centralu continued it there')
  })

  it("work the person owns is not reported to their Inbox as stopped: its one report is the continued turn's end (#1618 review D3)", async () => {
    const f = folder()
    const a = host({ updateResume: f })
    const project = await a.mgr.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    const mail = new MailService(store.mail, { hostId: () => 'hub-aaaaaaaa' })
    personWorkRecorder(mail, () => ({ projectId: project.id, depth: 0 }))(s.id, 'a long job')
    await a.mgr.send(s.id, 'a long job')
    await stopForUpdate(a)

    const b = host({ updateResume: f })
    // The mailbox is wired in the same tick as the host is made, before the start's first moment
    b.mgr.useMail({
      sessionGone: () => {},
      sessionChanged: () => {},
      sessionEvent: () => {},
      personWork: {
        started: personWorkRecorder(mail, () => ({ projectId: project.id, depth: 0 })),
        owes: (id) => mail.personOwes(mail.sessionAddress(id)),
        report: personReportRecorder(mail, store.mail),
      },
    })
    const reports = () =>
      store.mail.messagesAfter(store.mail.latestBetween(PERSON, mail.sessionAddress(s.id))!.id, 0).filter((m) => m.sender === 'centralu' && m.kind === 'report')
    await eventually(() => sentTo(b, s.id).length === 1)
    await startNoticesRan()
    expect(reports()).toHaveLength(0)
    expect(mail.personOwes(mail.sessionAddress(s.id))).toBe(true)
    b.claude.handles.get(s.id)!.answer('done')
    await eventually(() => reports().length === 1)
    expect(reports()[0]!.facts).not.toMatchObject({ outcome: 'quit' })
  })

  it("one that cannot be continued ends as a quit's does: marked stopped, its parent told, and it leaves the list", async () => {
    const f = folder()
    const a = host({ updateResume: f })
    const { parent, child } = await parentAndChild(a)
    await stopForUpdate(a)
    const listedAt = store.messages.nextSeq(child) - 1
    const b = host({ updateResume: f })
    // Taken as going on at the start, until the wake fails
    expect(info(b, child)).toMatchObject({ state: 'working' })
    // Its tool cannot start it again on the new version; its parent's can
    const create = b.claude.createSession.bind(b.claude)
    b.claude.createSession = async (opts, emit) => {
      if (opts.sessionId === child) throw new Error('its conversation is gone there')
      return create(opts, emit)
    }
    await eventually(() => info(b, child).state === 'idle')
    expect(info(b, child).interruption).toMatchObject({ reason: 'quit' })
    await eventually(() => reportsTo(parent, child).length === 1)
    expect(reportsTo(parent, child)[0]).toContain('stopped before finishing: Centralu quit or restarted during its turn')
    expect(reportsTo(parent, child)[0]).not.toContain('continued it there')
    expect(f.ids()).toBeNull()
    // The stopped mark is a row too: past the listed one (#1626 review 1b)
    expect(store.messages.nextSeq(child) - 1).toBeGreaterThan(listedAt)
    // No longer named to a hub as going on
    expect(b.mgr.updateContinued()).toEqual([])
  })
})

describe('the session a report names', () => {
  it('is named as read_session lists it, whichever way the turn ended', async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    // A resumed conversation's name is its compaction summary's first line, which the orchestrator's list never shows
    a.mgr.rename(child, 'This session is being continued from a previous conversation that ran out of context.')
    const listed = (await a.mgr.runOrchestratorTool(parent, 'read_session', {})).text
    expect(listed).toContain('(resumed session)')
    const kid = a.claude.handles.get(child)!
    kid.answer('done')
    await eventually(() => reportsTo(parent, child).length === 1)
    kid.ownTurnFails(ECONNREFUSED)
    await eventually(() => reportsTo(parent, child).length === 2)
    for (const report of reportsTo(parent, child)) {
      expect(report).not.toContain('This session is being continued')
      expect(report).toContain('(resumed session)')
    }
  })
})

describe('a tool reconnecting for too long (#698)', () => {
  async function working(a: ReturnType<typeof host>) {
    const project = await a.mgr.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    await a.mgr.send(s.id, 'go')
    return { id: s.id, h: a.claude.handles.get(s.id)! }
  }

  it('is flagged once `retrying` outlasts the bound, and the flag goes when output flows again', async () => {
    const a = host()
    const { id, h } = await working(a)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Put back after this test, or every later test in the file writes its errors nowhere (#845)
    onTestFinished(() => quiet.mockRestore())
    h.emit({ type: 'activity', sessionId: id, activity: 'retrying' })
    vi.advanceTimersByTime(RECONNECTING_FLAG_MS - 1000)
    expect(interruptions(id)).toEqual([])
    vi.advanceTimersByTime(2000)
    expect(info(a, id)).toMatchObject({ state: 'working', interruption: { reason: 'reconnecting' } })
    // Live only: not stored
    expect(store.sessions.listSessions().find((x) => x.id === id)?.interruption).toBeNull()

    // Other events of the same episode keep the flag and when it began
    h.emit({ type: 'usage_update', sessionId: id, tokens: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 } })
    vi.advanceTimersByTime(RECONNECTING_FLAG_MS * 2)
    expect(interruptions(id)).toHaveLength(1)
    const flagged = interruptions(id)[0]
    expect(flagged?.type === 'interruption' ? flagged.interruption?.at : undefined).toBe(info(a, id).interruption?.at)

    h.emit({ type: 'activity', sessionId: id, activity: null })
    expect(info(a, id).interruption).toBeNull()
    expect(interruptions(id).map((e) => e.type === 'interruption' && e.interruption?.reason)).toEqual(['reconnecting', undefined])
  })

  it('a deleted session leaves no reconnect clock behind', async () => {
    const a = host()
    const { id, h } = await working(a)
    h.emit({ type: 'activity', sessionId: id, activity: 'retrying' })
    const clocks = () => (a.mgr as unknown as { interruptions: { reconnecting: Map<string, unknown> } }).interruptions.reconnecting
    expect(clocks().has(id)).toBe(true)
    await a.mgr.trashSession(id)
    expect(clocks().has(id)).toBe(false)
  })

  it('a host handing its sessions over leaves no reconnect clock running behind it', async () => {
    const a = host()
    const { id, h } = await working(a)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    h.emit({ type: 'activity', sessionId: id, activity: 'retrying' })
    await a.mgr.detachAll()
    vi.advanceTimersByTime(RECONNECTING_FLAG_MS * 2)
    // The next host watches the session from its own first event; this one says nothing after leaving
    expect(interruptions(id)).toEqual([])
    expect(info(a, id).interruption ?? null).toBeNull()
  })

  it('a reconnect that starts while the host lets its processes go starts no clock on the leaving host', async () => {
    const a = host()
    const { id, h } = await working(a)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    // The process still speaks while it is let go: its tool begins retrying then
    h.dispose = async () => h.emit({ type: 'activity', sessionId: id, activity: 'retrying' })
    await a.mgr.detachAll()
    vi.advanceTimersByTime(RECONNECTING_FLAG_MS * 2)
    expect(interruptions(id)).toEqual([])
  })

  it('silence alone is not flagged: a long build or a sleep looks the same', async () => {
    const a = host()
    const { id } = await working(a)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.advanceTimersByTime(RECONNECTING_FLAG_MS * 4)
    expect(info(a, id).interruption ?? null).toBeNull()
    expect(interruptions(id)).toEqual([])
  })

  it('a reconnect that recovers within the bound is never flagged', async () => {
    const a = host()
    const { id, h } = await working(a)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    h.emit({ type: 'activity', sessionId: id, activity: 'retrying' })
    vi.advanceTimersByTime(RECONNECTING_FLAG_MS / 2)
    h.emit({ type: 'activity', sessionId: id, activity: null })
    vi.advanceTimersByTime(RECONNECTING_FLAG_MS * 2)
    expect(interruptions(id)).toEqual([])
  })
})
