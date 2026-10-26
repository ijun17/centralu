import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ApprovalDecision, ProjectInfo, SessionInfo, StoredMessage, SubagentStepsHeld, ToolName, TrashedSession, TrashedSubagentSteps } from '@cc/protocol'
import type { AgentAdapter, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'
import { createRpcHandler } from '../rpc.js'

/**
 * #418 through the RPC: a session's subagent steps, listed with what they take, archived while the session
 * stays, restored under their cards, and deleted for good one at a time or with the rest of the session archive. The store's side
 * is store-subagent-trash.test.ts.
 */

class QuietHandle implements SessionHandle {
  externalId = 'ext-1'
  constructor(readonly sessionId: string, private emit: EventSink) {}
  send() {
    this.emit({ type: 'turn_complete', sessionId: this.sessionId })
  }
  respondApproval(_requestId: string, _decision: ApprovalDecision): boolean {
    return true
  }
  interrupt() {}
  async dispose() {}
}

class QuietAdapter implements AgentAdapter {
  readonly tool: ToolName = 'claude'
  readonly descriptor = { name: 'claude', label: 'Claude Code', mark: 'C', install: 'x', login: 'x' }
  readonly capabilities = {
    approvals: true, contextUsage: 'exact' as const, resume: true, autoTitle: true, attachments: [],
    verbosities: [], exclusiveWriter: false, backgroundTasks: false,
  }
  async detect() {
    return { tool: this.tool, installed: true, loggedIn: true, detail: 'quiet' }
  }
  async createSession(opts: CreateSessionOpts, emit: EventSink) {
    return new QuietHandle(opts.sessionId, emit)
  }
}

let root = ''
let store: Store
let rpc: ReturnType<typeof createRpcHandler>

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-subagent-trash-')))
  store = new Store()
  const adapters = new Map<ToolName, AgentAdapter>([['claude', new QuietAdapter()]])
  rpc = createRpcHandler(new SessionManager(store, adapters, () => {}), adapters)
})

afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

const AGENT = 'toolu_agent'
const project = async () => (await rpc('projects.add', { path: mkdtempSync(join(root, 'p-')) })) as ProjectInfo
const newSession = async (p: ProjectInfo) => (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as SessionInfo
const steps = (sessionId: string, n: number) => {
  for (let i = 1; i <= n; i++) {
    store.messages.appendSubagentMessage(sessionId, AGENT, {
      role: 'assistant', kind: 'text', payload: { type: 'message_delta', sessionId, role: 'assistant', text: `step ${i}` }, ts: i,
    })
  }
}
const usage = async () => ((await rpc('subagents.usage', {})) as { sessions: SubagentStepsHeld[] }).sessions
const trash = async () => (await rpc('trash.list', {})) as { sessions: TrashedSession[]; bytes: number; subagentSteps: TrashedSubagentSteps[] }
const card = async (sessionId: string) => (await rpc('messages.subagent', { sessionId, parentCallId: AGENT })) as StoredMessage[]
const trashedOnCard = async (sessionId: string) => (await rpc('messages.subagentTrashed', { sessionId, parentCallId: AGENT })) as { steps: number }

describe("a session's subagent steps, to the session archive and back without the session (#418)", () => {
  it('lists what they take, moves them, says so on the card, and restores them', async () => {
    const p = await project()
    const s = await newSession(p)
    steps(s.id, 4)
    const [held] = await usage()
    expect(held).toMatchObject({ sessionId: s.id, name: s.name, tool: 'claude', project: { id: p.id, name: p.name }, runs: 1, steps: 4 })
    expect(held!.bytes).toBeGreaterThan(0)

    expect(await rpc('subagents.trash', { sessionId: s.id })).toEqual({ steps: 4, bytes: held!.bytes })
    expect(await usage()).toEqual([])
    expect(await card(s.id)).toEqual([])
    expect(await trashedOnCard(s.id)).toEqual({ steps: 4 })
    // The session is where it was
    expect(((await rpc('sessions.list', {})) as SessionInfo[]).map((x) => x.id)).toContain(s.id)
    const t = await trash()
    expect(t.sessions).toEqual([])
    expect(t.subagentSteps).toEqual([{ ...held, deletedAt: expect.any(Number) }])
    expect(t.bytes).toBe(held!.bytes)

    await rpc('trash.restoreSubagentSteps', { sessionId: s.id })
    expect((await card(s.id)).map((r) => r.seq)).toEqual([1, 2, 3, 4])
    expect(await trashedOnCard(s.id)).toEqual({ steps: 0 })
    expect((await trash()).subagentSteps).toEqual([])
  })

  it('deletes them for good from the session archive, one session at a time or with the rest, and keeps the session', async () => {
    const p = await project()
    const a = await newSession(p)
    const b = await newSession(p)
    const c = await newSession(p)
    steps(a.id, 2)
    steps(b.id, 3)
    steps(c.id, 1)
    await rpc('subagents.trash', { sessionId: a.id })
    await rpc('subagents.trash', { sessionId: b.id })
    await rpc('agents.deleteSession', { sessionId: c.id })

    const listed = (await trash()).subagentSteps
    const upTo = (id: string) => listed.find((x) => x.sessionId === id)!.deletedAt
    await rpc('trash.purgeSubagentSteps', { sessionId: a.id, upTo: upTo(a.id) })
    expect((await trash()).subagentSteps.map((x) => x.sessionId)).toEqual([b.id])
    expect(await trashedOnCard(a.id)).toEqual({ steps: 0 })
    // Named as the person knows it, never by its id
    await expect(rpc('trash.restoreSubagentSteps', { sessionId: a.id })).rejects.toMatchObject({
      code: 'session_not_found',
      message: `No subagent steps of “${a.name}” are in the session archive`,
    })

    // Emptying the session archive deletes the sessions in it, never subagent steps: the window deletes each entry it listed
    expect(await rpc('trash.empty', {})).toEqual({ purged: 1, failed: [] })
    expect((await trash()).subagentSteps.map((x) => x.sessionId)).toEqual([b.id])
    await rpc('trash.purgeSubagentSteps', { sessionId: b.id, upTo: upTo(b.id) })
    expect(await trash()).toEqual({ sessions: [], runs: [], bytes: 0, subagentSteps: [] })
    expect(((await rpc('sessions.list', {})) as SessionInfo[]).map((x) => x.id).sort()).toEqual([a.id, b.id].sort())
  })

  // #418 review: both ways of deleting for good took steps moved after the window read the session archive
  it('steps moved after the window read the session archive survive deleting the entry it listed, and deleting all archived sessions', async () => {
    const p = await project()
    const s = await newSession(p)
    steps(s.id, 2)
    await rpc('subagents.trash', { sessionId: s.id })
    const [seen] = (await trash()).subagentSteps
    // Another window moves more of the session's steps after this one read the session archive
    store.messages.appendSubagentMessage(s.id, 'toolu_later', { role: 'assistant', kind: 'text', payload: { type: 'message_delta', sessionId: s.id, role: 'assistant', text: 'later' }, ts: 9 })
    await rpc('subagents.trash', { sessionId: s.id })

    await rpc('trash.empty', {})
    expect((await trash()).subagentSteps).toEqual([expect.objectContaining({ sessionId: s.id, runs: 2, steps: 3 })])
    await rpc('trash.purgeSubagentSteps', { sessionId: s.id, upTo: seen!.deletedAt })
    expect((await trash()).subagentSteps).toEqual([expect.objectContaining({ sessionId: s.id, runs: 1, steps: 1 })])
    expect(await rpc('messages.subagentTrashed', { sessionId: s.id, parentCallId: 'toolu_later' })).toEqual({ steps: 1 })
  })

  it('refuses a session that is not live: unknown, or in the session archive', async () => {
    const p = await project()
    const s = await newSession(p)
    steps(s.id, 1)
    await expect(rpc('subagents.trash', { sessionId: 'nobody' })).rejects.toMatchObject({
      code: 'session_not_found',
      message: 'That session is no longer here: it was deleted, or is in the session archive',
    })
    await rpc('agents.deleteSession', { sessionId: s.id })
    await expect(rpc('subagents.trash', { sessionId: s.id })).rejects.toMatchObject({ code: 'session_not_found' })
    // Its steps are in its own trash entry, not listed again
    expect(await usage()).toEqual([])
    expect((await trash()).subagentSteps).toEqual([])
  })
})

// That only the RPC handler and deleting all archived sessions purge subagent steps is the lint rule `guard/subagent-purge-callers` (tooling/eslint-guards.js, #1606)
