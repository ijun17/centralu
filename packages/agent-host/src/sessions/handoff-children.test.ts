import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, AgentProcess, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { handoffNotePath, writeHandoffNote } from '../dev-services/handoff-notes.js'
import { Store } from '../dev-services/store.js'
import { crossWorld } from './cross-project.test-helpers.js'
import { SessionManager, type AgentProcessHost } from './manager.js'

/**
 * A handoff moves the original session's live children to the session that took over (#693): their reports, the
 * agent_session handle, their delegated turns, the requests the original queued and its start_agent cards still
 * standing. A settled child stays where its history happened. The move is one store transaction, so a crash leaves
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

const until = async (ok: () => boolean, ms = 2000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** A parent in a trusted project that may start agents without a card */
async function parentOf(h: ReturnType<typeof host>, preset: 'normal' | 'safe' = 'normal') {
  const project = await h.mgr.addProject(root)
  h.mgr.setProjectTrusted(project.id, true)
  if (preset === 'normal') store.setProjectConsent(project.id, project.id, 'agents')
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
 * the note and the original's id, and then the original is deleted (the default).
 */
async function handOff(h: ReturnType<typeof host>, project: string, parent: string, deleteOld = true) {
  await writeHandoffNote(project, parent, 'NOTE BODY: where things stand')
  // The new session inherits the original's settings, its permission preset among them
  const preset = h.mgr.listSessions().find((s) => s.id === parent)!.permissionPreset
  const heir = (await h.mgr.createSession({
    projectId: project, cwd: root, tool: 'claude', permissionPreset: preset,
    initialPrompt: 'You are taking over. Read the note.',
    handoff: { from: 'Planner', note: 'NOTE BODY: where things stand', fromSessionId: parent },
  })).id
  if (deleteOld) await h.mgr.trashSession(parent)
  return heir
}

/** What reaches a session's model as a report from `child` */
const reports = (h: Handle | undefined, child: string) => (h?.sent ?? []).filter((t) => t.includes(`sourceSessionId: ${child}`))
const marker = (sessionId: string) => store.loadMessages(sessionId, 20).map((m) => m.payload as { type?: string; note?: string }).find((p) => p.type === 'handoff')
const owner = (id: string) => store.listSessions().find((s) => s.id === id)?.askedBy

describe('a handoff moves the live children to the new session (#693)', () => {
  it("delivers a working child's report to the new session, not the original", async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'long work')
    const heir = await handOff(h, project, parent, false)

    expect(owner(child)).toBe(heir)
    expect(store.listReportMarks()).toEqual([{ sessionId: child, callerSessionId: heir }])
    expect(store.listDelegatedTurns()).toEqual([expect.objectContaining({ sessionId: child, callerSessionId: heir })])
    expect(events).toContainEqual(expect.objectContaining({ type: 'session_owner', sessionId: child, askedBy: heir }))

    h.claude.handles.get(child)!.answer('done here')
    await until(() => reports(h.claude.handles.get(heir), child).length === 1)
    expect(reports(h.claude.handles.get(parent), child)).toEqual([])
    expect(store.listReportMarks()).toEqual([])
    // The delegated turn's link (#676) ends with the turn, under its new owner too
    await until(() => store.listDelegatedTurns().length === 0)
  })

  it('lets the new session status and delete the child, and the original neither', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const child = await startChild(h, parent, 'long work')
    const heir = await handOff(h, project, parent, false)

    expect(await h.mgr.agentSession(heir, { sessionId: child, action: 'status' })).toMatchObject({ ok: true, state: 'working', sessionId: child })
    expect(await h.mgr.agentSession(parent, { sessionId: child, action: 'status' })).toMatchObject({ ok: false, error: expect.stringContaining('not a session this session started') })
    expect(await h.mgr.agentSession(parent, { sessionId: child, action: 'delete' })).toMatchObject({ ok: false })
    expect(h.mgr.listSessions().some((s) => s.id === child)).toBe(true)
    // The delegation moved with it: the new session may delete the child it now owns while it works
    expect(await h.mgr.agentSession(heir, { sessionId: child, action: 'delete' })).toMatchObject({ ok: true, state: 'deleted' })
    expect(h.mgr.listSessions().some((s) => s.id === child)).toBe(false)
  })

  it('leaves a settled child with the original and lists only the moved ones in the note', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const settled = await startChild(h, parent, 'quick check')
    h.claude.handles.get(settled)!.answer('checked')
    await until(() => reports(h.claude.handles.get(parent), settled).length === 1)
    const live = await startChild(h, parent, 'long work')
    h.mgr.rename(live, 'Port the parser')
    const heir = await handOff(h, project, parent)

    expect(owner(settled)).toBe(parent)
    expect(owner(live)).toBe(heir)
    const note = readFileSync(handoffNotePath(project, parent), 'utf8')
    expect(note).toContain('Sessions handed over with this note')
    expect(note).toContain(`"Port the parser" — working — handle: ${live}`)
    expect(note).not.toContain(settled)
    // The note the person wrote follows, whole; the marker keeps the same text
    expect(note.endsWith('NOTE BODY: where things stand')).toBe(true)
    expect(marker(heir)?.note).toBe(note)
    // The original was deleted afterwards (the handoff's default): the moved child kept its report
    expect(store.listReportMarks()).toEqual([{ sessionId: live, callerSessionId: heir }])
  })

  it('moves nothing and leaves the note alone when every child is settled', async () => {
    const h = host()
    const { project, parent } = await parentOf(h)
    const settled = await startChild(h, parent, 'quick check')
    h.claude.handles.get(settled)!.answer('checked')
    await until(() => reports(h.claude.handles.get(parent), settled).length === 1)
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
    await until(() => reports(h.claude.handles.get(parent), child).length === 1)
    // The person works in the child; the parent's next job waits in its queue (#677)
    await h.mgr.send(child, 'person work')
    const queued = await h.mgr.agentSession(parent, { sessionId: child, action: 'send', text: 'second job', ifBusy: 'queue' })
    expect(queued).toMatchObject({ ok: true, state: 'queued' })
    const heir = await handOff(h, project, parent)

    expect(store.listQueuedRequests()).toEqual([expect.objectContaining({ sessionId: child, callerSessionId: heir })])
    expect(readFileSync(handoffNotePath(project, parent), 'utf8')).toContain(`busy; your request is queued — handle: ${child}`)
    const ch = h.claude.handles.get(child)!
    ch.answer('person answer')
    await until(() => ch.sent.some((t) => t.includes('second job')))
    ch.answer('second done')
    await until(() => reports(h.claude.handles.get(heir), child).length === 1)
    expect(await h.mgr.agentSession(heir, { sessionId: child, action: 'status' })).toMatchObject({ ok: true, answer: 'second done' })
  })

  it("moves a start_agent card still standing: it stands in the new session, and its approval starts the new session's child", async () => {
    const h = host()
    const { project, parent } = await parentOf(h, 'safe')
    const call = h.mgr.startAgent(parent, { task: 'needs a yes', wait: false })
    const cardIn = (id: string) => h.mgr.listSessions().find((s) => s.id === id)?.pendingApproval
    await until(() => cardIn(parent)?.detail.kind === 'agent_start')
    const requestId = cardIn(parent)!.requestId
    const heir = await handOff(h, project, parent)

    expect(store.listAgentStartRequests()).toEqual([expect.objectContaining({ requestId, callerSessionId: heir, request: expect.objectContaining({ callerId: heir }) })])
    // Closed in the original (deleted here, as a handoff does by default) and never raised there again
    expect(events.filter((e) => e.type === 'approval_request' && e.sessionId === parent)).toHaveLength(1)
    // The new session's first turn (reading the note) hides the card; it stands again when that turn ends (#673)
    h.claude.handles.get(heir)!.answer('I have read the note')
    await until(() => cardIn(heir)?.requestId === requestId)
    expect(readFileSync(handoffNotePath(project, parent), 'utf8')).toContain(`handle: ${requestId}`)
    h.mgr.respondApproval(heir, requestId, 'allow')
    await call
    await until(() => h.mgr.listSessions().some((s) => s.askedBy === heir))
    const child = h.mgr.listSessions().find((s) => s.askedBy === heir)!.id
    expect(store.listAgentStartRequests()).toEqual([])
    expect(await h.mgr.agentSession(heir, { sessionId: child, action: 'status' })).toMatchObject({ ok: true, sessionId: child })
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
    expect(store.listReportMarks()).toEqual([{ sessionId: child, callerSessionId: parent }])
    expect(store.listDelegatedTurns()).toEqual([expect.objectContaining({ sessionId: child, callerSessionId: parent })])
    // The host's memory agrees with the store: the original still owns it, the new session does not
    expect(await h.mgr.agentSession(parent, { sessionId: child, action: 'status' })).toMatchObject({ ok: true, state: 'working' })
    expect(await h.mgr.agentSession(heir, { sessionId: child, action: 'status' })).toMatchObject({ ok: false })
    expect(readFileSync(handoffNotePath(project, parent), 'utf8')).toBe('NOTE BODY: where things stand')

    await h.mgr.detachAll()
    const next = host(new Set([child]))
    await next.mgr.adoptKept([{ sessionId: child, tool: 'claude', process: new FakeProcess() as unknown as AgentProcess }])
    expect(next.mgr.listSessions().find((s) => s.id === child)!.askedBy).toBe(parent)
    next.claude.handles.get(child)!.answer('finished under the next host')
    await until(() => reports(next.claude.handles.get(parent), child).length === 1)
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
    await until(() => reports(next.claude.handles.get(heir), child).length === 1)
  })
})

describe("a handoff moves the original's ask_project delegations (#693)", () => {
  it('lets the new session wait on the answer the original never read, with ask_project', async () => {
    const w = await crossWorld()
    try {
      const target = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
      w.mgr.rename(target, 'Sprites')
      const caller = await w.callerSession()
      w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
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
      expect(readFileSync(handoffNotePath(w.caller.id, caller), 'utf8')).toContain(`"Sprites" (project ${w.target.name}, through ask_project) — working — handle: ${target}`)
      expect(w.store.listDelegatedTurns()).toEqual([expect.objectContaining({ sessionId: target, callerSessionId: heir })])
      // The other project's session is not the new session's child: its owner on the row stays as it was
      expect(w.store.listSessions().find((s) => s.id === target)?.askedBy ?? null).toBeNull()
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
