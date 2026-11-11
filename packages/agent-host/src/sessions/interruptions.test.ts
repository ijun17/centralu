import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import { INTERRUPTED_BY_TOOL, type AgentAdapter, type CreateSessionOpts, type EventSink, type SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { PERSON } from '../mail/address.js'
import { hostMail, mailSessionsOf } from '../mail/host-mail.js'
import { MAIL_HOST, addressOf, wireHostMail } from './host-mail.test-helpers.js'
import type { UpdateResumeFolder } from '../lifecycle/update-resume.js'
import { memoryUpdateFolder } from '../lifecycle/update-resume.test-helpers.js'
import { HOST_FAMILY } from '../os/real.js'
import { pausedReportKey } from './child-ownership.js'
import { isNetworkFailure, RECONNECTING_FLAG_MS } from './interruptions.js'
import { SessionManager } from './manager.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * Sessions stopped by a network outage or a quit (#698). On 2026-10-15 the internet dropped twice while several child
 * sessions were working: the Claude children ended in `error` and needed a "continue" message by hand, and the
 * assistant that had started them was not told. A Codex child's interrupted turn was reported as finished, and a
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
  for (const mgr of hosts.splice(0)) await mgr.tenure.disposeAll()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** `updateResume`: the data folder's lists of the turns an update cut (#1618, lifecycle/update-resume.ts) */
function host(o: { updateResume?: UpdateResumeFolder } = {}) {
  const claude = new Adapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', claude]])
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, join(root, 'worktrees'), {
    ...(o.updateResume ? { updateResume: o.updateResume } : {}),
  })
  mgr.prLookup = async () => null
  hosts.push(mgr)
  return { mgr, claude }
}

async function parentAndChild(h: ReturnType<typeof host>) {
  const project = await h.mgr.projectCreation.addProject(root)
  h.mgr.setProjectTrusted(project.id, true)
  store.permissions.setProjectConsent(project.id, project.id, 'agents')
  const parent = (await h.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
  const started = await h.mgr.startAgent(parent, { task: 'fix the sidebar indent', wait: false })
  if (!started.ok) throw new Error(started.error)
  return { parent, child: started.sessionId, project }
}

/** The report texts stored in the parent's conversation that name the child */
const reportsTo = (parent: string, child: string) =>
  store.messages.loadMessages(parent, 50).map((m) => JSON.stringify(m.payload)).filter((t) => /\[Centralu\] The (assigned work|session ended its turn)/.test(t) && t.includes(child))
/** What the start does on its first timer tick (an update's Continue, the person's work reported to the Inbox) has run; this waits past it */
const startNoticesRan = () => new Promise<void>((r) => setTimeout(() => setImmediate(r), 0))
/**
 * Centralu's notices to `starter` that a session it started stopped, owed it nothing (docs/plans/mailbox.md "The stop notice"): only the mailbox
 * writes them, so a test that needs one wires mail
 */
const starterNotices = (starter: string) =>
  store.mailbox.feedOf(addressOf(starter), { limit: 500 }).filter((m) => m.sender === 'centralu' && m.kind === 'notice' && m.facts.about !== undefined)
/** Centralu's reports in `parent`'s mailbox: with mail wired, a child's report is mail */
const mailReportsTo = (parent: string) => store.mailbox.feedOf(addressOf(parent), { limit: 500 }).filter((m) => m.sender === 'centralu' && m.kind === 'report')
/** The starter notice's words, for the stopped session's name and the cause */
const starterBody = (name: string, cause: string, reportOwed = false) =>
  `${name}, which you started, stopped: ${cause}. ${reportOwed ? 'Its report to you will not come.' : 'It owed you no answer.'} read_session shows where it stopped; send it a message if it should go on.`
const info = (h: ReturnType<typeof host>, id: string) => h.mgr.listSessions().find((s) => s.id === id)!
const interruptions = (id: string) => events.filter((e) => e.type === 'interruption' && e.sessionId === id)

describe('a turn the network stopped (#698)', () => {
  it("2026-10-15: a child's own turn fails with ECONNREFUSED; it is marked network and its starter is told, though no report was owed", async () => {
    const a = host()
    wireHostMail(a.mgr, store)
    const { parent, child } = await parentAndChild(a)
    const kid = a.claude.handles.get(child)!
    // The work it was given finished and was reported; the mark is gone
    kid.answer('waiting on pnpm verify with a Monitor')
    await eventually(() => mailReportsTo(parent).length === 1)
    expect(store.children.listReportMarks()).toEqual([])
    expect(info(a, parent).state).toBe('idle')

    kid.ownTurnFails(ECONNREFUSED)
    expect(info(a, child)).toMatchObject({ state: 'error', interruption: { reason: 'network', detail: ECONNREFUSED } })
    // A window reads the error first, then why
    const types = events.filter((e) => e.sessionId === child).map((e) => e.type)
    expect(types.lastIndexOf('interruption')).toBeGreaterThan(types.lastIndexOf('error'))
    expect(interruptions(child).at(-1)).toMatchObject({ interruption: { reason: 'network' } })

    // Its starter, at rest and owed nothing, reads the stop in its mailbox once, with no wake (docs/plans/mailbox.md "The stop notice")
    const [told, ...more] = starterNotices(parent)
    expect(more).toEqual([])
    expect(told).toMatchObject({ sender: 'centralu', kind: 'notice', facts: { about: { session: addressOf(child) }, reason: 'network', quiet: true } })
    expect(told!.body).toBe(starterBody(info(a, child).name, 'it lost the network'))
    // Never the tool's own words (#120), and no report: nobody was owed one
    expect(told!.body).not.toContain('ECONNREFUSED')
    expect(mailReportsTo(parent)).toHaveLength(1)
    expect(reportsTo(parent, child)).toEqual([])
    expect(a.claude.handles.get(parent)!.sent).toEqual([])
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
    const project = await a.mgr.projectCreation.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    await a.mgr.inputs.send(s.id, 'go')
    a.claude.handles.get(s.id)!.ownTurnFails(ECONNREFUSED)
    expect(store.sessions.listSessions().find((x) => x.id === s.id)?.interruption).toMatchObject({ reason: 'network' })

    await a.mgr.inputs.send(s.id, 'Continue where you stopped.')
    expect(info(a, s.id).interruption).toBeNull()
    expect(interruptions(s.id).at(-1)).toMatchObject({ interruption: null })
    expect(store.sessions.listSessions().find((x) => x.id === s.id)?.interruption).toBeNull()
  })

  it('an error the network did not cause leaves no interruption, and its starter reads that an error ended the turn, not the network', async () => {
    const a = host()
    wireHostMail(a.mgr, store)
    const { parent, child } = await parentAndChild(a)
    const kid = a.claude.handles.get(child)!
    kid.answer('done')
    await eventually(() => mailReportsTo(parent).length === 1)
    kid.ownTurnFails('unexpected status 401 Unauthorized')
    expect(info(a, child)).toMatchObject({ state: 'error', interruption: null })
    // Told with the event that ended the turn, once, and in Centralu's words, never the tool's (#120)
    const [told, ...more] = starterNotices(parent)
    expect(more).toEqual([])
    expect(told).toMatchObject({ facts: { about: { session: addressOf(child) }, reason: 'error', quiet: true } })
    expect(told!.body).toBe(starterBody(info(a, child).name, 'an error ended its turn'))
    expect(mailReportsTo(parent)).toHaveLength(1)
  })
})

/** A parent that starts a child and waits for its answer in the same call */
async function waitingParent(h: ReturnType<typeof host>) {
  const project = await h.mgr.projectCreation.addProject(root)
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
    wireHostMail(a.mgr, store)
    const { parent, child, call } = await waitingParent(a)
    a.claude.handles.get(child)!.emit({ type: 'error', sessionId: child, error: { code: 'internal', message: ECONNREFUSED, retryable: true } })
    // Its wait told it: no notice of the stop in its mailbox, neither as the starter nor as the giver of the task
    expect(store.mailbox.feedOf(addressOf(parent), { limit: 500 }).filter((m) => m.sender === 'centralu' && m.kind === 'notice')).toEqual([])
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
    const project = await a.mgr.projectCreation.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    await a.mgr.inputs.send(s.id, 'go')
    a.claude.handles.get(s.id)!.emit({ type: 'error', sessionId: s.id, error: { code: 'adapter_crashed', message: `${ECONNREFUSED}. stderr: fetch failed`, retryable: true } })
    expect(info(a, s.id).interruption ?? null).toBeNull()
    expect(interruptions(s.id)).toEqual([])
  })

  it('an error at rest stops no turn, so it offers nothing to continue', async () => {
    const a = host()
    const project = await a.mgr.projectCreation.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    await a.mgr.inputs.send(s.id, 'go')
    a.claude.handles.get(s.id)!.answer('done')
    a.claude.handles.get(s.id)!.emit({ type: 'error', sessionId: s.id, error: { code: 'internal', message: ECONNREFUSED, retryable: true } })
    expect(info(a, s.id)).toMatchObject({ state: 'error', interruption: null })
    expect(interruptions(s.id)).toEqual([])
  })
})

describe('a turn its tool interrupted (#698)', () => {
  it('is reported to the Assistant as stopped before finishing, never as finished', async () => {
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

  it('stays marked when output comes after it: only a new turn clears it (#1830)', async () => {
    const a = host()
    const { child } = await parentAndChild(a)
    const h = a.claude.handles.get(child)!
    h.emit({ type: 'state_change', sessionId: child, state: 'waiting_input', reason: INTERRUPTED_BY_TOOL })
    h.emit({ type: 'message_delta', sessionId: child, role: 'assistant', text: 'late' })
    expect(info(a, child)).toMatchObject({ state: 'waiting_input', interruption: { reason: 'interrupted' } })
    h.emit({ type: 'state_change', sessionId: child, state: 'working' })
    expect(info(a, child).interruption ?? null).toBeNull()
  })

  it("the person's Stop is not an interruption to flag: they know", async () => {
    const a = host()
    const project = await a.mgr.projectCreation.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    await a.mgr.inputs.send(s.id, 'go')
    a.claude.handles.get(s.id)!.emit({ type: 'state_change', sessionId: s.id, state: 'waiting_input', reason: 'interrupted' })
    expect(info(a, s.id).interruption ?? null).toBeNull()
    expect(interruptions(s.id)).toEqual([])
  })
})

describe('a turn a quit stopped (#698)', () => {
  it('a start that resets a session mid-turn to idle leaves a line in its conversation and marks it quit', async () => {
    const a = host()
    const project = await a.mgr.projectCreation.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    await a.mgr.inputs.send(s.id, 'a long job')
    expect(store.sessions.listSessions().find((x) => x.id === s.id)?.state).toBe('working')

    // "Quit completely": the process is gone, and the next start finds the row still working
    const b = host()
    expect(info(b, s.id)).toMatchObject({ state: 'idle', interruption: { reason: 'quit' } })
    const last = store.messages.loadMessages(s.id, 5).at(-1)!
    expect(last.payload).toMatchObject({ type: 'notice', level: 'warning', from: 'Centralu' })
    expect(JSON.stringify(last.payload)).toContain('Centralu quit or restarted while this turn was running')
    expect(info(b, s.id).lastSeq).toBe(last.seq)
  })

  it('work the person owns (a script started the session, §8.1): the next start reports the quit to their Inbox and settles the task', async () => {
    const a = host()
    const project = await a.mgr.projectCreation.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    // The person's task is written as the RPC writes it, before the first message goes in; this host's mail is not wired
    hostMail(store, mailSessionsOf(a.mgr, () => true), { hostId: MAIL_HOST }).hooks.personWork!.started(s.id, 'a long job')
    await a.mgr.inputs.send(s.id, 'a long job')
    const task = store.mailbox.newestTask(PERSON, addressOf(s.id))!
    expect(task).toBeDefined()

    const b = host()
    // The mailbox is wired in the same tick as the host is made, before the start's first moment
    wireHostMail(b.mgr, store)
    const reports = () => store.mailbox.reportsOn(task.id).filter((m) => m.sender === 'centralu')
    await eventually(() => reports().length === 1)
    expect(reports()[0]!.facts).toMatchObject({ outcome: 'stopped', reason: 'quit' })
    expect(reports()[0]!.body).toContain('Centralu quit or restarted during its turn')
    expect(store.mailbox.recipient(task.id, addressOf(s.id))).toMatchObject({ settled: 'reported' })
    expect(store.mailbox.newestTask(PERSON, addressOf(s.id))).toBeUndefined()
    // The start after that finds the session at rest and says nothing more
    host()
    await startNoticesRan()
    expect(reports()).toHaveLength(1)
  })

  it('a session at rest is left alone by the next start', async () => {
    const a = host()
    const project = await a.mgr.projectCreation.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    await a.mgr.inputs.send(s.id, 'short')
    a.claude.handles.get(s.id)!.answer('done')
    const before = store.messages.loadMessages(s.id, 10).length
    const b = host()
    expect(info(b, s.id)).toMatchObject({ state: 'waiting_input', interruption: null })
    expect(store.messages.loadMessages(s.id, 10)).toHaveLength(before)
  })

  it('the next start tells a starter that delegated without waiting (a report mark with no task row, as an older build left it), once per child, and only while the starter exists', async () => {
    // This host's mail is not wired: the delegation wrote no task, so the starter is owed nothing by its child
    const a = host()
    const { parent, child, project } = await parentAndChild(a)
    // A second child whose starter is deleted before the quit: nobody is left to tell
    const gone = (await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
    const orphan = await a.mgr.startAgent(gone, { task: 'other work', wait: false })
    if (!orphan.ok) throw new Error(orphan.error)
    await a.mgr.trash.trashSession(gone)

    const b = host()
    // A quit found at the start is told through the mailbox, once it is ready (docs/plans/mailbox.md "The stop notice")
    wireHostMail(b.mgr, store).afterReady()
    const [told, ...more] = starterNotices(parent)
    expect(more).toEqual([])
    // Owed the report the start drops (its report mark): woken, though at rest, since it waits for that report (owner 2026-11-10)
    expect(told).toMatchObject({ sender: 'centralu', kind: 'notice', facts: { about: { session: addressOf(child) }, reason: 'quit' } })
    expect(told!.facts.quiet).toBeUndefined()
    expect(told!.body).toBe(starterBody(info(b, child).name, 'Centralu quit during its turn', true))
    // No report besides: the old report path that told the requester of a quit is gone
    expect(reportsTo(parent, child)).toEqual([])
    expect(info(b, orphan.sessionId).interruption).toMatchObject({ reason: 'quit' })
    expect(starterNotices(gone)).toEqual([])

    // The child is at rest now, though still marked: the start after that tells nobody again
    const c = host()
    wireHostMail(c.mgr, store).afterReady()
    await startNoticesRan()
    expect(info(c, child).interruption).toMatchObject({ reason: 'quit' })
    expect(starterNotices(parent)).toHaveLength(1)
    expect(reportsTo(parent, child)).toEqual([])
  })

  it('a requester the same quit cut is not woken at launch: its own Continue covers its children', async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    // The Assistant was mid-turn too, waiting on its child, when the app quit
    await a.mgr.inputs.send(parent, 'keep going while the child works')
    const b = host()
    wireHostMail(b.mgr, store).afterReady()
    await startNoticesRan()
    // It reads its child's stop at its next turn: the notice wakes nobody, since a wake would start a turn with nobody there
    const [told, ...more] = starterNotices(parent)
    expect(more).toEqual([])
    expect(told).toMatchObject({ facts: { about: { session: addressOf(child) }, reason: 'quit', quiet: true } })
    expect(reportsTo(parent, child)).toEqual([])
    // Nothing resumed it, so its own stop is still there for the person to see and continue
    expect(b.claude.handles.has(parent)).toBe(false)
    expect(info(b, parent)).toMatchObject({ state: 'idle', interruption: { reason: 'quit' } })
    expect(info(b, child).interruption).toMatchObject({ reason: 'quit' })
  })

  it('when the session owed the report is gone, the one that started it is told', async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    // The report is owed to a session deleted since; the child was started by the parent
    store.children.setReportMark(child, 'a-session-deleted-since')
    const b = host()
    wireHostMail(b.mgr, store).afterReady()
    const [told, ...more] = starterNotices(parent)
    expect(more).toEqual([])
    expect(told).toMatchObject({ facts: { about: { session: addressOf(child) }, reason: 'quit', quiet: true } })
    expect(told!.body).toBe(starterBody(info(b, child).name, 'Centralu quit during its turn'))
    expect(starterNotices('a-session-deleted-since')).toEqual([])
    expect(reportsTo(parent, child)).toEqual([])
  })

  it("the Assistant's list says which children stopped and why", async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    const b = host()
    expect(info(b, child).interruption).toMatchObject({ reason: 'quit' })
    const r = await b.mgr.runCentraluTool(parent, 'read_session', {})
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
/*
 * #1946 (2026-11-03): a session had asked the Assistant in the morning; the person used the Assistant through the day, and a restart
 * that cut one of the person's turns told the morning's asker its work stopped, and woke it for nothing
 */
describe("the person's own turn a quit cut (#1946)", () => {
  it('is reported to nobody: not to the session that started this one', async () => {
    const a = host()
    wireHostMail(a.mgr, store)
    const { parent, child } = await parentAndChild(a)
    a.claude.handles.get(child)!.answer('indent fixed')
    await eventually(() => mailReportsTo(parent).length === 1)
    // The person's own turn, then the quit
    await a.mgr.inputs.send(child, 'now tidy the imports')
    expect(info(a, child).state).toBe('working')
    const b = host()
    wireHostMail(b.mgr, store).afterReady()
    await startNoticesRan()
    expect(info(b, child).interruption).toMatchObject({ reason: 'quit' })
    expect(starterNotices(parent)).toEqual([])
    expect(store.mailbox.feedOf(addressOf(parent), { limit: 500 }).filter((m) => m.sender === 'centralu' && m.kind === 'notice')).toEqual([])
    expect(mailReportsTo(parent)).toHaveLength(1)
    expect(reportsTo(parent, child)).toEqual([])
  })

  it("a report still owed is told of the stop though the turn was the person's: the start drops the mark, so it would never hear", async () => {
    const a = host()
    wireHostMail(a.mgr, store)
    const { parent, child } = await parentAndChild(a)
    a.claude.handles.get(child)!.answer('indent fixed, server running')
    await eventually(() => mailReportsTo(parent).length === 1)
    // The child's report is held over its own background work (#721); the person writes to it, which keeps the report owed
    store.children.setReportMark(child, parent)
    store.settings.setAppSetting(pausedReportKey(child), JSON.stringify([{ id: 't1', description: 'dev server' }]))
    await a.mgr.inputs.send(child, 'now tidy the imports')
    expect(info(a, child).state).toBe('working')
    const b = host()
    wireHostMail(b.mgr, store).afterReady()
    // Owed a report, the parent hears of the quit, as a report or as a sender owed an answer, and is woken: it waits for that report
    const child_ = addressOf(child)
    const heard = () =>
      store.mailbox
        .feedOf(addressOf(parent), { limit: 500 })
        .filter((m) => m.sender === 'centralu' && ((m.facts.about?.session === child_ && m.facts.reason === 'quit') || (m.facts.unanswered ?? []).some((u) => u.recipient === child_ && u.why === 'quit')))
    await eventually(() => heard().length > 0)
    expect(heard()).toHaveLength(1)
    expect(heard()[0]!.facts.quiet).toBeUndefined()
    // Not the words for a starter owed nothing: it was owed this report
    expect(heard()[0]!.body).not.toContain('It owed you no answer')
  })
})

/*
 * #1946 (2026-11-03): the notice for a turn a quit cut quoted the turn before's last answer as its "Last response", though the
 * cut turn had written nothing. A cut turn's words are those it said, or none (#1604)
 */
describe('the words of a turn a quit cut (#1946)', () => {
  it("are that turn's own: none, never the turn before's answer", async () => {
    const a = host()
    wireHostMail(a.mgr, store)
    const { parent, child } = await parentAndChild(a)
    a.claude.handles.get(child)!.answer('indent fixed in the sidebar')
    await eventually(() => mailReportsTo(parent).length === 1)
    expect(mailReportsTo(parent)[0]!.facts.answer).toBe('indent fixed in the sidebar')
    // The child's CLI opens a turn of its own, says nothing, and the app quits
    a.claude.handles.get(child)!.emit({ type: 'state_change', sessionId: child, state: 'working' })
    const b = host()
    wireHostMail(b.mgr, store).afterReady()
    const [told, ...more] = starterNotices(parent)
    expect(more).toEqual([])
    expect(told).toMatchObject({ facts: { about: { session: addressOf(child) }, reason: 'quit', quiet: true } })
    // The cut turn wrote nothing, and a turn the CLI opened is never quoted: the notice is Centralu's words alone
    expect(told!.body).toBe(starterBody(info(b, child).name, 'Centralu quit during its turn'))
    expect(told!.body).not.toContain('indent fixed in the sidebar')
  })
})

describe("a turn a linked hub's update cut (#1618)", () => {
  /** What went into the session's process since it was continued: Centralu's note, never a message of the person's */
  const sentTo = (h: ReturnType<typeof host>, id: string) => h.claude.handles.get(id)?.sent ?? []
  const lines = (id: string) => store.messages.loadMessages(id, 50).map((m) => JSON.stringify(m.payload))
  /** The data folder's lists of the turns an update cut, played by a map */
  const folder = memoryUpdateFolder
  /** The hub's update stops the host: what is in a turn is listed as the sessions are let go of */
  const stopForUpdate = async (h: ReturnType<typeof host>) => {
    h.mgr.tenure.stopForUpdate()
    await h.mgr.tenure.disposeAll()
  }

  it("is listed by the stop, continued once with Centralu's note; its parent hears nothing until the continued turn's end, which says so (#1966)", async () => {
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
    expect(b.mgr.tenure.updateContinued().map((c) => c.sessionId)).toEqual([child])
    // The mail turn of the cut turn is read back, not closed lost (mailbox §8.2 step 6, Q-M3a-3)
    expect(b.mgr.tenure.keptInTurn(child)).toBe(true)
    await eventually(() => sentTo(b, child).length === 1)
    expect(sentTo(b, child)[0]).toContain('Centralu on this machine was updated while your turn was running')
    expect(sentTo(b, child)[0]).toContain('Continue where you stopped. Check what already happened before repeating a step.')
    // Sent: its list goes
    await eventually(() => f.ids() === null)
    // And the conversation is past the listed row: a list left behind could name no later turn (#1626 review 1b)
    expect(store.messages.nextSeq(child) - 1).toBeGreaterThan(listedAt)
    expect(b.mgr.tenure.updateContinued().map((c) => c.sessionId)).toEqual([child])
    // Not the person's message: no user row, and the line says what happened
    expect(store.messages.loadMessages(child, 50).filter((m) => m.role === 'user')).toHaveLength(1)
    expect(lines(child).some((l) => l.includes('Centralu was updated during this turn, which stopped it; Centralu continued it'))).toBe(true)
    expect(lines(child).some((l) => l.includes('Centralu quit or restarted while this turn was running'))).toBe(false)

    // The parent is told nothing of the cut, neither that it stopped nor that it goes on (#1966)
    await startNoticesRan()
    expect(reportsTo(parent, child)).toHaveLength(0)

    // The continued turn's end is the report, once, and says in one line that an update cut the turn and Centralu continued it
    b.claude.handles.get(child)!.answer('Sidebar indent fixed.')
    await eventually(() => reportsTo(parent, child).length === 1)
    expect(reportsTo(parent, child)[0]).toContain('The session ended its turn')
    expect(reportsTo(parent, child)[0]).toContain('An update of Centralu cut this turn and Centralu continued it.')
    await startNoticesRan()
    expect(reportsTo(parent, child)).toHaveLength(1)
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
    await c.mgr.tenure.disposeAll()
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
    await b.mgr.inputs.send(child, 'now the header')
    await b.mgr.tenure.disposeAll()
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

  // A hold is Windows' (a scanner's FileShare.None); elsewhere the list is not read again (update-resume.test.ts)
  it.runIf(HOST_FAMILY === 'windows')('a list a virus scanner holds for a moment when the next host starts is read again, and its turn is continued (#1626 review)', async () => {
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
    await old.mgr.inputs.send(child, 'Continue')
    // Updated again by hand: the person's stop of that host cuts the turn they gave it
    await old.mgr.tenure.disposeAll()
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
    // Its starter, owed the report the start drops, reads the quit in its mailbox and is woken, as for any quit (docs/plans/mailbox.md "The stop notice")
    wireHostMail(b.mgr, store).afterReady()
    const [told, ...more] = starterNotices(parent)
    expect(more).toEqual([])
    expect(told).toMatchObject({ facts: { about: { session: addressOf(child) }, reason: 'quit' } })
    expect(told!.facts.quiet).toBeUndefined()
    expect(told!.body).toBe(starterBody(info(b, child).name, 'Centralu quit during its turn', true))
    // Nothing continued it: no Continue went in
    expect(b.claude.handles.has(child)).toBe(false)
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
    // The next host continues it, and its parent hears of it once, at the continued turn's end
    const c = host({ updateResume: f })
    await eventually(() => sentTo(c, child).length === 1)
    await eventually(() => f.ids() === null)
    await startNoticesRan()
    expect(reportsTo(parent, child)).toHaveLength(0)
    c.claude.handles.get(child)!.answer('done')
    await eventually(() => reportsTo(parent, child).length === 1)
    expect(reportsTo(parent, child)[0]).toContain('An update of Centralu cut this turn and Centralu continued it.')
    // The conversation shows one Continue: the leaving host wrote no line of its own for the note it handed over late
    expect(lines(child).filter((l) => l.includes('Centralu continued it'))).toHaveLength(1)
  })

  it("a Continue the tool takes as the person quits is recorded by its line, so the list left standing names no turn that quit cut (#1626 review)", async () => {
    const f = folder()
    const a = host({ updateResume: f })
    const { child } = await parentAndChild(a)
    await stopForUpdate(a)
    const b = host({ updateResume: f })
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
    // A plain stop, not an update's: it lists nothing, and the list the first update left is still there
    const stopping = b.mgr.tenure.disposeAll()
    accept!()
    await stopping
    expect(lines(child).filter((l) => l.includes('Centralu continued it'))).toHaveLength(1)
    const c = host({ updateResume: f })
    // A quit's turn, told as one: not continued again as an update's
    expect(info(c, child)).toMatchObject({ state: 'idle', interruption: { reason: 'quit' } })
    await startNoticesRan()
    await new Promise((r) => setTimeout(r, 50))
    expect(c.claude.handles.has(child)).toBe(false)
    expect(f.ids()).toBeNull()
  })

  it('a host that starts to leave while the session wakes sends it no note, and the next host sends the one (#1626 review)', async () => {
    const f = folder()
    const a = host({ updateResume: f })
    const { child } = await parentAndChild(a)
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
    await eventually(() => lines(child).filter((l) => l.includes('Centralu continued it')).length === 1)
  })

  it('lists only what is in a turn when the host stops: not a session the person stopped, nor one at rest; a stop not for an update lists nothing', async () => {
    const f = folder()
    const a = host({ updateResume: f })
    const project = await a.mgr.projectCreation.addProject(root)
    const open = async () => (await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
    const [cut, stopped, rest] = [await open(), await open(), await open()]
    for (const id of [cut, stopped]) await a.mgr.inputs.send(id, 'a long job')
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
    await b.mgr.tenure.disposeAll()
    expect(f.ids()).toBeNull()
    const c = host({ updateResume: f })
    expect(info(c, cut)).toMatchObject({ state: 'idle', interruption: { reason: 'quit' } })
  })

  // #1966 review: a turn that ends before the Continue's send has returned still carries the cut line, and the mark does not outlive it
  it('a continued turn that ends at once carries the cut line on that turn, not on a later one', async () => {
    const f = folder()
    const a = host({ updateResume: f })
    const { parent, child } = await parentAndChild(a)
    await stopForUpdate(a)
    const b = host({ updateResume: f })
    const create = b.claude.createSession.bind(b.claude)
    b.claude.createSession = async (opts, emit) => {
      const h = await create(opts, emit)
      const send = h.send.bind(h)
      h.send = (text: string) => {
        send(text)
        h.answer('done at once')
      }
      return h
    }
    await eventually(() => reportsTo(parent, child).length === 1)
    expect(reportsTo(parent, child)[0]).toContain('An update of Centralu cut this turn and Centralu continued it.')
    const held = (b.mgr as unknown as { children: { continuedCuts: Set<string> } }).children.continuedCuts
    expect(held.has(child)).toBe(false)
  })

  it('a wake before the Continue went in (a window that sees the machine back) keeps the turn, and the Continue goes in once (#1618 review D4)', async () => {
    const f = folder()
    const a = host({ updateResume: f })
    const { parent, child } = await parentAndChild(a)
    await stopForUpdate(a)
    const from = events.length
    const b = host({ updateResume: f })
    // The window's wake, in the same moment as the start's own Continue
    const woken = b.mgr.processes.resumeSession(child)
    await eventually(() => sentTo(b, child).length === 1)
    expect((await woken).resumed).toBe(true)
    await startNoticesRan()
    await new Promise((r) => setTimeout(r, 50))
    expect(sentTo(b, child)).toHaveLength(1)
    // Never at rest in between, which a hub would read as the turn's end
    const states = events.slice(from).flatMap((e) => (e.type === 'state_change' && e.sessionId === child ? [e.state] : []))
    expect(states.every((s) => s === 'working')).toBe(true)
    b.claude.handles.get(child)!.answer('done')
    await eventually(() => reportsTo(parent, child).length === 1)
    expect(reportsTo(parent, child)[0]).toContain('An update of Centralu cut this turn and Centralu continued it.')
  })

  it("work the person owns is not reported to their Inbox as stopped: its one report is the continued turn's end (#1618 review D3)", async () => {
    const f = folder()
    const a = host({ updateResume: f })
    const project = await a.mgr.projectCreation.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    hostMail(store, mailSessionsOf(a.mgr, () => true), { hostId: MAIL_HOST }).hooks.personWork!.started(s.id, 'a long job')
    await a.mgr.inputs.send(s.id, 'a long job')
    const task = store.mailbox.newestTask(PERSON, addressOf(s.id))!
    await stopForUpdate(a)

    const b = host({ updateResume: f })
    // The mailbox is wired in the same tick as the host is made, before the start's first moment
    wireHostMail(b.mgr, store)
    const reports = () => store.mailbox.reportsOn(task.id).filter((m) => m.sender === 'centralu')
    await eventually(() => sentTo(b, s.id).length === 1)
    await startNoticesRan()
    expect(reports()).toHaveLength(0)
    expect(store.mailbox.newestTask(PERSON, addressOf(s.id))?.id).toBe(task.id)
    b.claude.handles.get(s.id)!.answer('done')
    await eventually(() => reports().length === 1)
    expect(reports()[0]!.facts).toMatchObject({ outcome: 'finished' })
    expect(reports()[0]!.facts.reason).toBeUndefined()
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
    expect(reportsTo(parent, child)[0]).not.toContain('cut this turn')
    expect(f.ids()).toBeNull()
    // The stopped mark is a row too: past the listed one (#1626 review 1b)
    expect(store.messages.nextSeq(child) - 1).toBeGreaterThan(listedAt)
    // No longer named to a hub as going on
    expect(b.mgr.tenure.updateContinued()).toEqual([])
  })
})

describe("what an update's stop ends besides a turn (#1902)", () => {
  const sentTo = (h: ReturnType<typeof host>, id: string) => h.claude.handles.get(id)?.sent ?? []
  const lines = (id: string) => store.messages.loadMessages(id, 50).map((m) => JSON.stringify(m.payload))
  const stopForUpdate = async (h: ReturnType<typeof host>) => {
    h.mgr.tenure.stopForUpdate()
    await h.mgr.tenure.disposeAll()
  }
  /** A session that started a dev server in the background with a Bash call and ended its turn, the server still running */
  async function withDevServer(h: ReturnType<typeof host>) {
    const project = await h.mgr.projectCreation.addProject(root)
    const id = (await h.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
    await h.mgr.inputs.send(id, 'start the dev server')
    const handle = h.claude.handles.get(id)!
    handle.emit({ type: 'tool_call', sessionId: id, callId: 'call-1', summary: { tool: 'Bash', title: 'npm run dev', paths: [] }, input: { command: 'npm run dev -- --port 4000', run_in_background: true } })
    handle.emit({ type: 'background_tasks', sessionId: id, live: [{ id: 't1', kind: 'shell', description: 'Dev server', parentCallId: 'call-1', status: 'running' }] })
    handle.answer('started')
    return { id, handle }
  }

  it('a session whose turn had ended is told which background task the update stopped, with its command, and only once', async () => {
    const f = memoryUpdateFolder()
    const a = host({ updateResume: f })
    const { id } = await withDevServer(a)
    expect(info(a, id)).toMatchObject({ state: 'waiting_input' })
    await stopForUpdate(a)
    // Listed with the command of the call that started it, though no turn was cut
    expect(f.turns()).toEqual([])
    expect(f.ids()).toEqual([id])

    const b = host({ updateResume: f })
    await eventually(() => sentTo(b, id).length === 1)
    const note = sentTo(b, id)[0]!
    expect(note).toContain('Centralu on this machine was updated. Your turn had ended')
    expect(note).toContain('- shell command: "npm run dev -- --port 4000" (Dev server)')
    expect(note).toContain('Decide which you still need')
    // A continue of the update, not a turn the person's message or mail began: no user row, no Continue sentence, one line
    expect(note).not.toContain('Continue where you stopped')
    expect(store.messages.loadMessages(id, 50).filter((m) => m.role === 'user')).toHaveLength(1)
    expect(lines(id).filter((l) => l.includes('Centralu was updated, which stopped background work of this session'))).toHaveLength(1)
    await eventually(() => f.files.size === 0)
    // Not again: the list is gone
    const c = host({ updateResume: f })
    await startNoticesRan()
    expect(c.claude.handles.has(id)).toBe(false)
  })

  it('a session whose conversation moved on after the stop (the person wrote first) is not woken for a list that names the old end; its neighbour is', async () => {
    const f = memoryUpdateFolder()
    const a = host({ updateResume: f })
    const moved = await withDevServer(a)
    const same = await withDevServer(a)
    await stopForUpdate(a)
    store.messages.appendMessages([{ sessionId: moved.id, seq: store.messages.nextSeq(moved.id), role: 'user', kind: 'text', payload: { text: 'hello again' }, ts: Date.now() }])
    const b = host({ updateResume: f })
    await eventually(() => sentTo(b, same.id).length === 1)
    await startNoticesRan()
    expect(b.claude.handles.has(moved.id)).toBe(false)
    await eventually(() => f.files.size === 0)
  })

  it('a host that starts to leave while the idle session wakes sends it no note, and the list stays for the next host, which sends it (#1902 review)', async () => {
    const f = memoryUpdateFolder()
    const a = host({ updateResume: f })
    const { id } = await withDevServer(a)
    await stopForUpdate(a)
    const b = host({ updateResume: f })
    // The tool is slow to start the process: a second update's stop begins meanwhile, and lists nothing (no process yet)
    let release: (() => void) | undefined
    const create = b.claude.createSession.bind(b.claude)
    b.claude.createSession = async (opts, emit) => {
      if (opts.sessionId === id) await new Promise<void>((r) => (release = r))
      return create(opts, emit)
    }
    await eventually(() => release !== undefined)
    expect(f.ids()).toEqual([id])
    const stopping = stopForUpdate(b)
    release!()
    await stopping
    expect(sentTo(b, id)).toHaveLength(0)
    expect(f.ids()).toEqual([id])
    const c = host({ updateResume: f })
    await eventually(() => sentTo(c, id).length === 1)
    expect(sentTo(c, id)[0]).toContain('- shell command: "npm run dev -- --port 4000"')
    await eventually(() => f.files.size === 0)
  })

  it('a session the stop left in a turn that no list continues is a quit, as before: reset, marked stopped, and not woken for the note', async () => {
    const f = memoryUpdateFolder()
    const a = host({ updateResume: f })
    const { id } = await withDevServer(a)
    await a.mgr.inputs.send(id, 'and now something else')
    await stopForUpdate(a)
    // The list names the tasks but not this turn (a person's stop took it, or another build wrote the list)
    const [name, text] = [...f.files.entries()][0]!
    f.files.set(name, JSON.stringify({ ...JSON.parse(text), turns: [] }))
    const b = host({ updateResume: f })
    expect(info(b, id)).toMatchObject({ state: 'idle', interruption: { reason: 'quit' } })
    await startNoticesRan()
    expect(sentTo(b, id)).toHaveLength(0)
    expect(b.claude.handles.has(id)).toBe(false)
    expect(f.files.size).toBe(0)
  })

  it('an idle session that cannot be woken for the note is left at rest, not marked as quit; the list goes', async () => {
    const f = memoryUpdateFolder()
    const a = host({ updateResume: f })
    const { id } = await withDevServer(a)
    await stopForUpdate(a)
    const b = host({ updateResume: f })
    const create = b.claude.createSession.bind(b.claude)
    let tried = 0
    b.claude.createSession = async (opts, emit) => {
      if (opts.sessionId === id) {
        tried++
        throw new Error('its conversation is gone there')
      }
      return create(opts, emit)
    }
    await eventually(() => f.files.size === 0)
    // It was woken for the note, once, and the wake failed
    expect(tried).toBe(1)
    expect(info(b, id).state).toBe('waiting_input')
    expect(info(b, id).interruption ?? null).toBeNull()
    expect(sentTo(b, id)).toHaveLength(0)
  })

  /*
   * #1912: a child whose report paused on its own background work was at rest when an update stopped the host. The next host dropped the report
   * with the work, so its parent, told "a final report follows only if that work ends", waited for good. The report is kept now
   */
  describe('a child whose report to its parent paused on the work the update stopped (#1912)', () => {
    /** The parent's reports about the child, the update's note among them */
    const toldOf = (parent: string, child: string) =>
      store.messages.loadMessages(parent, 50).map((m) => JSON.stringify(m.payload)).filter((t) => t.includes('[Centralu]') && t.includes(child))
    async function pausedChild(h: ReturnType<typeof host>) {
      const { parent, child } = await parentAndChild(h)
      const handle = h.claude.handles.get(child)!
      handle.emit({ type: 'tool_call', sessionId: child, callId: 'call-1', summary: { tool: 'Bash', title: 'pnpm e2e', paths: [] }, input: { command: 'pnpm e2e', run_in_background: true } })
      handle.emit({ type: 'background_tasks', sessionId: child, live: [{ id: 't1', kind: 'shell', description: 'e2e run', parentCallId: 'call-1', status: 'running' }] })
      handle.answer('Started the e2e run; waiting for it.')
      await eventually(() => toldOf(parent, child).length === 1)
      expect(toldOf(parent, child)[0]).toContain('The assigned work paused: its turn ended while its own background work is still running (e2e run)')
      // The parent reads the pause and ends its turn
      h.claude.handles.get(parent)!.answer('Noted.')
      await eventually(() => info(h, parent).state !== 'working')
      return { parent, child }
    }

    it("its parent hears the end of the turn the update's note wakes it for, saying the update stopped that work", async () => {
      const f = memoryUpdateFolder()
      const a = host({ updateResume: f })
      const { parent, child } = await pausedChild(a)
      await stopForUpdate(a)
      const b = host({ updateResume: f })
      await eventually(() => sentTo(b, child).length === 1)
      expect(sentTo(b, child)[0]).toContain('- shell command: "pnpm e2e" (e2e run)')
      b.claude.handles.get(child)!.answer('The update stopped the e2e run; I ran it again and it passed.')
      await eventually(() => toldOf(parent, child).length === 2)
      const end = toldOf(parent, child)[1]!
      expect(end).toContain('[Centralu] The session ended its turn.')
      expect(end).toContain('An update of Centralu stopped the background work this work had paused on before that work ended; the session was told which, and this turn came after.')
      expect(end).toContain('I ran it again and it passed.')
      expect(store.children.listReportMarks()).toEqual([])
    })

    // #1540: whether the person wrote to it was kept in memory, so the next host sent updates of a session the person had written to
    it('one the person wrote to before the update sends its parent no update after it', async () => {
      const f = memoryUpdateFolder()
      const a = host({ updateResume: f })
      const { parent, child } = await pausedChild(a)
      await a.mgr.inputs.send(child, 'I will look at the e2e run myself', undefined, undefined, true)
      a.claude.handles.get(child)!.answer('Sure.')
      await eventually(() => info(a, child).state !== 'working')
      await stopForUpdate(a)
      const b = host({ updateResume: f })
      await eventually(() => sentTo(b, child).length === 1)
      // The woken turn starts the run again in the background and ends with words: the work is paused again
      const handle = b.claude.handles.get(child)!
      handle.emit({ type: 'tool_call', sessionId: child, callId: 'call-2', summary: { tool: 'Bash', title: 'pnpm e2e', paths: [] }, input: { command: 'pnpm e2e', run_in_background: true } })
      handle.emit({ type: 'background_tasks', sessionId: child, live: [{ id: 't2', kind: 'shell', description: 'e2e run', parentCallId: 'call-2', status: 'running' }] })
      handle.answer('Started the e2e run again; waiting for it.')
      await eventually(() => info(b, child).state !== 'working')
      await new Promise((r) => setTimeout(r, 50))
      expect(toldOf(parent, child)).toHaveLength(1)
      expect(store.children.listReportMarks()).toHaveLength(1)
    })

    it('one the note cannot wake: its parent is told at once that the update stopped the awaited work', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const f = memoryUpdateFolder()
      const a = host({ updateResume: f })
      const { parent, child } = await pausedChild(a)
      await stopForUpdate(a)
      const b = host({ updateResume: f })
      const create = b.claude.createSession.bind(b.claude)
      b.claude.createSession = async (opts, emit) => {
        if (opts.sessionId === child) throw new Error('its conversation is gone there')
        return create(opts, emit)
      }
      await eventually(() => toldOf(parent, child).length === 2)
      const note = toldOf(parent, child)[1]!
      expect(note).toContain(
        '[Centralu] An update of Centralu stopped the background work the assigned work had paused on (e2e run) before that work ended, and no turn of the session followed, so the work may not have finished',
      )
      expect(note).toContain('Started the e2e run; waiting for it.')
      expect(store.children.listReportMarks()).toEqual([])
    })
  })

  it('lists only a session holding something, and only for an update: an empty one and a quit list nothing', async () => {
    const f = memoryUpdateFolder()
    const a = host({ updateResume: f })
    const project = await a.mgr.projectCreation.addProject(root)
    const empty = (await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
    const busy = (await withDevServer(a)).id
    await stopForUpdate(a)
    expect(f.ids()).toEqual([busy])
    expect(f.ids()).not.toContain(empty)
    const quit = memoryUpdateFolder()
    const b = host({ updateResume: quit })
    await withDevServer(b)
    await b.mgr.tenure.disposeAll()
    expect(quit.files.size).toBe(0)
  })

  it("a question the update closed reaches the agent as the update's, with the question, and a cut turn keeps its Continue", async () => {
    const f = memoryUpdateFolder()
    const a = host({ updateResume: f })
    const { id, handle } = await withDevServer(a)
    await a.mgr.inputs.send(id, 'now ask me something')
    handle.emit({ type: 'question_request', sessionId: id, requestId: 'q1', questions: [{ question: 'What should I eat for lunch?', header: '', options: [{ label: 'Sushi', description: '' }], multiSelect: false }] })
    expect(info(a, id)).toMatchObject({ state: 'waiting_approval' })
    await stopForUpdate(a)
    const b = host({ updateResume: f })
    await eventually(() => sentTo(b, id).length === 1)
    const note = sentTo(b, id)[0]!
    expect(note).toContain('Continue where you stopped. Check what already happened before repeating a step.')
    expect(note).toContain('The update closed a question before the person answered. The person did not refuse it')
    expect(note).toContain('- "What should I eat for lunch?"')
    expect(note).toContain('"npm run dev -- --port 4000"')
    // The line is the cut turn's: one Continue
    expect(lines(id).filter((l) => l.includes('Centralu continued it on the new version'))).toHaveLength(1)
    await eventually(() => f.files.size === 0)
  })

  it('an approval the update closed is told the same way, and a session at rest holding none of this hears nothing', async () => {
    const f = memoryUpdateFolder()
    const a = host({ updateResume: f })
    const { id, handle } = await withDevServer(a)
    await a.mgr.inputs.send(id, 'delete the build folder')
    handle.emit({ type: 'approval_request', sessionId: id, requestId: 'r1', detail: { kind: 'command', command: 'rm -rf build', cwd: root } })
    // The tool withdraws its card as the process goes, and that is a row of the conversation: the mark is read after it
    handle.dispose = async () => handle.emit({ type: 'approval_resolved', sessionId: id, requestId: 'r1', decision: 'deny' })
    await stopForUpdate(a)
    const rows = store.messages.nextSeq(id) - 1
    expect(f.turns()).toEqual([{ id, seq: rows }])
    expect(JSON.parse([...f.files.values()][0]!).stopped[0].seq).toBe(rows)
    const b = host({ updateResume: f })
    await eventually(() => sentTo(b, id).length === 1)
    expect(sentTo(b, id)[0]).toContain('The update closed the permission card of your pending tool call. The person did not refuse it')
  })
})

describe('the session a report names', () => {
  it('is named as read_session lists it, whichever way the turn ended', async () => {
    const a = host()
    wireHostMail(a.mgr, store)
    const { parent, child } = await parentAndChild(a)
    // A resumed conversation's name is its compaction summary's first line, which the Assistant's list never shows
    a.mgr.rename(child, 'This session is being continued from a previous conversation that ran out of context.')
    const listed = (await a.mgr.runCentraluTool(parent, 'read_session', {})).text
    expect(listed).toContain('(resumed session)')
    const kid = a.claude.handles.get(child)!
    kid.answer('done')
    await eventually(() => mailReportsTo(parent).length === 1)
    // A turn of its own the network ends: its starter, owed nothing, reads the stop notice
    kid.ownTurnFails(ECONNREFUSED)
    const [told, ...more] = starterNotices(parent)
    expect(more).toEqual([])
    expect(told?.facts).toMatchObject({ about: { session: addressOf(child) }, reason: 'network' })
    for (const said of [...mailReportsTo(parent), told!].map((m) => m.body)) {
      expect(said).not.toContain('This session is being continued')
    }
    expect(told!.body).toContain('(resumed session), which you started, stopped: it lost the network.')
  })
})

describe('a tool reconnecting for too long (#698)', () => {
  async function working(a: ReturnType<typeof host>) {
    const project = await a.mgr.projectCreation.addProject(root)
    const s = await a.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })
    await a.mgr.inputs.send(s.id, 'go')
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
    await a.mgr.trash.trashSession(id)
    expect(clocks().has(id)).toBe(false)
  })

  it('a host that lets its sessions go leaves no reconnect clock running behind it', async () => {
    const a = host()
    const { id, h } = await working(a)
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    h.emit({ type: 'activity', sessionId: id, activity: 'retrying' })
    await a.mgr.tenure.disposeAll()
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
    await a.mgr.tenure.disposeAll()
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
