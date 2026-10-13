import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AdapterCapabilities, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter, AgentProcess, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager, type AgentProcessHost } from './manager.js'

/**
 * "You will be told when it ends" across a host swap (#646): a parent that started an agent without waiting is told
 * when the child's turn ends, even when that turn ends under the next host. The leaving host lets go of the child's
 * process, the keeper keeps it, and the next host adopts it (#280 step 2) and finds the report it still owes in the
 * store's `report_marks`.
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
  /** Set by a test: the turn ends while the leaving host lets the process go */
  endOnDetach?: string
  async detach() {
    if (this.endOnDetach) this.answer(this.endOnDetach)
  }
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
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-report-marks-')))
  events = []
})
afterEach(async () => {
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

/** A parent that started a child without waiting, told it will hear when the child's turn ends */
async function parentAndChild(h: ReturnType<typeof host>) {
  const project = await h.mgr.addProject(root)
  h.mgr.setProjectTrusted(project.id, true)
  store.setProjectConsent(project.id, project.id, 'agents')
  const parent = (await h.mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal' })).id
  const started = await h.mgr.startAgent(parent, { task: 'long work', wait: false })
  if (!started.ok) throw new Error(started.error)
  expect(started).toMatchObject({ state: 'working', reported: true })
  return { parent, child: started.sessionId }
}

/** What reaches the parent's model is a wake naming the source; the report's text is in the parent's conversation */
const reports = (h: Handle | undefined, child: string) => (h?.sent ?? []).filter((t) => t.includes(`sourceSessionId: ${child}`))
const stored = (parent: string) => store.loadMessages(parent, 20).map((m) => JSON.stringify(m.payload)).filter((t) => t.includes('The assigned work finished'))

describe('the report a child owes its parent, across a host swap (#646)', () => {
  it('is written to the store when it is asked for, and cleared once delivered', async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    expect(store.listReportMarks()).toEqual([{ sessionId: child, callerSessionId: parent }])
    a.claude.handles.get(child)!.answer('done here')
    await until(() => reports(a.claude.handles.get(parent), child).length === 1)
    expect(store.listReportMarks()).toEqual([])
  })

  it('reaches the parent from the next host, which adopted the kept child and found the mark in the store', async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    await a.mgr.detachAll()
    // Letting go is not the end of the child's turn: no failure report, and the mark stays for the next host
    expect(store.loadMessages(parent, 20).map((m) => JSON.stringify(m.payload)).filter((t) => t.includes('[Centralu] The assigned work'))).toEqual([])
    expect(store.listReportMarks()).toEqual([{ sessionId: child, callerSessionId: parent }])

    const b = host(new Set([child]))
    await b.mgr.adoptKept([{ sessionId: child, tool: 'claude', process: new FakeProcess() as unknown as AgentProcess }])
    expect(b.mgr.listSessions().find((s) => s.id === child)!.state).toBe('working')
    // Only the next host's handles exist now: the parent hears nothing through the old host's
    b.claude.handles.get(child)!.answer('finished under the new host')
    await until(() => reports(b.claude.handles.get(parent), child).length === 1)
    expect(stored(parent)).toHaveLength(1)
    expect(stored(parent)[0]).toContain('finished under the new host')
    expect(reports(a.claude.handles.get(parent), child)).toEqual([])
    expect(store.listReportMarks()).toEqual([])
    // Delivered once: a later turn of the child is the child's own
    b.claude.handles.get(child)!.answer('a later, unrelated turn')
    await new Promise((r) => setTimeout(r, 20))
    expect(reports(b.claude.handles.get(parent), child)).toHaveLength(1)
  })

  it('is dropped when the kept child finished its turn while the old host let go, so a later turn of the person is not reported (#166)', async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    a.claude.handles.get(child)!.endOnDetach = 'finished during the swap'
    await a.mgr.detachAll()
    expect(store.listSessions().find((s) => s.id === child)!.state).toBe('waiting_input')

    const b = host(new Set([child]))
    await b.mgr.adoptKept([{ sessionId: child, tool: 'claude', process: new FakeProcess() as unknown as AgentProcess }])
    expect(store.listReportMarks()).toEqual([])
    expect(b.mgr.waitsOn(parent)).not.toContain(child)
    // The answer it finished with is there for the parent to read
    expect(await b.mgr.agentSession(parent, { sessionId: child, action: 'status' })).toMatchObject({ ok: true, state: 'at_rest', answer: 'finished during the swap' })
    // The person's own turn in the child afterwards is the child's, not the assigned work
    await b.mgr.send(child, 'person work')
    b.claude.handles.get(child)!.answer('person answer')
    await new Promise((r) => setTimeout(r, 20))
    expect(reports(b.claude.handles.get(parent), child)).toEqual([])
    expect(stored(parent)).toEqual([])
  })

  it('is dropped by a host that finds no process for the child: that turn died with the old host', async () => {
    const a = host()
    const { child } = await parentAndChild(a)
    await a.mgr.detachAll()

    const c = host()
    expect(c.mgr.listSessions().find((s) => s.id === child)!.state).toBe('idle')
    expect(store.listReportMarks()).toEqual([])
    expect(c.mgr.waitsOn((await parentAndChild(c)).parent)).not.toContain(child)
  })

  it('goes with the child or the parent when either is trashed', async () => {
    const a = host()
    const { parent, child } = await parentAndChild(a)
    await a.mgr.trashSession(child)
    expect(store.listReportMarks()).toEqual([])

    const second = await parentAndChild(a)
    expect(store.listReportMarks()).toEqual([{ sessionId: second.child, callerSessionId: second.parent }])
    await a.mgr.trashSession(second.parent)
    expect(store.listReportMarks()).toEqual([])
    expect(a.mgr.waitsOn(parent)).toEqual([])
  })
})
