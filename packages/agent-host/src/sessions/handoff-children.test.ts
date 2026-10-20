import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, AgentProcess, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { handoffNotePath, writeHandoffNote } from '../dev-services/handoff-notes.js'
import { ASK_WAIT_MS } from './ask-project.js'
import { Store } from '../dev-services/store.js'
import { crossWorld } from './cross-project.test-helpers.js'
import { MemoryGate } from './memory-gate.js'
import { SessionManager, type AgentProcessHost } from './manager.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * A handoff moves the original session's live children to the session that took over (#693): their reports, the
 * agent_session handle, their delegated turns, the requests the original queued and its start_agent cards still
 * standing. A settled child stays where its history happened while the original stays, and moves too when the
 * original goes (#738). The move is one store transaction, so a crash leaves
 * every link with one owner, and a host that takes over after a swap reads that owner.
 */

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
  /** The turn ends with this as its final text */
  answer(text: string) {
    this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text })
    this.emit({ type: 'turn_complete', sessionId: this.sessionId })
  }
  respondApproval() {
    return false
  }
  /** Any event of the tool's, as the CLI sends it */
  emitEvent(e: NormalizedEvent) {
    this.emit(e)
  }
  interrupt() {}
  async dispose() {}
  async detach() {}
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

let store: Store
let root: string
let events: NormalizedEvent[]
const hosts: SessionManager[] = []

beforeEach(() => {
  store = new Store()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-handoff-children-')))
  events = []
})
afterEach(async () => {
  vi.restoreAllMocks()
  for (const mgr of hosts.splice(0)) await mgr.disposeAll()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

function host(kept: ReadonlySet<string> = new Set()) {
  const claude = new Adapter()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', claude]])
  const mgr = new SessionManager(store, adapters, (e) => events.push(e), undefined, join(root, 'worktrees'), { processes, keptSessions: kept })
  mgr.prLookup = async () => null
  hosts.push(mgr)
  return { mgr, claude }
}

/** A parent in a trusted project that may start agents without a card */
async function parentOf(h: ReturnType<typeof host>, preset: 'normal' | 'safe' = 'normal') {
  const project = await h.mgr.addProject(root)
  h.mgr.setProjectTrusted(project.id, true)
  if (preset === 'normal') store.permissions.setProjectConsent(project.id, project.id, 'agents')
  const parent = (await h.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: preset })).id
  h.mgr.rename(parent, 'Planner')
  return { project: project.id, parent }
}

/** A child started without waiting: working, and the parent is told when it ends */
async function startChild(h: ReturnType<typeof host>, parent: string, task: string) {
  const started = await h.mgr.startAgent(parent, { task, wait: false })
  if (!started.ok) throw new Error(started.error)
  expect(started).toMatchObject({ state: 'working', reported: true })
  return started.sessionId
}

/**
 * The handoff as the window does it (`store.handoff`): the original's note is on disk, the new session is created with
 * the note and the original's id, saying whether the original goes next (#738), and then the original is deleted (the
 * default). `says`: false is a frame that does not say so (an older window).
 */
async function handOff(h: ReturnType<typeof host>, project: string, parent: string, deleteOld = true, says = deleteOld) {
  await writeHandoffNote(project, parent, 'NOTE BODY: where things stand')
  // The new session inherits the original's settings, its permission preset among them
  const preset = h.mgr.listSessions().find((s) => s.id === parent)!.permissionPreset
  const heir = (await h.mgr.createSession({
    projectId: project, cwd: root, tool: 'claude', permissionPreset: preset,
    initialPrompt: 'You are taking over. Read the note.',
    handoff: { from: 'Planner', note: 'NOTE BODY: where things stand', fromSessionId: parent, ...(says ? { removesOriginal: true } : {}) },
  })).id
  if (deleteOld) await h.mgr.trashSession(parent)
  return heir
}

/** What reaches a session's model as a report from `child` */
const reports = (h: Handle | undefined, child: string) => (h?.sent ?? []).filter((t) => t.includes(`sourceSessionId: ${child}`))
const marker = (sessionId: string) => store.messages.loadMessages(sessionId, 20).map((m) => m.payload as { type?: string; note?: string }).find((p) => p.type === 'handoff')
const owner = (id: string) => store.sessions.listSessions().find((s) => s.id === id)?.askedBy

describe('a handoff moves the live children to the new session (#693)', () => {
  it("delivers a working child's report to the new session, not the original", async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'long work')
    const heir = await handOff(h, project, parent, false)

    expect(owner(child)).toBe(heir)
    expect(store.children.listReportMarks()).toEqual([{ sessionId: child, callerSessionId: heir }])
    expect(store.children.listDelegatedTurns()).toEqual([expect.objectContaining({ sessionId: child, callerSessionId: heir })])
    expect(events).toContainEqual(expect.objectContaining({ type: 'session_owner', sessionId: child, askedBy: heir }))

    h.claude.handles.get(child)!.answer('done here')
    await eventually(() => reports(h.claude.handles.get(heir), child).length === 1)
    expect(reports(h.claude.handles.get(parent), child)).toEqual([])
    expect(store.children.listReportMarks()).toEqual([])
    // The delegated turn's link (#676) ends with the turn, under its new owner too
    await eventually(() => store.children.listDelegatedTurns().length === 0)
  })

  it('lets the new session status and delete the child, and the original neither', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'long work')
    const heir = await handOff(h, project, parent, false)

    expect(await h.mgr.agentSession(heir, { sessionId: child, action: 'status' })).toMatchObject({ ok: true, state: 'working', sessionId: child })
    expect(await h.mgr.agentSession(parent, { sessionId: child, action: 'status' })).toMatchObject({ ok: false, error: expect.stringContaining(`took over from this one, "You are taking over. Read the note." [${heir}]`) })
    expect(await h.mgr.agentSession(parent, { sessionId: child, action: 'delete' })).toMatchObject({ ok: false })
    expect(h.mgr.listSessions().some((s) => s.id === child)).toBe(true)
    // The delegation moved with it: the new session may delete the child it now owns while it works
    expect(await h.mgr.agentSession(heir, { sessionId: child, action: 'delete' })).toMatchObject({ ok: true, state: 'deleted' })
    expect(h.mgr.listSessions().some((s) => s.id === child)).toBe(false)
  })

  it('leaves a settled child with an original that stays and lists only the moved ones in the note', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const settled = await startChild(h, parent, 'quick check')
    h.claude.handles.get(settled)!.answer('checked')
    await eventually(() => reports(h.claude.handles.get(parent), settled).length === 1)
    const live = await startChild(h, parent, 'long work')
    h.mgr.rename(live, 'Port the parser')
    const heir = await handOff(h, project, parent, false)

    expect(owner(settled)).toBe(parent)
    expect(owner(live)).toBe(heir)
    const note = readFileSync(handoffNotePath(project, parent), 'utf8')
    expect(note).toContain('Work handed over with this note')
    expect(note).toContain(`"Port the parser" — working — handle: ${live}. Its report comes to you. agent_session works on it as on a session you started`)
    expect(note).not.toContain(settled)
    // The note the person wrote follows, whole; the marker keeps the same text
    expect(note.endsWith('NOTE BODY: where things stand')).toBe(true)
    expect(marker(heir)?.note).toBe(note)
    expect(store.children.listReportMarks()).toEqual([{ sessionId: live, callerSessionId: heir }])
    expect(await h.mgr.agentSession(parent, { sessionId: settled, action: 'status' })).toMatchObject({ ok: true, sessionId: settled })
  })

  it('names a child blocked on a question as waiting on one in the note (#428)', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'pick a name')
    h.mgr.rename(child, 'Name the thing')
    h.claude.handles.get(child)!.emitEvent({ type: 'question_request', sessionId: child, requestId: 'q1', questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: '' }] }] })
    await handOff(h, project, parent, false)
    expect(readFileSync(handoffNotePath(project, parent), 'utf8')).toContain(`"Name the thing" — waiting on a question — handle: ${child}`)
  })

  it('moves a child paused on its own background work (#721): the note says so, and the end is reported to the new session', async () => {
    const h = host()
    ;(h.claude.capabilities as { backgroundTasks: boolean }).backgroundTasks = true
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'long work')
    h.mgr.rename(child, 'Port the parser')
    const verify = { id: 'bg-verify', kind: 'shell' as const, description: 'pnpm verify', status: 'running' as const }
    const ch = h.claude.handles.get(child)!
    ch.emitEvent({ type: 'background_tasks', sessionId: child, live: [verify] })
    ch.answer('waiting for verify')
    await eventually(() => reports(h.claude.handles.get(parent), child).length === 1)
    const heir = await handOff(h, project, parent)

    expect(owner(child)).toBe(heir)
    const note = readFileSync(handoffNotePath(project, parent), 'utf8')
    expect(note).toContain(`"Port the parser" — paused on its own background work; its report comes when that work ends — handle: ${child}`)
    ch.emitEvent({ type: 'background_tasks', sessionId: child, live: [], ended: [{ ...verify, status: 'completed' }] })
    ch.emitEvent({ type: 'state_change', sessionId: child, state: 'working' })
    ch.answer('verify passed')
    await eventually(() => reports(h.claude.handles.get(heir), child).length === 1)
    expect(store.children.listReportMarks()).toEqual([])
  })

  it('moves nothing and leaves the note alone when every child is settled', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const settled = await startChild(h, parent, 'quick check')
    h.claude.handles.get(settled)!.answer('checked')
    await eventually(() => reports(h.claude.handles.get(parent), settled).length === 1)
    const heir = await handOff(h, project, parent, false)
    expect(owner(settled)).toBe(parent)
    expect(readFileSync(handoffNotePath(project, parent), 'utf8')).toBe('NOTE BODY: where things stand')
    expect(marker(heir)?.note).toBe('NOTE BODY: where things stand')
    expect(events.filter((e) => e.type === 'session_owner')).toEqual([])
  })

  it('moves a request the original queued for a busy child: it is delivered as the new session\'s turn', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'first job')
    h.claude.handles.get(child)!.answer('first done')
    await eventually(() => reports(h.claude.handles.get(parent), child).length === 1)
    // The person works in the child; the parent's next job waits in its queue (#677)
    await h.mgr.send(child, 'person work')
    const queued = await h.mgr.agentSession(parent, { sessionId: child, action: 'send', text: 'second job', ifBusy: 'queue' })
    expect(queued).toMatchObject({ ok: true, state: 'queued' })
    const heir = await handOff(h, project, parent)

    expect(store.children.listQueuedRequests()).toEqual([expect.objectContaining({ sessionId: child, callerSessionId: heir })])
    expect(readFileSync(handoffNotePath(project, parent), 'utf8')).toContain(`busy; your request is queued — handle: ${child}`)
    const ch = h.claude.handles.get(child)!
    ch.answer('person answer')
    await eventually(() => ch.sent.some((t) => t.includes('second job')))
    ch.answer('second done')
    await eventually(() => reports(h.claude.handles.get(heir), child).length === 1)
    expect(await h.mgr.agentSession(heir, { sessionId: child, action: 'status' })).toMatchObject({ ok: true, answer: 'second done' })
  })

  it('drops what only auto let the original queue when the session taking over is not auto, and tells the original', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    await h.mgr.updateSettings(parent, { permissionPreset: 'auto' })
    // A session of the project the original did not start, busy with the person's work
    const other = (await h.mgr.createSession({ projectId: project, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
    await h.mgr.send(other, 'person work')
    expect(await h.mgr.agentSession(parent, { sessionId: other, action: 'send', text: 'tidy up', ifBusy: 'queue' })).toMatchObject({ ok: true, state: 'queued' })
    await writeHandoffNote(project, parent, 'NOTE BODY: where things stand')
    // The session taking over is not auto
    await h.mgr.createSession({
      projectId: project, cwd: root, tool: 'claude', permissionPreset: 'normal',
      initialPrompt: 'You are taking over. Read the note.',
      handoff: { from: 'Planner', note: 'NOTE BODY: where things stand', fromSessionId: parent },
    })
    expect(store.children.listQueuedRequests()).toEqual([])
    await eventually(() => store.messages.loadMessages(parent, 50).some((m) => JSON.stringify(m.payload).includes('was not delivered')))
    h.claude.handles.get(other)!.answer('person answer')
    await eventually(() => h.mgr.listSessions().find((s) => s.id === other)?.state !== 'working')
    expect(h.claude.handles.get(other)!.sent).toEqual(['person work'])
  })

  it("moves a start_agent card still standing: it stands in the new session, and its approval starts the new session's child", async () => {
    const h = host()
    const { project, parent } = await parentOf(h, 'safe')
    const call = h.mgr.startAgent(parent, { task: 'needs a yes', wait: false })
    const cardIn = (id: string) => h.mgr.listSessions().find((s) => s.id === id)?.pendingApproval
    await eventually(() => cardIn(parent)?.detail.kind === 'agent_start')
    const requestId = cardIn(parent)!.requestId
    const heir = await handOff(h, project, parent)

    expect(store.children.listAgentStartRequests()).toEqual([expect.objectContaining({ requestId, callerSessionId: heir, request: expect.objectContaining({ callerId: heir }) })])
    // Closed in the original (deleted here, as a handoff does by default) and never raised there again
    expect(events.filter((e) => e.type === 'approval_request' && e.sessionId === parent)).toHaveLength(1)
    // The new session's first turn (reading the note) hides the card; it stands again when that turn ends (#673)
    h.claude.handles.get(heir)!.answer('I have read the note')
    await eventually(() => cardIn(heir)?.requestId === requestId)
    expect(readFileSync(handoffNotePath(project, parent), 'utf8')).toContain(`handle: ${requestId}`)
    h.mgr.respondApproval(heir, requestId, 'allow')
    await call
    await eventually(() => h.mgr.listSessions().some((s) => s.askedBy === heir))
    const child = h.mgr.listSessions().find((s) => s.askedBy === heir)!.id
    expect(store.children.listAgentStartRequests()).toEqual([])
    expect(await h.mgr.agentSession(heir, { sessionId: child, action: 'status' })).toMatchObject({ ok: true, sessionId: child })
  })

  it('tells an original that stays what went where, in its conversation', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'long work')
    h.mgr.rename(child, 'Port the parser')
    const heir = await handOff(h, project, parent, false)
    const notice = store.messages.loadMessages(parent, 20).map((m) => m.payload as { type?: string; text?: string }).find((p) => p.type === 'notice' && p.text?.includes('Handed over'))
    expect(notice?.text).toContain(`[${heir}]`)
    expect(notice?.text).toContain('"Port the parser" (working)')
  })

  it("ends the original's wait on a moved child: the answer goes to the new session alone", async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'long work')
    // The original waits on the child in a call (its wait takes the report mark down)
    const waiting = h.mgr.agentSession(parent, { sessionId: child, action: 'wait' })
    await eventually(() => store.children.listReportMarks().length === 0)
    const heir = await handOff(h, project, parent, false)
    expect(await waiting).toMatchObject({ ok: false, error: expect.stringContaining(`[${heir}]`) })
    // The report that wait had taken down is owed to the new session, stored too
    expect(store.children.listReportMarks()).toEqual([{ sessionId: child, callerSessionId: heir }])
    h.claude.handles.get(child)!.answer('the answer')
    await eventually(() => reports(h.claude.handles.get(heir), child).length === 1)
    expect(reports(h.claude.handles.get(parent), child)).toEqual([])
    expect(await h.mgr.agentSession(heir, { sessionId: child, action: 'status' })).toMatchObject({ ok: true, answer: 'the answer' })
  })

  it("ends the original's wait on a start request it handed over", async () => {
    const h = host()
    const { project, parent } = await parentOf(h, 'safe')
    void h.mgr.startAgent(parent, { task: 'needs a yes', wait: false })
    await eventually(() => h.mgr.listSessions().find((s) => s.id === parent)?.pendingApproval?.detail.kind === 'agent_start')
    const requestId = h.mgr.listSessions().find((s) => s.id === parent)!.pendingApproval!.requestId
    const waiting = h.mgr.agentSession(parent, { sessionId: requestId, action: 'wait' })
    const heir = await handOff(h, project, parent, false)
    expect(await waiting).toMatchObject({ ok: false, error: expect.stringContaining(`[${heir}]`) })
    expect(await h.mgr.agentSession(heir, { sessionId: requestId, action: 'status' })).toMatchObject({ ok: true, state: 'pending' })
  })

  it('says in the note what the new session can do with a session it did not start', async () => {
    const h = host()
    const project = await h.mgr.addProject(root)
    h.mgr.setProjectTrusted(project.id, true)
    store.permissions.setProjectConsent(project.id, project.id, 'agents')
    // An auto session gives work to a session the person opened: the turn is its own, the session is not its child
    const parent = (await h.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'auto' })).id
    const other = (await h.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
    h.mgr.rename(other, 'Docs')
    const sent = h.mgr.agentSession(parent, { sessionId: other, action: 'send', text: 'tidy the docs' })
    await eventually(() => h.mgr.listSessions().find((s) => s.id === other)?.state === 'working')
    const heir = await handOff(h, project.id, parent, false)
    // The call that gave the work was still waiting: it hears where the work went
    expect(await sent).toMatchObject({ ok: false, error: expect.stringContaining(`[${heir}]`) })
    const note = readFileSync(handoffNotePath(project.id, parent), 'utf8')
    expect(note).toContain(`"Docs" — working — handle: ${other}. Its report comes to you, and you are told of the cards of the turn you now own. You did not start it, so agent_session works on it only with the auto preset.`)
    expect(owner(other) ?? null).toBeNull()
  })

  it('moves a start queued for memory (#686): it starts as the new session\'s child when memory recovers', async () => {
    const h = host()
    const GB = 1024 ** 3
    let free = 1 * GB
    h.mgr.useMemoryGate(new MemoryGate({ read: async () => free, recheckMs: 20, maxWaitMs: 10_000 }))
    const { project, parent } = await parentOf(h)
    const queued = await h.mgr.startAgent(parent, { task: 'heavy work', wait: false })
    expect(queued).toMatchObject({ ok: true, state: 'pending', lowMemory: expect.anything() })
    const requestId = (queued as { sessionId: string }).sessionId
    const heir = await handOff(h, project, parent, false)

    expect(store.children.listAgentStartRequests()).toEqual([expect.objectContaining({ requestId, callerSessionId: heir, request: expect.objectContaining({ callerId: heir, allowed: true }) })])
    const note = readFileSync(handoffNotePath(project, parent), 'utf8')
    expect(note).toContain(`allowed, queued until memory frees up, to start Claude Code: “heavy work” — handle: ${requestId}. It starts on its own when memory allows`)
    expect(note).not.toContain('The card stands in your session')
    expect(await h.mgr.agentSession(parent, { sessionId: requestId, action: 'status' })).toMatchObject({ ok: false, error: expect.stringContaining(`[${heir}]`) })
    expect(await h.mgr.agentSession(heir, { sessionId: requestId, action: 'status' })).toMatchObject({ ok: true, state: 'pending' })

    free = 8 * GB
    await eventually(() => h.mgr.listSessions().some((s) => s.askedBy === heir))
    const child = h.mgr.listSessions().find((s) => s.askedBy === heir)!.id
    expect(h.mgr.listSessions().some((s) => s.askedBy === parent)).toBe(false)
    await eventually(() => store.children.listReportMarks().some((m) => m.sessionId === child))
    expect(store.children.listReportMarks()).toEqual([{ sessionId: child, callerSessionId: heir }])
  })

  it('leaves everything with the original when the store fails mid-move, and a restart reads that one owner', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'long work')
    // A crash between the move's steps: the sessions, report and turn rows are written, the queue's is not
    const db = (store as unknown as { db: { prepare(sql: string): unknown } }).db
    const prepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('UPDATE queued_requests SET caller_session_id')) throw new Error('crash between steps')
      return prepare(sql)
    })
    const heir = await handOff(h, project, parent, false)
    vi.restoreAllMocks()

    expect(owner(child)).toBe(parent)
    expect(store.children.listReportMarks()).toEqual([{ sessionId: child, callerSessionId: parent }])
    expect(store.children.listDelegatedTurns()).toEqual([expect.objectContaining({ sessionId: child, callerSessionId: parent })])
    // The host's memory agrees with the store: the original still owns it, the new session does not
    expect(await h.mgr.agentSession(parent, { sessionId: child, action: 'status' })).toMatchObject({ ok: true, state: 'working' })
    expect(await h.mgr.agentSession(heir, { sessionId: child, action: 'status' })).toMatchObject({ ok: false })
    expect(readFileSync(handoffNotePath(project, parent), 'utf8')).toBe('NOTE BODY: where things stand')

    await h.mgr.detachAll()
    const next = host(new Set([child]))
    await next.mgr.adoptKept([{ sessionId: child, tool: 'claude', process: new FakeProcess() as unknown as AgentProcess }])
    expect(next.mgr.listSessions().find((s) => s.id === child)!.askedBy).toBe(parent)
    next.claude.handles.get(child)!.answer('finished under the next host')
    await eventually(() => reports(next.claude.handles.get(parent), child).length === 1)
    expect(reports(next.claude.handles.get(heir), child)).toEqual([])
  })

  it('survives a host swap: the next host reports the kept child to the new session', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'long work')
    const heir = await handOff(h, project, parent)
    await h.mgr.detachAll()

    const next = host(new Set([child]))
    await next.mgr.adoptKept([{ sessionId: child, tool: 'claude', process: new FakeProcess() as unknown as AgentProcess }])
    expect(next.mgr.listSessions().find((s) => s.id === child)!.askedBy).toBe(heir)
    expect(await next.mgr.agentSession(heir, { sessionId: child, action: 'status' })).toMatchObject({ ok: true, sessionId: child })
    next.claude.handles.get(child)!.answer('finished under the next host')
    await eventually(() => reports(next.claude.handles.get(heir), child).length === 1)
  })
})

describe("a handoff moves the original's ask_project delegations (#693)", () => {
  it('lets the new session wait on the answer the original never read, with ask_project', async () => {
    const w = await crossWorld()
    try {
      const target = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
      w.mgr.rename(target, 'Sprites')
      const caller = await w.callerSession()
      w.store.permissions.setProjectConsent(w.caller.id, w.target.id, 'delegate')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const call = w.mgr.askProject(caller, { project: w.target.id, session: target, task: 'export the sprites' })
      // The bound passes: the call answers "working" and the original never comes back for the answer
      for (let i = 0; i < 50 && !w.adapters.get('claude')!.handles.get(target)?.sent.length; i++) await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      expect(await call).toMatchObject({ ok: true, state: 'working' })
      vi.useRealTimers()

      await writeHandoffNote(w.caller.id, caller, 'NOTE')
      const heir = (await w.mgr.createSession({
        projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal',
        initialPrompt: 'Take over.', handoff: { from: 'Caller', note: 'NOTE', fromSessionId: caller },
      })).id
      const note = readFileSync(handoffNotePath(w.caller.id, caller), 'utf8')
      // Another project's session: what the new session can do is ask_project and the cards, not agent_session's verbs (#693 review)
      expect(note).toContain(`"Sprites" (project ${w.target.name}) — working — handle: ${target}. Call ask_project with project "${w.target.name}" and no task to wait for its answer; you are told of the cards`)
      expect(note).not.toContain('as on a session you started')
      expect(w.store.children.listDelegatedTurns()).toEqual([expect.objectContaining({ sessionId: target, callerSessionId: heir })])
      // The other project's session is not the new session's child: its owner on the row stays as it was
      expect(w.store.sessions.listSessions().find((s) => s.id === target)?.askedBy ?? null).toBeNull()
      // The original, kept, is told where its delegation went rather than waiting on it
      expect(await w.mgr.askProject(caller, { project: w.target.id })).toMatchObject({ ok: false, error: expect.stringContaining(`[${heir}]`) })
      await w.mgr.trashSession(caller)

      const waiting = w.mgr.askProject(heir, { project: w.target.id })
      w.adapters.get('claude')!.handles.get(target)!.answer('exported to out/')
      expect(await waiting).toMatchObject({ ok: true, state: 'done', answer: 'exported to out/' })
    } finally {
      vi.useRealTimers()
      await w.dispose()
    }
  })
})

/**
 * A settled child is often still in use: finished, reported, and waiting for its orchestrator's next instruction. Left
 * with an original that goes, it belonged to nobody (#738), so when the original goes every child moves.
 */
describe('a handoff whose original goes takes the settled children too (#738)', () => {
  /** A child that finished its work and reported it: nothing is owed */
  async function settledChild(h: ReturnType<typeof host>, parent: string, name = 'Release notes') {
    const child = await startChild(h, parent, 'write the notes')
    h.mgr.rename(child, name)
    h.claude.handles.get(child)!.answer('notes written, PR opened')
    await eventually(() => reports(h.claude.handles.get(parent), child).length === 1)
    return child
  }

  /**
   * agent_session send as an orchestrator makes it: the call waits up to its bound and answers "working", and the
   * child's report comes later, to the session the child now belongs to
   */
  async function sendPastBound(h: ReturnType<typeof host>, caller: string, child: string, text: string) {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const sent = h.mgr.agentSession(caller, { sessionId: child, action: 'send', text })
      for (let i = 0; i < 50 && !h.claude.handles.get(child)!.sent.some((t) => t.includes(text)); i++) await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(ASK_WAIT_MS)
      expect(await sent).toMatchObject({ ok: true, state: 'working', reported: true })
    } finally {
      vi.useRealTimers()
    }
    expect(store.children.listReportMarks()).toEqual([{ sessionId: child, callerSessionId: caller }])
  }

  it('gives a settled child to the new session, which can status, send and delete it without auto', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await settledChild(h, parent)
    const heir = await handOff(h, project, parent)

    expect(h.mgr.listSessions().find((s) => s.id === heir)!.permissionPreset).toBe('normal')
    expect(owner(child)).toBe(heir)
    expect(h.mgr.listSessions().find((s) => s.id === child)!.askedBy).toBe(heir)
    expect(events).toContainEqual(expect.objectContaining({ type: 'session_owner', sessionId: child, askedBy: heir }))
    expect(await h.mgr.agentSession(heir, { sessionId: child, action: 'status' })).toMatchObject({ ok: true, sessionId: child })

    // Its next report, after the new session gives it more work, reaches the new session
    await sendPastBound(h, heir, child, 'now the changelog')
    h.claude.handles.get(child)!.answer('changelog written')
    await eventually(() => reports(h.claude.handles.get(heir), child).length === 1)
    expect(await h.mgr.agentSession(heir, { sessionId: child, action: 'status' })).toMatchObject({ ok: true, answer: 'changelog written' })

    expect(await h.mgr.agentSession(heir, { sessionId: child, action: 'delete' })).toMatchObject({ ok: true, state: 'deleted' })
    expect(h.mgr.listSessions().some((s) => s.id === child)).toBe(false)
  })

  it('names a moved child in the note as read_session lists it', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const live = await startChild(h, parent, 'long work')
    // A resumed conversation's own name is its compaction summary's first line, which no list shows
    h.mgr.rename(live, 'This session is being continued from a previous conversation that ran out of context.')
    await handOff(h, project, parent)
    const note = readFileSync(handoffNotePath(project, parent), 'utf8')
    expect(note).not.toContain('This session is being continued')
    expect(note).toContain(`(resumed session)" — working — handle: ${live}.`)
  })

  it('lists every moved child in the note, a settled one as waiting for more work', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const settled = await settledChild(h, parent)
    const live = await startChild(h, parent, 'long work')
    h.mgr.rename(live, 'Port the parser')
    const heir = await handOff(h, project, parent)

    const note = readFileSync(handoffNotePath(project, parent), 'utf8')
    expect(note).toContain(`"Release notes" — finished; waiting for more work — handle: ${settled}. Give it more work with agent_session (send) and its report comes to you. agent_session works on it as on a session you started`)
    expect(note).toContain(`"Port the parser" — working — handle: ${live}. Its report comes to you.`)
    expect(note.endsWith('NOTE BODY: where things stand')).toBe(true)
    expect(marker(heir)?.note).toBe(note)
    expect(owner(live)).toBe(heir)
  })

  it('moves the parent link of a worktree child too', async () => {
    const h = host()
    const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })
    git('init', '-q', '-b', 'main')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
    const { project, parent } = await parentOf(h)
    const started = await h.mgr.startAgent(parent, { task: 'write the notes', worktree: true, wait: false })
    if (!started.ok) throw new Error(started.error)
    const child = started.sessionId
    expect(store.sessions.listSessions().find((s) => s.id === child)!.parentSessionId).toBe(parent)
    h.claude.handles.get(child)!.answer('done')
    await eventually(() => reports(h.claude.handles.get(parent), child).length === 1)
    const heir = await handOff(h, project, parent)

    expect(store.sessions.listSessions().find((s) => s.id === child)).toMatchObject({ askedBy: heir, parentSessionId: heir })
    expect(events).toContainEqual({ type: 'session_owner', sessionId: child, askedBy: heir, parentSessionId: heir })
  })

  it('survives a host swap: the next host reads the new session as the settled child\'s owner', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await settledChild(h, parent)
    const heir = await handOff(h, project, parent)
    await h.mgr.detachAll()

    const next = host()
    expect(next.mgr.listSessions().find((s) => s.id === child)!.askedBy).toBe(heir)
    expect(await next.mgr.agentSession(heir, { sessionId: child, action: 'status' })).toMatchObject({ ok: true, sessionId: child })
  })

  it('leaves a settled child with the original when the store fails mid-move', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await settledChild(h, parent)
    const db = (store as unknown as { db: { prepare(sql: string): unknown } }).db
    const prepare = db.prepare.bind(db)
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('UPDATE queued_requests SET caller_session_id')) throw new Error('crash between steps')
      return prepare(sql)
    })
    await handOff(h, project, parent, false, true)
    vi.restoreAllMocks()
    expect(owner(child)).toBe(parent)
    expect(readFileSync(handoffNotePath(project, parent), 'utf8')).toBe('NOTE BODY: where things stand')
  })

  it('gives what an original that stayed still has to the new session when the original is deleted later', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await settledChild(h, parent)
    const heir = await handOff(h, project, parent, false)
    expect(owner(child)).toBe(parent)

    await h.mgr.trashSession(parent)
    expect(owner(child)).toBe(heir)
    expect(events).toContainEqual(expect.objectContaining({ type: 'session_owner', sessionId: child, askedBy: heir }))
    // The new session is told in its conversation; its note was read long ago
    const notice = store.messages.loadMessages(heir, 20).map((m) => m.payload as { type?: string; text?: string }).find((p) => p.type === 'notice' && p.text?.includes('was archived'))
    expect(notice?.text).toContain(`[${parent}]`)
    expect(notice?.text).toContain('"Release notes" (finished; waiting for more work)')

    await sendPastBound(h, heir, child, 'one more')
    h.claude.handles.get(child)!.answer('one more done')
    await eventually(() => reports(h.claude.handles.get(heir), child).length === 1)
  })

  it('gives the settled children to the new session when a window that does not say so deletes the original', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await settledChild(h, parent)
    const heir = await handOff(h, project, parent, true, false)
    expect(owner(child)).toBe(heir)
  })

  it("passes a removed original's children on past a successor that is gone too", async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await settledChild(h, parent)
    const first = await handOff(h, project, parent, false)
    // The first successor hands over in turn and goes; the original stayed all along
    await writeHandoffNote(project, first, 'SECOND NOTE')
    const second = (await h.mgr.createSession({
      projectId: project, cwd: root, tool: 'claude', permissionPreset: 'normal', initialPrompt: 'Take over.',
      handoff: { from: 'Planner', note: 'SECOND NOTE', fromSessionId: first, removesOriginal: true },
    })).id
    await h.mgr.trashSession(first)
    expect(owner(child)).toBe(parent)

    await h.mgr.trashSession(parent)
    expect(owner(child)).toBe(second)
  })

  it('gives a removed original\'s working child to the new session, its report included', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const heir = await handOff(h, project, parent, false)
    // Started after a handoff that kept the original
    const child = await startChild(h, parent, 'long work')
    await h.mgr.trashSession(parent)

    expect(owner(child)).toBe(heir)
    expect(store.children.listReportMarks()).toEqual([{ sessionId: child, callerSessionId: heir }])
    h.claude.handles.get(child)!.answer('done here')
    await eventually(() => reports(h.claude.handles.get(heir), child).length === 1)
    expect(await h.mgr.agentSession(heir, { sessionId: child, action: 'status' })).toMatchObject({ ok: true, answer: 'done here' })
  })

  it('withdraws a removed original\'s standing start card instead of raising it in the new session', async () => {
    const h = host()
    const { project, parent } = await parentOf(h, 'safe')
    const heir = await handOff(h, project, parent, false)
    const call = h.mgr.startAgent(parent, { task: 'needs a yes', wait: false })
    await eventually(() => h.mgr.listSessions().find((s) => s.id === parent)?.pendingApproval?.detail.kind === 'agent_start')
    await h.mgr.trashSession(parent)

    expect(await call).toMatchObject({ ok: false })
    expect(store.children.listAgentStartRequests()).toEqual([])
    expect(h.mgr.listSessions().find((s) => s.id === heir)?.pendingApproval ?? null).toBeNull()
    expect(events.filter((e) => e.type === 'approval_request' && e.sessionId === heir)).toEqual([])
  })

  it('drops a request a removed original queued instead of delivering it for the new session', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const heir = await handOff(h, project, parent, false)
    const child = await settledChild(h, parent)
    await h.mgr.send(child, 'person work')
    expect(await h.mgr.agentSession(parent, { sessionId: child, action: 'send', text: 'second job', ifBusy: 'queue' })).toMatchObject({ ok: true, state: 'queued' })
    await h.mgr.trashSession(parent)

    expect(owner(child)).toBe(heir)
    expect(store.children.listQueuedRequests()).toEqual([])
    const ch = h.claude.handles.get(child)!
    ch.answer('person answer')
    await eventually(() => h.mgr.listSessions().find((s) => s.id === child)?.state !== 'working')
    await new Promise((r) => setTimeout(r, 50))
    expect(ch.sent.some((t) => t.includes('second job'))).toBe(false)
  })

  it('answers a call the removed original was still waiting in, and owes the report to the new session', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const heir = await handOff(h, project, parent, false)
    const child = await startChild(h, parent, 'long work')
    const waiting = h.mgr.agentSession(parent, { sessionId: child, action: 'wait' })
    await eventually(() => store.children.listReportMarks().length === 0)
    await h.mgr.trashSession(parent)

    expect(await waiting).toMatchObject({ ok: false, error: expect.stringContaining(`[${child}]`) })
    expect(store.children.listReportMarks()).toEqual([{ sessionId: child, callerSessionId: heir }])
  })

  it('does not choose a successor that is being deleted at the same time', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await settledChild(h, parent)
    const heir = await handOff(h, project, parent, false)
    const both = Promise.all([h.mgr.trashSession(heir), h.mgr.trashSession(parent)])
    await both
    expect(owner(child)).toBe(parent)
  })

  it('tries an older successor when the newest is gone with no successor of its own', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await settledChild(h, parent)
    // Older: handed over in turn, then deleted; its successor is still here
    const older = await handOff(h, project, parent, false)
    await writeHandoffNote(project, older, 'SECOND NOTE')
    const olderHeir = (await h.mgr.createSession({
      projectId: project, cwd: root, tool: 'claude', permissionPreset: 'normal', initialPrompt: 'Take over.',
      handoff: { from: 'Planner', note: 'SECOND NOTE', fromSessionId: older },
    })).id
    await h.mgr.trashSession(older)
    // Newer: deleted with no successor of its own
    await new Promise((r) => setTimeout(r, 5))
    const newer = await handOff(h, project, parent, false)
    await h.mgr.trashSession(newer)

    await h.mgr.trashSession(parent)
    expect(owner(child)).toBe(olderHeir)
  })

  it('leaves the children of a removed session that never handed over where they are', async () => {
    const h = host()
    const { parent } = await parentOf(h)
    const child = await settledChild(h, parent)
    await h.mgr.trashSession(parent)
    expect(owner(child)).toBe(parent)
    expect(events.filter((e) => e.type === 'session_owner')).toEqual([])
  })
})
