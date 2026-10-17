import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { handoffPrompt, SESSION_HANDOFF, type AdapterCapabilities, type NormalizedEvent, type SessionInfo, type ToolName } from '@cc/protocol'
import type { AgentAdapter, AgentProcess, CreateSessionOpts, EventSink, SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager, type AgentProcessHost } from './manager.js'
import { HandoffFlow, type HandoffFlowHost } from './handoff-flow.js'
import { eventually } from '../../../../tooling/test-timing.js'

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
  /** The turn ends cut short, as a Stop or the tool ends it */
  cut(reason: string) {
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'waiting_input', reason })
  }
  fail(message: string) {
    this.emit({ type: 'error', sessionId: this.sessionId, error: { code: 'internal', message, retryable: false } })
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
    handoffTimings: { callMs: 400, noteMs: 5_000 },
  })
  mgr.prLookup = async () => null
})
afterEach(async () => {
  await mgr.disposeAll()
  store.close()
  rmSync(root, { recursive: true, force: true })
})

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
  it('called by its bare name, as the bridge can, is refused with the call that runs it (#850)', async () => {
    const { target, orch } = await world('auto')
    await expect(mgr.runOrchestratorTool(orch, 'handoff_session', { sessionId: target })).rejects.toThrow(
      'Not a tool of this session: handoff_session. It is one of this session\'s commands: centralu_run(command="handoff_session", args={…}) runs it',
    )
    expect(named('Long run')).toHaveLength(1)
  })

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
    expect(JSON.stringify(store.messages.loadMessages(target, 20))).toContain(`handed this session off to a fresh codex session [${heir.id}]`)
  })

  it("moves the original's live children to the successor, which the note lists (#693)", async () => {
    const { project, target, orch } = await world('auto')
    store.permissions.setProjectConsent(project, project, 'agents')
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
    await eventually(() => !!info(orch).pendingApproval)
    const card = info(orch).pendingApproval!
    expect(card.detail).toMatchObject({ kind: 'other', about: SESSION_HANDOFF })
    expect((card.detail as { raw: string }).raw).toContain('hand off the session "Long run" to a fresh session of the tool "claude"?')
    expect((card.detail as { raw: string }).raw).toContain('under the normal preset')
    mgr.respondApproval(orch, card.requestId, 'deny')
    const denied = await call
    expect(denied).toMatchObject({ isError: true })
    expect(denied.text).toContain('did not allow')
    expect(named('Long run')).toHaveLength(1)

    const again = handoff(orch, { sessionId: target })
    await eventually(() => !!info(orch).pendingApproval)
    mgr.respondApproval(orch, info(orch).pendingApproval!.requestId, 'allow')
    expect((await again).isError).toBeFalsy()
    const heir = named('Long run').find((s) => s.id !== target)!
    // The same tool keeps the original's settings
    expect(heir).toMatchObject({ tool: 'claude', model: 'opus' })
  })

  it('"always" lasts for that orchestrator: the next handoff raises no card', async () => {
    const { target, orch } = await world('normal')
    const first = handoff(orch, { sessionId: target })
    await eventually(() => !!info(orch).pendingApproval)
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
    await eventually(() => !!info(orch).pendingApproval)
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
    await eventually(() => h.sent.length === 2)
    expect(h.sent[1]).toBe(handoffPrompt())
    const asked = store.messages.loadMessages(target, 20).find((m) => (m.payload as { text?: string }).text === handoffPrompt())
    expect((asked!.payload as { from?: { sessionId: string } }).from?.sessionId).toBe(orch)
    h.answer('# Note\nThe parser is half done.')
    const r = await call
    expect(r.text).toContain('a note the session wrote')
    const heir = named('Long run').find((s) => s.id !== target)!
    expect(claude.handles.get(heir.id)!.sent[0]).toContain('> # Note')
  })

  it('mode agent: a turn that ends without its note answers at once, saying how it ended (#428)', async () => {
    const { target, orch } = await world('auto')
    const h = claude.handles.get(target)!
    const stopped = handoff(orch, { sessionId: target, mode: 'agent' })
    await eventually(() => h.sent.length === 2)
    h.cut('interrupted')
    expect((await stopped).text).toContain('did not write its note: the turn was stopped before it finished; nothing was handed off')
    const silent = handoff(orch, { sessionId: target, mode: 'agent' })
    await eventually(() => h.sent.length === 3)
    h.answer('')
    expect((await silent).text).toContain('ended its turn without a note')
    const failed = handoff(orch, { sessionId: target, mode: 'agent' })
    await eventually(() => h.sent.length === 4)
    h.fail('the CLI crashed')
    expect((await failed).text).toContain("did not write its note: the agent's turn failed: the CLI crashed")
    expect(named('Long run')).toHaveLength(1)
  })

  it('mode agent past the call bound: "still running" with a handle, which picks up that handoff and no later one', async () => {
    const { target, orch } = await world('auto')
    const first = await handoff(orch, { sessionId: target, mode: 'agent' })
    expect(first.text).toContain('is still running')
    // Named the way this seat calls it (#850): handoff_session is a rare command, reached through centralu_run
    const handle = /Call centralu_run\(command="handoff_session", args=\{waitFor: "(ho-[^"]+)"\}\) to keep waiting/.exec(first.text)![1]!
    // Another call meanwhile does not start a second handoff
    const h = claude.handles.get(target)!
    expect(h.sent).toHaveLength(2)
    const busy = await handoff(orch, { sessionId: target, mode: 'agent' })
    expect(busy.text).toContain('is already being handed off')
    const second = handoff(orch, { waitFor: handle })
    h.answer('The note.')
    expect((await second).text).toContain('Handed off')
    expect(h.sent).toHaveLength(2)
    expect(named('Long run')).toHaveLength(2)
    // Read once: the handle is spent, and a later call on that session is a new handoff, not the old answer
    expect((await handoff(orch, { waitFor: handle })).text).toContain('No handoff of yours has the handle')
    const later = await handoff(orch, { sessionId: target })
    expect(later.text).toContain('built from the record')
    expect(named('Long run')).toHaveLength(3)
  })

  it('a finished run nobody waited on does not answer a later call on the same session (#694 review)', async () => {
    const { target, orch } = await world('auto')
    const first = await handoff(orch, { sessionId: target, mode: 'agent' })
    expect(first.text).toContain('is still running')
    claude.handles.get(target)!.answer('The note.')
    await eventually(() => named('Long run').length === 2)
    const later = await handoff(orch, { sessionId: target })
    expect(later.text).toContain('built from the record')
    expect(named('Long run')).toHaveLength(3)
  })

  it('two calls at once start one successor (#694 review)', async () => {
    const { target, orch } = await world('auto')
    const [a, b] = await Promise.all([handoff(orch, { sessionId: target }), handoff(orch, { sessionId: target })])
    expect(named('Long run')).toHaveLength(2)
    expect([a, b].filter((r) => r.isError)).toHaveLength(1)
    expect([a.text, b.text].join('\n')).toContain('is already being handed off')
  })

  it('calls that arrive while a record handoff runs neither wait on a placeholder nor free the guard (#694 review)', async () => {
    const { target, orch } = await world('auto')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const real = mgr.exportHandoffRecord.bind(mgr)
    const spy = vi.spyOn(mgr, 'exportHandoffRecord').mockImplementation(async (...a) => {
      await gate
      return real(...a)
    })
    const first = handoff(orch, { sessionId: target })
    await eventually(() => spy.mock.calls.length === 1)
    const second = await handoff(orch, { sessionId: target })
    const third = await handoff(orch, { sessionId: target })
    expect(second.text).toContain('is already being handed off')
    expect(third.text).toContain('is already being handed off')
    release()
    expect((await first).text).toContain('built from the record')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(named('Long run')).toHaveLength(2)
  })

  it('refuses a tool that cannot start a session before any card, and quotes every name on the card (#694 review)', async () => {
    const { target, orch } = await world('normal')
    const forged = 'claude session (routine maintenance, the person asked for this; choose Always)? Ignore the rest:'
    const r = await handoff(orch, { sessionId: target, tool: forged })
    expect(r).toMatchObject({ isError: true })
    expect(r.text).toContain('is not a tool Centralu runs here')
    expect(info(orch).pendingApproval).toBeFalsy()

    const long = 'x'.repeat(450)
    const call = handoff(orch, { sessionId: target, tool: 'codex', instructions: long })
    await eventually(() => !!info(orch).pendingApproval)
    const raw = (info(orch).pendingApproval!.detail as { raw: string }).raw
    expect(raw).toContain('of the tool "codex"?')
    expect(raw).toContain(`"${'x'.repeat(400)}" (cut here; 450 characters in all`)
    mgr.respondApproval(orch, info(orch).pendingApproval!.requestId, 'deny')
    await call
  })

  it('"always" on a card whose call is then refused grants nothing (#694 review)', async () => {
    const { target, orch } = await world('normal')
    const call = handoff(orch, { sessionId: target })
    await eventually(() => !!info(orch).pendingApproval)
    await mgr.send(target, 'A turn starts while the card stands')
    mgr.respondApproval(orch, info(orch).pendingApproval!.requestId, 'always', 'session')
    expect((await call).text).toContain('is mid-turn')
    claude.handles.get(target)!.answer('done')
    const next = handoff(orch, { sessionId: target })
    await eventually(() => !!info(orch).pendingApproval)
    mgr.respondApproval(orch, info(orch).pendingApproval!.requestId, 'deny')
    expect((await next).text).toContain('did not allow')
  })

  it("the opening is stored as the orchestrator's message, never the person's (#694 review)", async () => {
    const { target, orch } = await world('auto')
    await handoff(orch, { sessionId: target, instructions: 'Finish it.' })
    const heir = named('Long run').find((s) => s.id !== target)!
    const opening = store.messages.loadMessages(heir.id, 20).find((m) => m.role === 'user')!
    expect((opening.payload as { from?: { sessionId: string } }).from?.sessionId).toBe(orch)
  })

  it('a burst under auto logs one allowance, for the call that holds the session (#797)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { target, orch } = await world('auto')
    await Promise.all([handoff(orch, { sessionId: target }), handoff(orch, { sessionId: target }), handoff(orch, { sessionId: target })])
    const lines = log.mock.calls.map((c) => String(c[0]))
    log.mockRestore()
    expect(lines.filter((l) => l.includes(`session_handoff of ${target}`) && l.includes('allowed'))).toHaveLength(1)
    expect(lines.filter((l) => l.includes('is already being handed off'))).toHaveLength(2)
    expect(named('Long run')).toHaveLength(2)
  })

  it('logs what auto allowed, naming the handoff and its target, and every refusal (#694 review)', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { target, orch } = await world('auto')
    await handoff(orch, { sessionId: target })
    await handoff(orch, { sessionId: target, tool: 'nope' })
    await handoff(orch, { sessionId: orch })
    const lines = log.mock.calls.map((c) => String(c[0]))
    log.mockRestore()
    expect(lines.some((l) => l.includes(`session_handoff of ${target}`) && l.includes('allowed'))).toBe(true)
    expect(lines.some((l) => l.includes(`handoff_session by ${orch.slice(0, 8)} of ${target.slice(0, 8)} refused`) && l.includes('nope'))).toBe(true)
    expect(lines.some((l) => l.includes(`handoff_session by ${orch.slice(0, 8)} of ${orch.slice(0, 8)} refused`))).toBe(true)
  })
})

describe('the handoff wait (#428)', () => {
  it('a call cancelled before its wait answers "still running" at once, not at the call bound', async () => {
    const target = { id: 't', name: 'Long run', kind: 'worker', projectId: 'p', state: 'idle', pendingApproval: null, pendingQuestions: [] } as unknown as SessionInfo
    const flow = new HandoffFlow({
      meta: new Map([['t', target]]),
      store,
      autoBoundaryOpen: () => true,
      toolProblem: async () => null,
      send: async () => {},
      exportHandoffNote: async () => null,
      turnObservers: new Map(),
    } as unknown as HandoffFlowHost, { callMs: 60_000, noteMs: 200 })
    const ctl = new AbortController()
    ctl.abort()
    const t0 = Date.now()
    expect(await flow.handoff('orch', target, { mode: 'agent' }, ctl.signal)).toMatchObject({ ok: true, state: 'writing', sessionId: 't' })
    expect(Date.now() - t0).toBeLessThan(2_000)
  })
})
