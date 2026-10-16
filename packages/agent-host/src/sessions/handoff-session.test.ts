import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { handoffPrompt, SESSION_HANDOFF, type AdapterCapabilities, type NormalizedEvent, type SessionInfo, type ToolName } from '@cc/protocol'
import type { AgentAdapter, AgentProcess, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager, type AgentProcessHost } from './manager.js'

/**
 * The orchestrator's handoff_session (#694) over the real manager: who may hand off what, the person's card unless
 * the orchestrator is `auto`, the note from the record by default or written by the session, the original kept and its
 * live children moved (#693). The window's own handoff is the UI store's (`handoffSession`); this is the tool's path.
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
    this.externalId = `ext-${sessionId}`
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
  handles = new Map<string, Handle>()
  readonly capabilities: AdapterCapabilities = {
    approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false,
  }
  constructor(readonly tool: ToolName) {}
  get descriptor() {
    return { name: this.tool, label: this.tool, mark: 'X', install: 'x', login: 'x' }
  }
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
let mgr: SessionManager
let claude: Adapter
let codex: Adapter

beforeEach(() => {
  store = new Store()
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-handoff-session-')))
  claude = new Adapter('claude')
  codex = new Adapter('codex')
  const adapters = new Map<ToolName, AgentAdapter>([['claude', claude], ['codex', codex]])
  mgr = new SessionManager(store, adapters, (_e: NormalizedEvent) => {}, undefined, join(root, 'worktrees'), {
    processes,
    handoffTimings: { pollMs: 5, callMs: 400, noteMs: 5_000 },
  })
  mgr.prLookup = async () => null
})
afterEach(async () => {
  await mgr.disposeAll()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

const until = async (ok: () => boolean, ms = 3000) => {
  const end = Date.now() + ms
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

const info = (id: string): SessionInfo => mgr.listSessions().find((s) => s.id === id)!
const named = (name: string) => mgr.listSessions().filter((s) => s.name === name)

/** A project with one ordinary session that has said something, and the orchestrator under `preset` */
async function world(preset: 'normal' | 'auto' = 'normal') {
  const project = await mgr.addProject(root)
  mgr.setProjectTrusted(project.id, true)
  const target = (await mgr.createSession({ projectId: project.id, cwd: root, tool: 'claude', permissionPreset: 'normal', model: 'opus' })).id
  mgr.rename(target, 'Long run')
  await mgr.send(target, 'Build the parser')
  claude.handles.get(target)!.answer('Parser half done; tests in parser.test.ts')
  const orch = (await mgr.orchestrator()).id
  if (preset === 'auto') await mgr.updateSettings(orch, { permissionPreset: 'auto' })
  return { project: project.id, target, orch }
}

/** handoff_session as the orchestrator calls it by default: through centralu_run (the commands tier, #512) */
const handoff = (orch: string, args: Record<string, unknown>) => mgr.runOrchestratorTool(orch, 'centralu_run', { command: 'handoff_session', args })

describe('handoff_session (#694)', () => {
  it('under auto: the note comes from the record, the successor takes the name and the instructions, and the original stays', async () => {
    const { target, orch } = await world('auto')
    const r = await handoff(orch, { sessionId: target, tool: 'codex', instructions: 'Finish the parser, then stop.' })
    expect(r.isError).toBeFalsy()
    expect(r.text).toContain('built from the record')
    // No card was raised: auto opens this boundary (#603)
    expect(info(orch).pendingApproval).toBeFalsy()
    const both = named('Long run')
    expect(both).toHaveLength(2)
    const heir = both.find((s) => s.id !== target)!
    expect(heir).toMatchObject({ tool: 'codex', permissionPreset: 'normal', model: null })
    // The original was never asked anything: its only message is the person's
    expect(claude.handles.get(target)!.sent).toEqual(['Build the parser'])
    const opening = codex.handles.get(heir.id)!.sent[0]!
    expect(opening).toContain('You are taking over from a session named "Long run"')
    expect(opening).toMatch(/started this handoff and adds[^\n]*\n\n> Finish the parser, then stop\./)
    const path = /`([^`]+\.md)`/.exec(opening)![1]!
    expect(readFileSync(path, 'utf8')).toContain('Parser half done')
    // The original stays, told where its work went
    expect(info(target)).toBeTruthy()
    expect(JSON.stringify(store.loadMessages(target, 20))).toContain(`handed this session off to a fresh codex session [${heir.id}]`)
  })

  it("moves the original's live children to the successor, which the note lists (#693)", async () => {
    const { project, target, orch } = await world('auto')
    store.setProjectConsent(project, project, 'agents')
    const started = await mgr.startAgent(target, { task: 'Write the lexer', wait: false })
    if (!started.ok) throw new Error(started.error)
    const child = started.sessionId
    claude.handles.get(target)!.answer('Started the lexer child')
    expect((await handoff(orch, { sessionId: target })).isError).toBeFalsy()
    const heir = named('Long run').find((s) => s.id !== target)!
    expect(info(child).askedBy).toBe(heir.id)
    const path = /`([^`]+\.md)`/.exec(claude.handles.get(heir.id)!.sent[0]!)![1]!
    expect(readFileSync(path, 'utf8')).toContain(`handle: ${child}`)
  })

  it('under normal: a card in the orchestrator asks the person; a refusal starts nothing, an allowance hands off', async () => {
    const { target, orch } = await world('normal')
    const call = handoff(orch, { sessionId: target })
    await until(() => !!info(orch).pendingApproval)
    const card = info(orch).pendingApproval!
    expect(card.detail).toMatchObject({ kind: 'other', about: SESSION_HANDOFF })
    expect((card.detail as { raw: string }).raw).toContain('hand off "Long run" to a fresh claude session')
    expect((card.detail as { raw: string }).raw).toContain('under the normal preset')
    mgr.respondApproval(orch, card.requestId, 'deny')
    const denied = await call
    expect(denied).toMatchObject({ isError: true })
    expect(denied.text).toContain('did not allow')
    expect(named('Long run')).toHaveLength(1)

    const again = handoff(orch, { sessionId: target })
    await until(() => !!info(orch).pendingApproval)
    mgr.respondApproval(orch, info(orch).pendingApproval!.requestId, 'allow')
    expect((await again).isError).toBeFalsy()
    const heir = named('Long run').find((s) => s.id !== target)!
    // The same tool keeps the original's settings
    expect(heir).toMatchObject({ tool: 'claude', model: 'opus' })
  })

  it('"always" lasts for that orchestrator: the next handoff raises no card', async () => {
    const { target, orch } = await world('normal')
    const first = handoff(orch, { sessionId: target })
    await until(() => !!info(orch).pendingApproval)
    mgr.respondApproval(orch, info(orch).pendingApproval!.requestId, 'always', 'session')
    expect((await first).isError).toBeFalsy()
    const r = await handoff(orch, { sessionId: target })
    expect(r.isError).toBeFalsy()
    expect(named('Long run')).toHaveLength(3)
  })

  it('refuses a session mid-turn without asking anyone, and checks again after the card', async () => {
    const { target, orch } = await world('normal')
    await mgr.send(target, 'Keep going')
    const busy = await handoff(orch, { sessionId: target })
    expect(busy).toMatchObject({ isError: true })
    expect(busy.text).toContain('is mid-turn (working)')
    expect(info(orch).pendingApproval).toBeFalsy()
    claude.handles.get(target)!.answer('done')

    // A turn that starts while the card stands is not cut short by the allowance
    const call = handoff(orch, { sessionId: target })
    await until(() => !!info(orch).pendingApproval)
    await mgr.send(target, 'One more thing')
    mgr.respondApproval(orch, info(orch).pendingApproval!.requestId, 'allow')
    const late = await call
    expect(late).toMatchObject({ isError: true })
    expect(late.text).toContain('is mid-turn')
    expect(named('Long run')).toHaveLength(1)
  })

  it("refuses what is not a project's ordinary session of this computer, even under auto", async () => {
    const { project, orch } = await world('auto')
    const self = await handoff(orch, { sessionId: orch })
    expect(self.text).toContain('does not hand itself off')
    const app = (await mgr.createSession({ projectId: project, cwd: root, tool: 'claude', permissionPreset: 'normal', appId: 'notes' })).id
    expect((await handoff(orch, { sessionId: app })).text).toContain('belongs to an app')
    expect((await handoff(orch, { sessionId: 'nobody' })).text).toContain('Not a session this app manages')
    expect(mgr.listSessions()).toHaveLength(3)
  })

  it('is not a tool of an ordinary session: it cannot hand off itself or a neighbour', async () => {
    const { project, target } = await world('auto')
    const other = (await mgr.createSession({ projectId: project, cwd: root, tool: 'claude', permissionPreset: 'auto' })).id
    for (const name of ['handoff_session', 'centralu_run']) {
      await expect(mgr.runOrchestratorTool(other, name, { sessionId: target, command: 'handoff_session' })).rejects.toThrow('Not a tool of this session')
    }
  })

  it('mode agent: the session is asked, by the orchestrator, and its reply is the note', async () => {
    const { target, orch } = await world('auto')
    const call = handoff(orch, { sessionId: target, mode: 'agent' })
    const h = claude.handles.get(target)!
    await until(() => h.sent.length === 2)
    expect(h.sent[1]).toBe(handoffPrompt())
    const asked = store.loadMessages(target, 20).find((m) => (m.payload as { text?: string }).text === handoffPrompt())
    expect((asked!.payload as { from?: { sessionId: string } }).from?.sessionId).toBe(orch)
    h.answer('# Note\nThe parser is half done.')
    const r = await call
    expect(r.text).toContain('a note the session wrote')
    const heir = named('Long run').find((s) => s.id !== target)!
    expect(claude.handles.get(heir.id)!.sent[0]).toContain('> # Note')
  })

  it('mode agent past the call bound: "still writing", and calling again picks up the handoff', async () => {
    const { target, orch } = await world('auto')
    const first = await handoff(orch, { sessionId: target, mode: 'agent' })
    expect(first.text).toContain('is still writing its handoff note')
    // Another call meanwhile does not start a second handoff
    const h = claude.handles.get(target)!
    expect(h.sent).toHaveLength(2)
    const second = handoff(orch, { sessionId: target, mode: 'agent' })
    h.answer('The note.')
    expect((await second).text).toContain('Handed off')
    expect(h.sent).toHaveLength(2)
    expect(named('Long run')).toHaveLength(2)
  })
})
