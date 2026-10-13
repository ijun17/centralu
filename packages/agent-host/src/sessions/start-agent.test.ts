import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionPreset } from '@cc/protocol'
import { AGENT_TOOLS, runOrchestratorTool } from './orchestrator-tools.js'
import { ASK_WAIT_MS } from './ask-project.js'
import { CrossAdapter, crossWorld, type CrossWorld } from './cross-project.test-helpers.js'
import { AGENT_CEILING, agentBranch, agentNoteFrame, presetWithin } from './start-agent.js'
import { SessionManager } from './manager.js'
import { createRpcHandler } from '../rpc.js'
import { START_AGENT_MODEL_CHECK_MS, START_AGENT_SETUP_MS } from './manager.js'
import type { ModelOption } from '@cc/protocol'

/**
 * start_agent and agent_session (#561): an ordinary session starts another agent in its own project — behind the
 * person's consent, never with more permissions than its own, one level deep, a few at a time — and works only with
 * the children it started.
 */

describe('the preset rule', () => {
  it('a parent follow-up is a note about ongoing work, without the new-task/answer frame', () => {
    const frame = agentNoteFrame('parent', 'use Chromium')
    expect(frame).toContain('A note from the parent session "parent"')
    expect(frame).toContain('use Chromium')
    expect(frame).not.toContain('gives you this task')
    expect(frame).not.toContain('Your final message goes back')
  })
  it('a child may have the parent\'s preset or less, never more', () => {
    const order: PermissionPreset[] = ['safe', 'normal', 'auto']
    for (const [i, parent] of order.entries()) {
      for (const [j, child] of order.entries()) expect(presetWithin(child, parent)).toBe(j <= i)
    }
  })
})

describe('the branch named from a job (part 2)', () => {
  it('is a slug of the job under the prefix, with a few characters of the id; an empty slug is "agent"', () => {
    expect(agentBranch('Write the parser!', '1A2b-3c')).toBe('centralu/write-the-parser-1a2b')
    expect(agentBranch('파서를 써 줘', 'abcd')).toBe('centralu/agent-abcd')
    expect(agentBranch('a'.repeat(80), 'abcd')).toBe(`centralu/${'a'.repeat(40)}-abcd`)
    expect(agentBranch('fix: the --flag handling ', 'abcd')).toBe('centralu/fix-the-flag-handling-abcd')
  })
})

describe('starting another agent in the same project', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await w.dispose()
  })

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id) ?? w.adapters.get('codex')!.handles.get(id)
  const childrenOf = (id: string) => w.mgr.listSessions().filter((s) => s.askedBy === id)
  const session = async (preset: PermissionPreset = 'normal') =>
    (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: preset })).id
  const agentCard = (id: string) => {
    const p = w.mgr.listSessions().find((s) => s.id === id)?.pendingApproval
    return p?.detail.kind === 'agent_start' ? p : undefined
  }
  const allowProject = () => w.store.setProjectConsent(w.caller.id, w.caller.id, 'agents')
  /** Starts a child that keeps running, and returns its id */
  const startRunning = async (s: string, task = 'write it') => {
    const before = childrenOf(s).length
    const r = await w.mgr.startAgent(s, { task, wait: false })
    expect(r).toMatchObject({ ok: true, state: 'working' })
    await w.until(() => childrenOf(s).length === before + 1)
    return r.ok ? r.sessionId : ''
  }

  it('accepts a third registered CLI through the served schema and rejects unknown tools at call time', async () => {
    const third = new CrossAdapter('fixture-agent')
    w.adapters.set(third.tool, third)
    const s = await session()
    allowProject()
    const args = AGENT_TOOLS[0].schema.parse({ task: 'check', tool: third.tool, wait: false })
    const startAgent = (opts: Parameters<typeof w.mgr.startAgent>[1]) => w.mgr.startAgent(s, opts)
    const result = await runOrchestratorTool({ startAgent } as import('../adapters/contract.js').OrchestratorTools, 'start_agent', args, { sessionId: s, profile: 'reader' })
    expect(result.isError).not.toBe(true)
    expect(childrenOf(s)).toEqual([expect.objectContaining({ tool: third.tool })])
    expect(third.handles.size).toBe(1)

    const bad = AGENT_TOOLS[0].schema.parse({ task: 'check', tool: 'missing-cli' })
    expect(await runOrchestratorTool({ startAgent } as import('../adapters/contract.js').OrchestratorTools, 'start_agent', bad, { sessionId: s, profile: 'reader' })).toMatchObject({
      isError: true, text: 'No agent named "missing-cli" here. Installed tools: claude, codex, fixture-agent.',
    })
    expect(childrenOf(s)).toHaveLength(1)
  })

  describe('a model list that is slow or never answers (#660)', () => {
    const option = (id: string): ModelOption => ({ id, label: id, efforts: ['low', 'high'], defaultEffort: 'low', tiers: [] })
    const codex = () => w.adapters.get('codex')!
    const withList = (list: () => Promise<ModelOption[]>) => {
      const calls = { n: 0 }
      codex().listModels = () => {
        calls.n++
        return list()
      }
      return calls
    }

    it('starts the session anyway when the list never answers, within the bound, and says the model was not checked', async () => {
      allowProject()
      const s = await session()
      const calls = withList(() => new Promise<ModelOption[]>(() => {}))
      const t0 = Date.now()
      const r = await w.mgr.startAgent(s, { task: 'check it', tool: 'codex', model: 'gpt-x', wait: false })
      expect(Date.now() - t0).toBeLessThan(START_AGENT_MODEL_CHECK_MS + 4_000)
      expect(r).toMatchObject({ ok: true, state: 'working', notice: expect.stringContaining('not checked') })
      expect(childrenOf(s)).toEqual([expect.objectContaining({ tool: 'codex', model: 'gpt-x' })])
      expect(!r.ok ? '' : r.notice).toContain('"gpt-x"')

      // A read still pending is joined, not started again, so a hung tool does not get a process per call
      const again = await w.mgr.startAgent(s, { task: 'and again', tool: 'codex', model: 'gpt-x', wait: false })
      expect(again).toMatchObject({ ok: true })
      expect(calls.n).toBe(1)
    }, 20_000)

    it('keeps a list that arrives after the bound, and checks the next call against it', async () => {
      allowProject()
      const s = await session()
      const calls = withList(() => new Promise<ModelOption[]>((r) => setTimeout(() => r([option('gpt-real')]), START_AGENT_MODEL_CHECK_MS + 500)))
      const first = await w.mgr.startAgent(s, { task: 'one', tool: 'codex', model: 'gpt-typo', wait: false })
      expect(first).toMatchObject({ ok: true, notice: expect.stringContaining('not checked') })

      await new Promise((r) => setTimeout(r, 1_500))
      const second = await w.mgr.startAgent(s, { task: 'two', tool: 'codex', model: 'gpt-typo', wait: false })
      expect(second).toMatchObject({ ok: false, error: expect.stringContaining('has no model "gpt-typo". Its models: gpt-real') })
      expect(await w.mgr.startAgent(s, { task: 'three', tool: 'codex', model: 'gpt-real', effort: 'high', wait: false })).toMatchObject({ ok: true })
      expect(calls.n).toBe(1)
    }, 20_000)
  })

  it('past its setup bound without the person answering, says no session was created and withdraws the card', async () => {
    const s = await session()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const p = w.mgr.startAgent(s, { task: 'wait for the person', wait: false })
    for (let i = 0; i < 50 && !agentCard(s); i++) await vi.advanceTimersByTimeAsync(0)
    expect(agentCard(s)).toBeDefined()
    await vi.advanceTimersByTimeAsync(START_AGENT_SETUP_MS)
    const r = await p
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining('No session was created') })
    expect(!r.ok && r.error).toContain('Do not do this with your own subagents')
    expect(agentCard(s)).toBeUndefined()
    expect(childrenOf(s)).toEqual([])
  })

  it('a refusal tells the calling model to ask the person, not to fall back to its own subagents', async () => {
    const s = await session()
    const p = w.mgr.startAgent(s, { task: 'implement the parser' })
    await w.until(() => !!agentCard(s))
    w.mgr.respondApproval(s, agentCard(s)!.requestId, 'deny')
    const r = await p
    expect(!r.ok && r.error).toContain('tell the person')
  })

  it('asks the person first; denied, nothing is started and the model reads a refusal', async () => {
    const s = await session()
    const p = w.mgr.startAgent(s, { task: 'implement the parser', tool: 'codex' })
    await w.until(() => !!agentCard(s))
    expect(agentCard(s)!.detail).toMatchObject({ kind: 'agent_start', project: { id: w.caller.id }, tool: 'Codex', preset: 'normal', text: 'implement the parser' })
    w.mgr.respondApproval(s, agentCard(s)!.requestId, 'deny')
    const r = await p
    expect(!r.ok && r.error).toContain('did not allow')
    expect(childrenOf(s)).toEqual([])
  })

  it('opens a visible child in the same folder on the tool asked for, framed and recorded as sent by the parent, and returns its answer', async () => {
    const s = await session()
    const p = w.mgr.startAgent(s, { task: 'implement the parser', tool: 'codex' })
    await w.until(() => !!agentCard(s))
    w.mgr.respondApproval(s, agentCard(s)!.requestId, 'allow')
    await w.until(() => childrenOf(s).length === 1 && !!handleOf(childrenOf(s)[0]!.id)?.sent.length)
    const c = childrenOf(s)[0]!
    expect([c.projectId, c.tool, c.name]).toEqual([w.caller.id, 'codex', 'implement the parser'])
    const h = handleOf(c.id)!
    expect(h.opts.cwd).toBe(w.caller.path)
    expect(h.sent[0]).toContain("through Centralu's start_agent")
    expect(h.sent[0]).toContain('implement the parser')
    const sent = w.store.loadMessages(c.id, 10).find((m) => m.role === 'user')
    expect((sent?.payload as { from?: { sessionId: string } }).from?.sessionId).toBe(s)
    h.answer('Parser done.')
    expect(await p).toMatchObject({ ok: true, state: 'done', sessionId: c.id, tool: 'codex', answer: 'Parser done.' })
  })

  it('"always for this session" stops asking that session only; "always for this project" every session there, until revoked', async () => {
    const s = await session()
    const first = w.mgr.startAgent(s, { task: 'one', wait: false })
    await w.until(() => !!agentCard(s))
    w.mgr.respondApproval(s, agentCard(s)!.requestId, 'always', 'session')
    expect(await first).toMatchObject({ ok: true })
    expect(await w.mgr.startAgent(s, { task: 'two', wait: false })).toMatchObject({ ok: true })
    expect(agentCard(s)).toBeUndefined()

    const other = await session()
    const third = w.mgr.startAgent(other, { task: 'three', wait: false })
    await w.until(() => !!agentCard(other))
    w.mgr.respondApproval(other, agentCard(other)!.requestId, 'always', 'project')
    expect(await third).toMatchObject({ ok: true })
    expect(w.mgr.projectConsents()).toEqual([expect.objectContaining({ fromProjectId: w.caller.id, toProjectId: w.caller.id, kind: 'agents' })])
    const fresh = await session()
    expect(await w.mgr.startAgent(fresh, { task: 'four', wait: false })).toMatchObject({ ok: true })

    // Four children run now, the ceiling: two of them finish, so the next start reaches the card
    for (const c of [...childrenOf(s), ...childrenOf(other)]) handleOf(c.id)!.answer('done')
    await new Promise((r) => setTimeout(r, 0))
    w.mgr.revokeProjectConsent(w.caller.id, w.caller.id, 'agents')
    const fifth = w.mgr.startAgent(fresh, { task: 'five', wait: false })
    await w.until(() => !!agentCard(fresh))
    w.mgr.respondApproval(fresh, agentCard(fresh)!.requestId, 'deny')
    expect((await fifth).ok).toBe(false)
  })

  it('the child gets the parent\'s preset, whatever it is, and the parent cannot use a child the person later raised above it', async () => {
    allowProject()
    for (const preset of ['safe', 'normal', 'auto'] as const) {
      const s = await session(preset)
      const c = await startRunning(s)
      expect(w.mgr.listSessions().find((x) => x.id === c)?.permissionPreset).toBe(preset)
      expect(handleOf(c)!.opts.permissionPreset).toBe(preset)
    }
    const s = await session('normal')
    const p = w.mgr.startAgent(s, { task: 'first' })
    await w.until(() => !!childrenOf(s)[0] && !!handleOf(childrenOf(s)[0]!.id)?.sent.length)
    const c = childrenOf(s)[0]!.id
    handleOf(c)!.answer('ok')
    await p
    await w.mgr.updateSettings(c, { permissionPreset: 'auto' })
    const r = await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'now delete the build folder' })
    expect(!r.ok && r.error).toContain('more permissions (auto) than this session (normal)')
    expect(handleOf(c)?.sent ?? []).toHaveLength(1)
  })

  it.each([false, true])('wait=%s: includes the adapter\'s network restriction in start_agent\'s answer', async (wait) => {
    allowProject()
    const adapter = w.adapters.get('codex')!
    const create = adapter.createSession.bind(adapter)
    vi.spyOn(adapter, 'createSession').mockImplementation(async (opts, emit) => {
      const h = await create(opts, emit)
      return Object.assign(h, { delegationNotice: () => `this child cannot reach the network under ${opts.permissionPreset}` })
    })
    const s = await session('safe')
    const pending = w.mgr.startAgent(s, { task: 'check the code', tool: 'codex', wait })
    if (wait) {
      await w.until(() => !!childrenOf(s)[0] && !!handleOf(childrenOf(s)[0]!.id)?.sent.length)
      handleOf(childrenOf(s)[0]!.id)!.answer('done')
    }
    expect(await pending).toMatchObject({ ok: true, state: wait ? 'done' : 'working', notice: 'this child cannot reach the network under safe' })
  })

  it('depth one: a child cannot start agents or ask another project', async () => {
    allowProject()
    const s = await session()
    const c = await startRunning(s)
    const r = await w.mgr.startAgent(c, { task: 'and another', wait: false })
    expect(!r.ok && r.error).toContain('cannot start agents')
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const q = await w.mgr.askProject(c, { project: w.target.name, task: 'x' })
    expect(!q.ok && q.error).toContain('cannot ask a project')
    expect(childrenOf(c)).toEqual([])
  })

  it('a session acts only on the children it started', async () => {
    allowProject()
    const s = await session()
    const c = await startRunning(s)
    const other = await session()
    for (const action of ['status', 'wait', 'stop', 'send'] as const) {
      const r = await w.mgr.agentSession(other, { sessionId: c, action, text: 'x' })
      expect(!r.ok && r.error).toContain('is not a session this session started')
    }
    // Nor on a session the person opened, even in the same project
    const r = await w.mgr.agentSession(s, { sessionId: other, action: 'stop' })
    expect(!r.ok && r.error).toContain('is not a session this session started')
    expect(handleOf(c)!.interrupted).toBe(0)
  })

  it(`at most ${AGENT_CEILING} children run at once in a project, counted over all its sessions; a finished one frees a place`, async () => {
    allowProject()
    const a = await session()
    const b = await session()
    const ids: string[] = []
    for (let i = 0; i < AGENT_CEILING; i++) ids.push(await startRunning(i % 2 ? a : b, `task ${i}`))
    const over = await w.mgr.startAgent(a, { task: 'one too many', wait: false })
    expect(!over.ok && over.error).toContain('already working')
    expect(childrenOf(a).length + childrenOf(b).length).toBe(AGENT_CEILING)
    handleOf(ids[0]!)!.answer('done')
    await w.until(() => w.mgr.listSessions().find((x) => x.id === ids[0])?.state === 'waiting_input')
    // The wait settles a few microtasks after the turn's last event
    await new Promise((r) => setTimeout(r, 0))
    expect(await w.mgr.startAgent(a, { task: 'now there is room', wait: false })).toMatchObject({ ok: true })
  })

  it('past the bound it answers "working", tells the parent when the turn ends, and a later wait reads the answer', async () => {
    allowProject()
    const s = await session()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const first = w.mgr.startAgent(s, { task: 'long job' })
    for (let i = 0; i < 50 && !childrenOf(s)[0]; i++) await vi.advanceTimersByTimeAsync(0)
    const c = childrenOf(s)[0]!.id
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS)
    expect(await first).toMatchObject({ ok: true, state: 'working', sessionId: c, reported: true })
    // A note joins the same turn and keeps the report already promised at the bound.
    const busy = await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'also this' })
    expect(busy).toMatchObject({ ok: true, state: 'working', sessionId: c, reported: true })
    expect(handleOf(c)!.sent.at(-1)).toContain('also this')
    vi.useRealTimers()
    handleOf(c)!.answer('long job done')
    // The parent hears about it through the report path, as another session's message
    await w.until(() => (handleOf(s)?.sent ?? []).some((t) => t.includes(`sourceSessionId: ${c}`)))
    expect(handleOf(s)!.sent.filter((t) => t.includes(`sourceSessionId: ${c}`))).toHaveLength(1)
    expect(await w.mgr.agentSession(s, { sessionId: c, action: 'wait' })).toMatchObject({ ok: true, state: 'done', answer: 'long job done' })
  })

  it.each(['claude', 'codex'] as const)('a mid-turn note to %s is framed, stored and visible as the parent\'s, while an active wait takes the same answer once', async (tool) => {
    allowProject()
    const s = await session()
    const started = await w.mgr.startAgent(s, { task: 'long job', tool, wait: false })
    const c = started.ok ? started.sessionId : ''
    const h = handleOf(c)!
    h.event({ type: 'message_delta', sessionId: c, role: 'assistant', text: 'Working on it.' })
    const waiting = w.mgr.agentSession(s, { sessionId: c, action: 'wait' })
    const result = await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'Use Chromium for e2e.' })
    expect(result).toMatchObject({ ok: true, state: 'working', sessionId: c, reported: false })
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]).toContain('A note from the parent session')
    expect(h.sent[1]).toContain('Use Chromium for e2e.')
    expect(h.interrupted).toBe(0)
    const message = w.store.loadMessages(c, 10).filter((m) => m.role === 'user').at(-1)!
    expect(message.payload).toMatchObject({ text: h.sent[1], from: { sessionId: s } })
    expect(w.events).toContainEqual(expect.objectContaining({ type: 'user_message', sessionId: c, text: h.sent[1], from: expect.objectContaining({ sessionId: s }) }))
    h.answer('Done with Chromium.')
    expect(await waiting).toMatchObject({ ok: true, state: 'done', answer: 'Done with Chromium.' })
    expect(handleOf(s)?.sent ?? []).toEqual([])
  })

  it.each(['claude', 'codex'] as const)('%s: queued notes retain the delegation across results; the existing wait gets the last note answer once', async (tool) => {
    allowProject()
    const s = await session()
    const started = await w.mgr.startAgent(s, { task: 'original task', tool, wait: false })
    const c = started.ok ? started.sessionId : ''
    const h = handleOf(c)!
    let answered = false
    const waiting = w.mgr.agentSession(s, { sessionId: c, action: 'wait' }).then((r) => { answered = true; return r })
    await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'first queued note' })
    h.answer('Answer BEFORE the note', false)
    await new Promise((r) => setTimeout(r, 0))
    expect(answered).toBe(false)
    expect(await w.mgr.agentSession(s, { sessionId: c, action: 'status' })).toMatchObject({ ok: true, state: 'working' })
    // A note can be sent during the queued note's new turn, or in the gap before it starts.
    expect(await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'second queued note' })).toMatchObject({ ok: true, state: 'working' })
    h.event({ type: 'state_change', sessionId: c, state: 'working' })
    h.answer('First note answered', false)
    h.receipts.shift()!.resolve()
    await new Promise((r) => setTimeout(r, 0))
    expect(answered).toBe(false)
    expect(handleOf(s)?.sent ?? []).toEqual([])
    h.event({ type: 'state_change', sessionId: c, state: 'working' })
    h.answer('LAST note answered')
    expect(await waiting).toMatchObject({ ok: true, state: 'done', answer: 'LAST note answered' })
    expect(handleOf(s)?.sent ?? []).toEqual([])
  })

  it('a send in the completion microtask gap starts a live delegation instead of attaching to an already-resolved wait', async () => {
    allowProject()
    const s = await session()
    const c = await startRunning(s)
    const h = handleOf(c)!
    h.answer('original done')
    let settled = false
    const next = w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'arrived just after completion' }).then((r) => { settled = true; return r })
    await w.until(() => h.sent.length === 2)
    expect(settled).toBe(false)
    expect(h.sent[1]).toContain('gives you this task')
    expect(h.sent[1]).toContain('Your final message goes back to it as the answer')
    expect(h.sent[1]).not.toContain('A note from the parent session')
    h.answer('new answer')
    expect(await next).toMatchObject({ ok: true, state: 'done', answer: 'new answer' })
  })

  it('a later unrelated turn in the same event batch cannot overwrite the completed note answer', async () => {
    allowProject()
    const s = await session()
    const c = await startRunning(s)
    const h = handleOf(c)!
    const waiting = w.mgr.agentSession(s, { sessionId: c, action: 'wait' })
    await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'parent note' })
    h.answer('before note', false)
    h.event({ type: 'state_change', sessionId: c, state: 'working' })
    h.answer('the note answer')
    h.event({ type: 'state_change', sessionId: c, state: 'working' })
    h.answer('unrelated later answer')
    expect(await waiting).toMatchObject({ ok: true, answer: 'the note answer' })
  })

  it.each(['claude', 'codex'] as const)('%s: the last note applies deferred settings before the next task, including while disposal is pending', async (tool) => {
    allowProject()
    const s = await session()
    const started = await w.mgr.startAgent(s, { task: 'original task', tool, wait: false })
    const c = started.ok ? started.sessionId : ''
    const h = handleOf(c)!
    h.externalId = 'fixture-thread'
    let finishDisposal!: () => void
    const disposal = new Promise<void>((resolve) => { finishDisposal = resolve })
    vi.spyOn(h, 'dispose').mockImplementation(() => disposal)
    const restart = vi.spyOn(w.mgr, 'restartSession')
    expect(await w.mgr.updateSettings(c, { model: 'new-model' })).toMatchObject({ applied: 'after_turn' })
    const waiting = w.mgr.agentSession(s, { sessionId: c, action: 'wait' })
    await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'queued note' })
    await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'last note' })
    h.answer('original answer', false)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(restart).not.toHaveBeenCalled()
    expect(handleOf(c)).toBe(h)
    h.answer('first note answer', false)
    h.receipts.shift()!.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(restart).not.toHaveBeenCalled()
    h.answer('note answer')
    expect(await waiting).toMatchObject({ ok: true, answer: 'note answer' })
    try {
      expect(restart).toHaveBeenCalledTimes(1)
      const next = w.mgr.send(c, 'next task')
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(h.sent).toHaveLength(3) // Neither the note's answer nor asynchronous close lets work reach old settings.
      finishDisposal()
      await next
      expect(handleOf(c)).not.toBe(h)
      expect(handleOf(c)!.opts.model).toBe('new-model')
      expect(handleOf(c)!.sent).toEqual(['next task'])
      expect(restart).toHaveBeenCalledTimes(1)
    } finally {
      finishDisposal()
    }
  })

  it('a receipt released while another turn is active keeps the restart deferred until that turn ends', async () => {
    allowProject()
    const s = await session()
    const c = await startRunning(s)
    const h = handleOf(c)!
    h.externalId = 'fixture-thread'
    const restart = vi.spyOn(w.mgr, 'restartSession')
    await w.mgr.updateSettings(c, { model: 'new-model' })
    const waiting = w.mgr.agentSession(s, { sessionId: c, action: 'wait' })
    await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'queued note' })
    h.answer('note result', false)
    h.event({ type: 'state_change', sessionId: c, state: 'working' })
    h.receipts.shift()!.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(restart).not.toHaveBeenCalled()
    h.answer('active turn finished')
    await waiting
    await w.until(() => handleOf(c) !== h)
    expect(restart).toHaveBeenCalledTimes(1)
    expect(handleOf(c)!.opts.model).toBe('new-model')
  })

  it('Stop on the child identifies the person before a synchronous parent-note rejection', async () => {
    allowProject()
    const s = await session()
    const c = await startRunning(s)
    const waiting = w.mgr.agentSession(s, { sessionId: c, action: 'wait' })
    await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'pending note' })
    w.mgr.interrupt(c)
    expect(await waiting).toMatchObject({ ok: false, error: expect.stringContaining('the person stopped the agent before it finished') })
    expect(handleOf(c)!.interrupted).toBe(1)
  })

  it('a queued parent note keeps the child awake between turns', async () => {
    allowProject()
    w.adapters.get('claude')!.capabilities.backgroundTasks = true
    const s = await session()
    const c = await startRunning(s)
    await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'queued note' })
    handleOf(c)!.answer('old turn ended', false)
    expect(w.mgr.sessionIdle(c)).toEqual({ idle: false, reason: 'turn' })
    expect(await w.mgr.sleepSession(c)).toBe(false)
    expect(w.mgr.isLive(c)).toBe(true)
    handleOf(c)!.answer('note answer')
    expect(await w.mgr.agentSession(s, { sessionId: c, action: 'wait' })).toMatchObject({ ok: true, answer: 'note answer' })
  })

  it.each(['claude', 'codex'] as const)('%s: a queued note gets one final report, and stop owns its new turn', async (tool) => {
    allowProject()
    const s = await session()
    const started = await w.mgr.startAgent(s, { task: 'original task', tool, wait: false })
    const c = started.ok ? started.sessionId : ''
    const h = handleOf(c)!
    await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'queued note' })
    h.answer('Old answer', false)
    await new Promise((r) => setTimeout(r, 0))
    expect(handleOf(s)?.sent ?? []).toEqual([])
    h.event({ type: 'state_change', sessionId: c, state: 'working' })
    h.answer('Note answer')
    await w.until(() => (handleOf(s)?.sent ?? []).some((t) => t.includes(`sourceSessionId: ${c}`)))
    expect(handleOf(s)!.sent).toHaveLength(1)
    expect(await w.mgr.agentSession(s, { sessionId: c, action: 'wait' })).toMatchObject({ ok: true, answer: 'Note answer' })

    const next = w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'another task' })
    await w.until(() => h.sent.length === 3)
    await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'another queued note' })
    h.answer('Before the queued note', false)
    h.event({ type: 'state_change', sessionId: c, state: 'working' })
    expect(await w.mgr.agentSession(s, { sessionId: c, action: 'stop' })).toMatchObject({ ok: true, state: 'stopped' })
    expect(h.interrupted).toBe(1)
    expect(await next).toMatchObject({ ok: false })
  })

  it('mid-turn send preserves the permission gate and requires adapter support, without stopping or losing the wait', async () => {
    allowProject()
    const s = await session('normal')
    const c = await startRunning(s)
    const h = handleOf(c)!
    w.adapters.get('claude')!.capabilities.midTurnInput = false
    expect(await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'note' })).toMatchObject({ ok: false, error: expect.stringContaining('cannot take messages while working') })
    w.adapters.get('claude')!.capabilities.midTurnInput = true
    await w.mgr.updateSettings(c, { permissionPreset: 'auto' })
    expect(await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'note' })).toMatchObject({ ok: false, error: expect.stringContaining('more permissions') })
    expect(h.sent).toHaveLength(1)
    expect(h.interrupted).toBe(0)
    h.answer('done')
    expect(await w.mgr.agentSession(s, { sessionId: c, action: 'wait' })).toMatchObject({ ok: true, state: 'done', answer: 'done' })
  })

  it('a turn the person started remains theirs, even on an adapter that supports mid-turn input', async () => {
    allowProject()
    const s = await session()
    const c = await startRunning(s)
    handleOf(c)!.answer('first done')
    await w.mgr.agentSession(s, { sessionId: c, action: 'wait' })
    await w.mgr.send(c, 'the person\'s task')
    expect(await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'note' })).toMatchObject({ ok: false, error: expect.stringContaining('busy with something else') })
    expect(handleOf(c)!.sent).toHaveLength(2)
    expect(handleOf(c)!.interrupted).toBe(0)
  })

  it('a wait in progress takes the answer, with no report on top of it', async () => {
    allowProject()
    const s = await session()
    const c = await startRunning(s)
    const waiting = w.mgr.agentSession(s, { sessionId: c, action: 'wait' })
    await new Promise((r) => setTimeout(r, 10))
    handleOf(c)!.answer('done')
    expect(await waiting).toMatchObject({ ok: true, state: 'done', answer: 'done' })
    await new Promise((r) => setTimeout(r, 20))
    expect((handleOf(s)?.sent ?? []).some((t) => t.includes('sourceSessionId'))).toBe(false)
  })

  it('stop ends the turn the parent gave; Stop on the parent stops a child it waits on, not one left running', async () => {
    allowProject()
    const s = await session()
    const left = await startRunning(s, 'left running')
    const stopped = await w.mgr.agentSession(s, { sessionId: left, action: 'stop' })
    expect(stopped).toMatchObject({ ok: true, state: 'stopped' })
    expect(handleOf(left)!.interrupted).toBe(1)
    expect((await w.mgr.agentSession(s, { sessionId: left, action: 'stop' })).ok).toBe(false)

    const background = await startRunning(s, 'background')
    const waited = w.mgr.startAgent(s, { task: 'waited on' })
    await w.until(() => childrenOf(s).length === 3 && !!handleOf(childrenOf(s).find((x) => x.name === 'waited on')!.id)?.sent.length)
    const waitedId = childrenOf(s).find((x) => x.name === 'waited on')!.id
    w.mgr.interrupt(s)
    const r = await waited
    expect(!r.ok && r.error).toContain('the person stopped the session that asked')
    expect(handleOf(waitedId)!.interrupted).toBe(1)
    expect(handleOf(background)!.interrupted).toBe(0)
  })

  describe('deleting a child without a worktree (#637)', () => {
    describe.each(['safe', 'normal', 'auto'] as const)('protecting the person under %s', (preset) => {
      it.each(['working', 'approval', 'question'] as const)('refuses delete during the person\'s %s after the delegated turn ends', async (activity) => {
        allowProject()
        const s = await session(preset)
        const c = await startRunning(s)
        const child = handleOf(c)!
        child.answer('Delegated task complete.')
        await w.mgr.agentSession(s, { sessionId: c, action: 'wait' })
        await w.mgr.send(c, 'The person has another task')
        if (activity === 'approval') child.event({ type: 'approval_request', sessionId: c, requestId: 'person-approval', detail: { kind: 'command', command: 'check', cwd: w.caller.path } })
        if (activity === 'question') {
          child.event({ type: 'state_change', sessionId: c, state: 'waiting_input' })
          child.event({ type: 'question_request', sessionId: c, requestId: 'person-question', questions: [{ question: 'Which one?', header: '', options: [], multiSelect: false }] })
        }
        const before = structuredClone(w.mgr.listSessions().find((row) => row.id === c))
        const dispose = vi.spyOn(child, 'dispose')
        expect(await w.mgr.agentSession(s, { sessionId: c, action: 'delete' })).toMatchObject({ ok: false, error: expect.stringContaining('the person may be using it') })
        expect(dispose).not.toHaveBeenCalled()
        expect(w.mgr.listSessions().find((row) => row.id === c)).toEqual(before)
        expect(w.store.trashedSession(c)).toBeNull()
        child.answer('The person\'s task is complete.')
        expect(await w.mgr.agentSession(s, { sessionId: c, action: 'delete' })).toMatchObject({ ok: true, state: 'deleted' })
      })
    })

    it('auto ownership cannot delete a turn delegated by another caller', async () => {
      const s = await session('auto')
      const other = await session('auto')
      const c = await startRunning(s)
      const child = handleOf(c)!
      child.answer('done')
      await w.mgr.agentSession(s, { sessionId: c, action: 'wait' })
      const working = w.mgr.agentSession(other, { sessionId: c, action: 'send', text: 'Another caller\'s task' })
      await w.until(() => child.sent.length === 2)
      try {
        expect(await w.mgr.agentSession(s, { sessionId: c, action: 'delete' })).toMatchObject({ ok: false, error: expect.stringContaining('the person may be using it') })
      } finally {
        child.answer('done')
        await working
      }
    })

    it.each(['parent', 'sidebar'] as const)('shares one trash operation when %s deletes first and the other races disposal', async (first) => {
      allowProject()
      const s = await session()
      const c = await startRunning(s)
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const dispose = vi.spyOn(handleOf(c)!, 'dispose').mockImplementation(() => gate)
      const trash = vi.spyOn(w.store, 'trashSession')
      const rpc = createRpcHandler(w.mgr, w.adapters)
      const parent = () => w.mgr.agentSession(s, { sessionId: c, action: 'delete' })
      const sidebar = () => rpc('agents.deleteSession', { sessionId: c })
      const a = first === 'parent' ? parent() : sidebar()
      await w.until(() => dispose.mock.calls.length === 1)
      const b = first === 'parent' ? sidebar() : parent()
      release()
      const results = await Promise.all([a, b])
      expect(results[first === 'parent' ? 0 : 1]).toMatchObject({ ok: true, state: 'deleted' })
      expect(results[first === 'sidebar' ? 0 : 1]).toEqual({ ok: true })
      expect(dispose).toHaveBeenCalledTimes(1)
      expect(trash).toHaveBeenCalledTimes(1)
      expect(w.events.filter((e) => e.type === 'session_deleted' && e.sessionId === c)).toHaveLength(1)
      expect(w.store.trashedSession(c)?.record.projectId).toBe(w.caller.id)
    })

    it.each(['safe', 'normal', 'auto'] as const)('%s moves its completed child to the sidebar trash, preserving its history and creator link', async (preset) => {
      allowProject()
      const s = await session(preset)
      const c = await startRunning(s)
      handleOf(c)!.answer('Research complete.')
      await w.mgr.agentSession(s, { sessionId: c, action: 'wait' })
      expect(childrenOf(s)[0]).toMatchObject({ worktree: null, parentSessionId: null, askedBy: s })

      const result = await w.mgr.runOrchestratorTool(s, 'agent_session', { sessionId: c, action: 'delete' })
      expect(result).toEqual({ text: expect.stringContaining('to the trash. Tell the person in one line.') })
      expect(result.text).not.toMatch(/worktree|branch|undefined/)
      expect(w.mgr.listSessions().some((child) => child.id === c)).toBe(false)
      expect(w.store.trashedSession(c)?.session).toMatchObject({ askedBy: s, parentSessionId: null })
      expect(w.store.loadMessages(c, 50).some((m) => JSON.stringify(m.payload).includes('Research complete.'))).toBe(true)
      expect(w.events).toContainEqual({ type: 'session_deleted', sessionId: c })
      await w.mgr.restoreSession(c)
      expect(childrenOf(s).map((child) => child.id)).toContain(c)
    })

    it.each(['safe', 'normal', 'auto'] as const)('refuses another caller\'s child and an unowned session under %s', async (preset) => {
      allowProject()
      const owner = await session()
      const caller = await session(preset)
      const c = await startRunning(owner)
      for (const target of [c, owner]) {
        const dispose = vi.spyOn(handleOf(target)!, 'dispose')
        expect(await w.mgr.agentSession(caller, { sessionId: target, action: 'delete' })).toMatchObject({
          ok: false, error: expect.stringContaining('not a session this session started'),
        })
        expect(dispose).not.toHaveBeenCalled()
        expect(w.store.trashedSession(target)).toBeNull()
      }
    })

    it('waits for child disposal mid-turn before trashing, without stopping the parent\'s own turn', async () => {
      allowProject()
      const s = await session()
      await w.mgr.send(s, 'coordinate the research')
      const c = await startRunning(s)
      const child = handleOf(c)!
      child.event({ type: 'message_delta', sessionId: c, role: 'assistant', text: 'Partial research' })
      const waiting = w.mgr.agentSession(s, { sessionId: c, action: 'wait' })
      const parentDispose = vi.spyOn(handleOf(s)!, 'dispose')
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const dispose = vi.spyOn(child, 'dispose').mockImplementation(() => gate)
      const deleting = w.mgr.agentSession(s, { sessionId: c, action: 'delete' })
      try {
        await w.until(() => dispose.mock.calls.length === 1)
        expect(w.store.trashedSession(c)).toBeNull()
        expect(w.events.some((e) => e.type === 'session_deleted' && e.sessionId === c)).toBe(false)
        // Output already in flight is flushed with the conversation before it goes to the trash.
        child.event({ type: 'message_delta', sessionId: c, role: 'assistant', text: ' before stop' })
      } finally {
        release()
      }
      expect(await deleting).toMatchObject({ ok: true, state: 'deleted', sessionId: c })
      expect(await waiting).toMatchObject({ ok: false, error: expect.stringContaining('deleted') })
      expect(w.store.trashedSession(c)).not.toBeNull()
      expect(w.store.loadMessages(c, 50).some((m) => JSON.stringify(m.payload).includes('Partial research before stop'))).toBe(true)
      expect(w.mgr.isLive(c)).toBe(false)
      expect(parentDispose).not.toHaveBeenCalled()
      expect(handleOf(s)!.interrupted).toBe(0)
      expect(w.mgr.listSessions().find((row) => row.id === s)?.state).toBe('working')
      expect(handleOf(s)!.sent).toEqual(['coordinate the research'])
      handleOf(s)!.answer('Coordination complete.')
    })

    it.each(['askedBy', 'parentSessionId'] as const)('recognizes an existing %s link after host handoff and keeps the deletion across reload', async (link) => {
      allowProject()
      const s = await session()
      const c = await startRunning(s)
      await w.mgr.detachAll()
      const row = w.store.listSessions().find((child) => child.id === c)!
      w.store.upsertSession({ ...row, askedBy: null, parentSessionId: null, [link]: s })
      const next = new SessionManager(w.store, w.adapters, (e) => w.events.push(e))
      try {
        expect(await next.agentSession(s, { sessionId: c, action: 'delete' })).toMatchObject({ ok: true, state: 'deleted', sessionId: c })
        expect(w.store.trashedSession(c)?.session).toMatchObject({ [link]: s })
      } finally {
        await next.detachAll()
      }
      const reloaded = new SessionManager(w.store, w.adapters, () => {})
      try {
        expect(reloaded.listSessions().some((child) => child.id === c)).toBe(false)
        expect(reloaded.listSessions().some((parent) => parent.id === s)).toBe(true)
      } finally {
        await reloaded.disposeAll()
      }
    })
  })

  it('the parent deleted, the child keeps its turn and its link', async () => {
    allowProject()
    const s = await session()
    const c = await startRunning(s)
    await w.mgr.trashSession(s)
    expect(handleOf(c)!.interrupted).toBe(0)
    expect(w.mgr.listSessions().find((x) => x.id === c)?.askedBy).toBe(s)
  })

  describe('in a new worktree (part 2)', () => {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()
    const repo = () => {
      git(w.caller.path, 'init', '-q', '-b', 'main')
      writeFileSync(join(w.caller.path, 'README.md'), 'x')
      git(w.caller.path, 'add', '.')
      git(w.caller.path, 'commit', '-qm', 'init')
    }

    it('keeps a missing worktree distinct from a same-folder child, including after reload', async () => {
      repo()
      allowProject()
      const s = await session()
      await w.mgr.startAgent(s, { task: 'worktree task', branch: 'feat/missing', wait: false })
      const c = childrenOf(s)[0]!
      const worktree = c.worktree!
      rmSync(worktree.path, { recursive: true, force: true })
      expect(await w.mgr.agentSession(s, { sessionId: c.id, action: 'delete' })).toMatchObject({ ok: false, error: expect.stringContaining('still working') })
      handleOf(c.id)!.answer('done')
      await w.mgr.agentSession(s, { sessionId: c.id, action: 'wait' })
      await w.mgr.detachAll()
      const next = new SessionManager(w.store, w.adapters, () => {})
      try {
        expect(next.listSessions().find((row) => row.id === c.id)?.worktree).toEqual(worktree)
        expect(await next.agentSession(s, { sessionId: c.id, action: 'delete' })).toMatchObject({ ok: false, error: expect.stringContaining('worktree folder for') })
        expect(w.store.trashedSession(c.id)).toBeNull()
        expect(w.store.listSessions().find((row) => row.id === c.id)?.worktree).toEqual(worktree)
        expect(git(w.caller.path, 'rev-parse', '--verify', 'refs/heads/feat/missing')).not.toBe('')
      } finally {
        await next.disposeAll()
      }
    })

    it('prepares installed JS dependencies before the child starts, without a configured setup command', async () => {
      repo()
      writeFileSync(join(w.caller.path, 'package.json'), '{}')
      writeFileSync(join(w.caller.path, 'package-lock.json'), '{}')
      writeFileSync(join(w.caller.path, '.gitignore'), 'node_modules/\n')
      git(w.caller.path, 'add', '.')
      git(w.caller.path, 'commit', '-qm', 'JS project')
      mkdirSync(join(w.caller.path, 'node_modules', 'dep'), { recursive: true })
      writeFileSync(join(w.caller.path, 'node_modules', 'dep', 'index.js'), 'installed dependency')
      const adapter = w.adapters.get('codex')!
      const create = adapter.createSession.bind(adapter)
      vi.spyOn(adapter, 'createSession').mockImplementation(async (opts, emit) => {
        expect(readFileSync(join(opts.cwd, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('installed dependency')
        return create(opts, emit)
      })
      allowProject()
      const s = await session()
      expect(await w.mgr.startAgent(s, { task: 'test it', tool: 'codex', worktree: true, wait: false })).toMatchObject({ ok: true })
    })

    it('opens the child in a worktree on a branch named from its job, said on the card, linked to its parent', async () => {
      repo()
      const s = await session()
      const p = w.mgr.startAgent(s, { task: 'Write the parser!', worktree: true, wait: false })
      await w.until(() => !!agentCard(s))
      const branch = (agentCard(s)!.detail as { worktree?: { branch: string } }).worktree?.branch
      expect(branch).toMatch(/^centralu\/write-the-parser-[a-z0-9]{4}$/)
      w.mgr.respondApproval(s, agentCard(s)!.requestId, 'allow')
      expect(await p).toMatchObject({ ok: true, state: 'working' })
      const c = childrenOf(s)[0]!
      expect(c.worktree?.branch).toBe(branch)
      expect(c.name).toBe(branch)
      expect(c.askedBy).toBe(s)
      expect(handleOf(c.id)!.opts.cwd).toBe(c.worktree!.path)
      expect(c.worktree!.path.startsWith(w.caller.path)).toBe(false)
      expect(git(c.worktree!.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch)
    })

    it('takes the branch asked for, and forks from the parent\'s own branch when the parent works in a worktree', async () => {
      repo()
      allowProject()
      const s = await session()
      const first = await w.mgr.startAgent(s, { task: 'x', branch: 'feat/parser', wait: false })
      expect(first.ok).toBe(true)
      const parentInWorktree = childrenOf(s)[0]!
      writeFileSync(join(parentInWorktree.worktree!.path, 'parser.ts'), 'x')
      git(parentInWorktree.worktree!.path, 'add', '.')
      git(parentInWorktree.worktree!.path, 'commit', '-qm', 'parser')
      // A session the person opened in that worktree's branch starts a child of its own in a new worktree
      const own = await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal', worktree: true, worktreeBranch: 'feat/lexer', worktreeBase: 'feat/parser' })
      writeFileSync(join(own.worktree!.path, 'lexer.ts'), 'x')
      git(own.worktree!.path, 'add', '.')
      git(own.worktree!.path, 'commit', '-qm', 'lexer')
      expect(await w.mgr.startAgent(own.id, { task: 'tests for the lexer', branch: 'feat/lexer-tests', wait: false })).toMatchObject({ ok: true })
      const c = childrenOf(own.id)[0]!
      expect(c.worktree?.branch).toBe('feat/lexer-tests')
      expect(existsSync(join(c.worktree!.path, 'lexer.ts'))).toBe(true)
    })

    it('refuses before the card when the project is no git repository, or the branch name is not one', async () => {
      const s = await session()
      const r = await w.mgr.startAgent(s, { task: 'x', worktree: true })
      expect(!r.ok && r.error).toContain('not a git repository')
      repo()
      const bad = await w.mgr.startAgent(s, { task: 'x', branch: 'no..dots' })
      expect(!bad.ok && bad.error).toContain('Not a valid branch name')
      expect(agentCard(s)).toBeUndefined()
      expect(childrenOf(s)).toEqual([])
    })
  })

  it('a session of an untrusted project cannot start agents: no card, nothing started', async () => {
    w.mgr.setProjectTrusted(w.caller.id, false)
    const s = await session()
    const r = await w.mgr.startAgent(s, { task: 'x' })
    expect(!r.ok && r.error).toContain('not trusted')
    expect(agentCard(s)).toBeUndefined()
    expect(childrenOf(s)).toEqual([])
  })
})
