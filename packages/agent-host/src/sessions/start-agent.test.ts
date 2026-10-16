import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionPreset } from '@cc/protocol'
import { AGENT_TOOLS, runOrchestratorTool } from './orchestrator-tools.js'
import { ASK_WAIT_MS } from './ask-project.js'
import { CrossAdapter, crossWorld, type CrossWorld } from './cross-project.test-helpers.js'
import { AGENT_CEILING, agentBranch, agentChoice, agentFrame, agentNoteFrame, presetWithin } from './start-agent.js'
import { SessionManager } from './manager.js'
import { createRpcHandler } from '../rpc.js'
import { START_AGENT_CALL_MS, START_AGENT_MODEL_CHECK_MS, START_AGENT_SETUP_MS } from './manager.js'
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

describe('the model a child starts on (#107, #729)', () => {
  const remembered = { model: 'sonnet', effort: 'low' }
  const setting = { heavy: { model: 'opus', effort: 'max' }, light: { model: 'haiku' } }
  it('a model named wins; its effort is the one named, or the remembered one only for the remembered model', () => {
    expect(agentChoice({ model: 'fable', difficulty: 'heavy' }, remembered, setting)).toEqual({ model: 'fable' })
    expect(agentChoice({ model: 'sonnet', difficulty: 'heavy' }, remembered, setting)).toEqual({ model: 'sonnet', effort: 'low' })
    expect(agentChoice({ model: 'fable', effort: 'high' }, remembered, setting)).toEqual({ model: 'fable', effort: 'high' })
  })
  it('a difficulty takes the person\'s choice for it, and says so; an effort named still wins', () => {
    expect(agentChoice({ difficulty: 'heavy' }, remembered, setting)).toEqual({ model: 'opus', effort: 'max', difficulty: 'heavy' })
    expect(agentChoice({ difficulty: 'heavy', effort: 'high' }, remembered, setting)).toEqual({ model: 'opus', effort: 'high', difficulty: 'heavy' })
    // No effort chosen with it: the model's own default, not the remembered model's effort
    expect(agentChoice({ difficulty: 'light' }, remembered, setting)).toEqual({ model: 'haiku', difficulty: 'light' })
  })
  it('a difficulty with nothing chosen, or no difficulty, is the project\'s remembered choice', () => {
    expect(agentChoice({ difficulty: 'standard' }, remembered, setting)).toEqual({ model: 'sonnet', effort: 'low' })
    expect(agentChoice({ difficulty: 'heavy' }, remembered, undefined)).toEqual({ model: 'sonnet', effort: 'low' })
    expect(agentChoice({}, remembered, setting)).toEqual({ model: 'sonnet', effort: 'low' })
    expect(agentChoice({}, undefined, setting)).toEqual({})
  })
})

describe('the frame a child gets (#729)', () => {
  it('asks it to wait for its own background work that ends inside its turn', () => {
    expect(agentFrame('parent', 'run the tests')).toContain('Wait for your own background work that ends (a test run, a build) inside your turn before you answer.')
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
      // Slow once; a later read (the refusal checks a name the saved list lacks against a fresh one) is quick
      const calls = withList(() =>
        new Promise<ModelOption[]>((r) => setTimeout(() => r([option('gpt-real')]), calls.n === 1 ? START_AGENT_MODEL_CHECK_MS + 500 : 0)),
      )
      const first = await w.mgr.startAgent(s, { task: 'one', tool: 'codex', model: 'gpt-typo', wait: false })
      expect(first).toMatchObject({ ok: true, notice: expect.stringContaining('not checked') })

      await new Promise((r) => setTimeout(r, 1_500))
      const second = await w.mgr.startAgent(s, { task: 'two', tool: 'codex', model: 'gpt-typo', wait: false })
      expect(second).toMatchObject({ ok: false, error: expect.stringContaining('has no model "gpt-typo". Its models: gpt-real') })
      expect(await w.mgr.startAgent(s, { task: 'three', tool: 'codex', model: 'gpt-real', effort: 'high', wait: false })).toMatchObject({ ok: true })
      // The slow read, and the fresh one the refusal waited on; the valid name needed neither
      expect(calls.n).toBe(2)
    }, 20_000)
  })

  it('in a trusted project a normal session starts the child without a card (#673)', async () => {
    const s = await session('normal')
    const r = await w.mgr.startAgent(s, { task: 'write it', wait: false })
    expect(r).toMatchObject({ ok: true, state: 'working', reported: true })
    expect(childrenOf(s)).toHaveLength(1)
    expect(w.events.filter((e) => e.type === 'approval_request' && e.sessionId === s)).toEqual([])
    // Nothing remembered: it is the trust, read at each call
    expect(w.mgr.projectConsents()).toEqual([])
  })

  it('a safe session in a trusted project still asks (#673)', async () => {
    const s = await session('safe')
    const p = w.mgr.startAgent(s, { task: 'write it', wait: false })
    await w.until(() => !!agentCard(s))
    expect(agentCard(s)!.detail).toMatchObject({ kind: 'agent_start', preset: 'safe' })
    w.mgr.respondApproval(s, agentCard(s)!.requestId, 'allow')
    expect(await p).toMatchObject({ ok: true, state: 'working' })
  })

  describe('a difficulty instead of a model (#729)', () => {
    const option = (id: string, efforts: string[] = ['low', 'high']): ModelOption => ({ id, label: id, efforts, defaultEffort: 'low', tiers: [] })
    beforeEach(() => {
      w.adapters.get('codex')!.listModels = async () => [option('gpt-big', ['low', 'high', 'xhigh']), option('gpt-small')]
      w.mgr.setUiPreferences({ agentModels: { codex: { heavy: { model: 'gpt-big', effort: 'xhigh' }, light: { model: 'gpt-small' } } } })
    })

    it('starts the person\'s model and effort for that tool and difficulty, and the card names both', async () => {
      const s = await session('safe')
      const p = w.mgr.startAgent(s, { task: 'design the store', tool: 'codex', difficulty: 'heavy', wait: false })
      await w.until(() => !!agentCard(s))
      expect(agentCard(s)!.detail).toMatchObject({ kind: 'agent_start', model: 'gpt-big', difficulty: 'heavy' })
      w.mgr.respondApproval(s, agentCard(s)!.requestId, 'allow')
      expect(await p).toMatchObject({ ok: true, state: 'working' })
      const c = childrenOf(s)[0]!
      expect(handleOf(c.id)!.opts).toMatchObject({ model: 'gpt-big', effort: 'xhigh' })
    })

    it('a model named still wins, and the card does not credit the setting', async () => {
      const s = await session('safe')
      const p = w.mgr.startAgent(s, { task: 'design it', tool: 'codex', model: 'gpt-small', difficulty: 'heavy', wait: false })
      await w.until(() => !!agentCard(s))
      expect(agentCard(s)!.detail).toMatchObject({ model: 'gpt-small' })
      expect(agentCard(s)!.detail).not.toHaveProperty('difficulty')
      w.mgr.respondApproval(s, agentCard(s)!.requestId, 'allow')
      await p
      expect(handleOf(childrenOf(s)[0]!.id)!.opts).toMatchObject({ model: 'gpt-small' })
    })

    it('a chosen model the tool no longer lists is refused with the list, and says whose choice it was', async () => {
      w.mgr.setUiPreferences({ agentModels: { codex: { heavy: { model: 'gpt-retired' } } } })
      const s = await session()
      const r = await w.mgr.startAgent(s, { task: 'design it', tool: 'codex', difficulty: 'heavy', wait: false })
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining('has no model "gpt-retired". Its models: gpt-big, gpt-small') })
      expect(!r.ok && r.error).toContain("the person's choice for heavy work in Settings → Orchestrator")
      expect(childrenOf(s)).toHaveLength(0)
    })

    it('credits the setting only with what the setting chose: its effort, not an effort the caller named', async () => {
      w.mgr.setUiPreferences({ agentModels: { codex: { heavy: { model: 'gpt-big', effort: 'turbo' } } } })
      const s = await session()
      const own = await w.mgr.startAgent(s, { task: 'design it', tool: 'codex', difficulty: 'heavy', wait: false })
      expect(own).toMatchObject({ ok: false, error: expect.stringContaining('gpt-big has no effort "turbo"') })
      expect(!own.ok && own.error).toContain("That is the person's choice for heavy work in Settings → Orchestrator")
      const callers = await w.mgr.startAgent(s, { task: 'design it', tool: 'codex', difficulty: 'heavy', effort: 'fast', wait: false })
      expect(callers).toMatchObject({ ok: false, error: expect.stringContaining('gpt-big has no effort "fast"') })
      expect(!callers.ok && callers.error).not.toContain("the person's choice")
      expect(childrenOf(s)).toHaveLength(0)
    })

    it('a chosen model that cannot be checked says to name a model, not to start again without it (the caller never named it)', async () => {
      w.adapters.get('codex')!.listModels = () => new Promise<ModelOption[]>(() => {})
      const s = await session()
      const r = await w.mgr.startAgent(s, { task: 'design it', tool: 'codex', difficulty: 'heavy', wait: false })
      expect(r).toMatchObject({ ok: true, notice: expect.stringContaining('not checked') })
      const notice = r.ok ? (r.notice ?? '') : ''
      expect(notice).toContain("name a model (it is the person's choice for heavy work in Settings → Orchestrator)")
      expect(notice).not.toContain('start again without it')
    }, 20_000)

    it('arrives from the tool call: the served schema takes it and the runner passes it on', async () => {
      const s = await session()
      const args = AGENT_TOOLS[0].schema.parse({ task: 'check it', tool: 'codex', difficulty: 'light', wait: false })
      const startAgent = (opts: Parameters<typeof w.mgr.startAgent>[1]) => w.mgr.startAgent(s, opts)
      const tools = { startAgent } as import('../adapters/contract.js').OrchestratorTools
      expect((await runOrchestratorTool(tools, 'start_agent', args, { sessionId: s, profile: 'reader' })).isError).not.toBe(true)
      await w.until(() => childrenOf(s).length === 1)
      expect(handleOf(childrenOf(s)[0]!.id)!.opts).toMatchObject({ model: 'gpt-small' })
      const bad = await runOrchestratorTool(tools, 'start_agent', { task: 'x', difficulty: 'hard' }, { sessionId: s, profile: 'reader' })
      expect(bad).toEqual({ text: 'Give difficulty as light, standard or heavy, or leave it out.', isError: true })
    })
  })

  it('past its setup bound the card stays: the call answers "pending" with a handle, and a later approval starts the child with its report (#673)', async () => {
    const s = await session('safe')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const p = w.mgr.startAgent(s, { task: 'wait for the person', wait: false })
    for (let i = 0; i < 50 && !agentCard(s); i++) await vi.advanceTimersByTimeAsync(0)
    expect(agentCard(s)).toBeDefined()
    const requestId = agentCard(s)!.requestId
    await vi.advanceTimersByTimeAsync(START_AGENT_SETUP_MS)
    const r = await p
    expect(r).toMatchObject({ ok: true, state: 'pending', sessionId: requestId })
    // Long past the bound the card is still there, and nothing was created
    await vi.advanceTimersByTimeAsync(START_AGENT_SETUP_MS * 5)
    expect(agentCard(s)?.requestId).toBe(requestId)
    expect(childrenOf(s)).toEqual([])
    expect(await w.mgr.agentSession(s, { sessionId: requestId, action: 'status' })).toMatchObject({ ok: true, state: 'pending', sessionId: requestId })
    vi.useRealTimers()

    w.mgr.respondApproval(s, requestId, 'allow')
    await w.until(() => childrenOf(s).length === 1)
    const child = childrenOf(s)[0]!.id
    await w.until(() => w.store.listReportMarks().length === 1)
    expect(w.store.listReportMarks()).toEqual([{ sessionId: child, callerSessionId: s }])
    // The handle now leads to the child
    expect(await w.mgr.agentSession(s, { sessionId: requestId, action: 'status' })).toMatchObject({ ok: true, state: 'working', sessionId: child })
    expect(w.store.listAgentStartRequests()).toEqual([])
  })

  it('a pending request the person denies later is told to the caller, and shown in its session (#673)', async () => {
    const s = await session('safe')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const p = w.mgr.startAgent(s, { task: 'wait for the person', wait: false })
    for (let i = 0; i < 50 && !agentCard(s); i++) await vi.advanceTimersByTimeAsync(0)
    const requestId = agentCard(s)!.requestId
    await vi.advanceTimersByTimeAsync(START_AGENT_SETUP_MS)
    expect(await p).toMatchObject({ ok: true, state: 'pending' })
    vi.useRealTimers()

    w.mgr.respondApproval(s, requestId, 'deny')
    // The caller's model hears it as a message: no call is left to answer it
    await w.until(() => !!handleOf(s)?.sent.some((t) => t.includes(`start_agent request ${requestId} did not start a session`)))
    expect(handleOf(s)!.sent.find((t) => t.includes(requestId))).toContain('did not allow')
    expect(childrenOf(s)).toEqual([])
    expect(await w.mgr.agentSession(s, { sessionId: requestId, action: 'status' })).toMatchObject({ ok: false, error: expect.stringContaining('did not allow') })
    expect(w.store.listAgentStartRequests()).toEqual([])
  })

  it('agent_session waits on a pending request for the answer, and stop withdraws it with a line for the person (#673)', async () => {
    const s = await session('safe')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const p = w.mgr.startAgent(s, { task: 'wait for the person', wait: false })
    for (let i = 0; i < 50 && !agentCard(s); i++) await vi.advanceTimersByTimeAsync(0)
    const requestId = agentCard(s)!.requestId
    await vi.advanceTimersByTimeAsync(START_AGENT_SETUP_MS)
    await p
    // Unanswered, a wait returns at its bound still pending
    const waiting = w.mgr.agentSession(s, { sessionId: requestId, action: 'wait' })
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS)
    expect(await waiting).toMatchObject({ ok: true, state: 'pending' })
    vi.useRealTimers()
    expect(await w.mgr.agentSession(s, { sessionId: requestId, action: 'send', text: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('No session yet') })

    // Answered during a wait, the wait returns with the child
    const second = await session('safe')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const q = w.mgr.startAgent(second, { task: 'another', wait: false })
    for (let i = 0; i < 50 && !agentCard(second); i++) await vi.advanceTimersByTimeAsync(0)
    const other = agentCard(second)!.requestId
    await vi.advanceTimersByTimeAsync(START_AGENT_SETUP_MS)
    await q
    vi.useRealTimers()
    const answered = w.mgr.agentSession(second, { sessionId: other, action: 'wait' })
    w.mgr.respondApproval(second, other, 'allow')
    expect(await answered).toMatchObject({ ok: true, state: 'working', sessionId: childrenOf(second)[0]?.id })

    const stopped = await w.mgr.agentSession(s, { sessionId: requestId, action: 'stop' })
    expect(stopped).toMatchObject({ ok: true, state: 'stopped', sessionId: requestId })
    expect(agentCard(s)).toBeUndefined()
    expect(childrenOf(s)).toEqual([])
    const notice = w.store.loadMessages(s, 20).map((m) => JSON.stringify(m.payload)).find((t) => t.includes('was withdrawn by this session'))
    expect(notice).toBeDefined()
    // Another session cannot follow or withdraw it
    expect(await w.mgr.agentSession(second, { sessionId: requestId, action: 'status' })).toMatchObject({ ok: false })
  })

  describe('what an approval rests on, read again when the person answers (#673 review)', () => {
    /** A safe session whose card stands, its call already answered "pending" */
    const pendingCard = async () => {
      const s = await session('safe')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const p = w.mgr.startAgent(s, { task: 'wait for the person', wait: false })
      for (let i = 0; i < 50 && !agentCard(s); i++) await vi.advanceTimersByTimeAsync(0)
      const requestId = agentCard(s)!.requestId
      await vi.advanceTimersByTimeAsync(START_AGENT_SETUP_MS)
      expect(await p).toMatchObject({ ok: true, state: 'pending' })
      vi.useRealTimers()
      return { s, requestId }
    }
    const told = (s: string, requestId: string) => handleOf(s)?.sent.find((t) => t.includes(`start_agent request ${requestId} did not start a session`))

    it('the person stops trusting the project: the card is withdrawn and the session told', async () => {
      const { s, requestId } = await pendingCard()
      await w.mgr.setProjectTrusted(w.caller.id, false)
      expect(agentCard(s)).toBeUndefined()
      await w.until(() => !!told(s, requestId))
      expect(told(s, requestId)).toContain('stopped trusting')
      expect(w.store.loadMessages(s, 30).map((m) => JSON.stringify(m.payload)).some((t) => t.includes('no longer trusted'))).toBe(true)
      expect(w.store.listAgentStartRequests()).toEqual([])
    })

    it('trust taken away elsewhere (another host): an approval starts nothing, and the session is told', async () => {
      const { s, requestId } = await pendingCard()
      w.store.setProjectTrusted(w.caller.id, false)
      w.mgr.respondApproval(s, requestId, 'allow')
      await w.until(() => !!told(s, requestId))
      expect(told(s, requestId)).toContain('no longer trusted')
      expect(childrenOf(s)).toEqual([])
    })

    it('trust taken away while the child session is being made: it gets no task, and the call reads why', async () => {
      const s = await session()
      const make = w.mgr.createSession.bind(w.mgr)
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let making = false
      vi.spyOn(w.mgr, 'createSession').mockImplementation(async (...args) => {
        making = true
        await gate
        return make(...args)
      })
      const starting = w.mgr.startAgent(s, { task: 'write the parser', wait: false })
      await w.until(() => making)
      w.store.setProjectTrusted(w.caller.id, false)
      release()
      expect(await starting).toMatchObject({ ok: false, error: expect.stringContaining('no longer trusted') })
      expect(childrenOf(s)).toEqual([])
      const reached = [...w.adapters.get('claude')!.handles.values()].filter((h) => h.sent.some((t) => t.includes('write the parser')))
      expect(reached).toEqual([])
    })

    it('a child the trash refuses has its process stopped, and the call says it was not moved', async () => {
      const s = await session()
      const make = w.mgr.createSession.bind(w.mgr)
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let made: string | undefined
      vi.spyOn(w.mgr, 'createSession').mockImplementation(async (...args) => {
        await gate
        const child = await make(...args)
        made = child.id
        return child
      })
      vi.spyOn(w.mgr, 'trashSession').mockRejectedValue(new Error('the folder is locked'))
      const starting = w.mgr.startAgent(s, { task: 'write the parser', wait: false })
      await w.until(() => vi.mocked(w.mgr.createSession).mock.calls.length > 0)
      w.store.setProjectTrusted(w.caller.id, false)
      release()
      const r = await starting
      expect(!r.ok && r.error).toContain('could not be moved to the trash (the folder is locked)')
      expect(!r.ok && r.error).toMatch(/its process was stopped|no process of its was running/)
      expect(!r.ok && r.error).not.toContain('was moved to the trash')
      expect(handleOf(made!)?.sent ?? []).toEqual([])
    })

    it('a preset lowered while the child session is being made: it gets no task, and the call reads why', async () => {
      const s = await session()
      const make = w.mgr.createSession.bind(w.mgr)
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let making = false
      vi.spyOn(w.mgr, 'createSession').mockImplementation(async (...args) => {
        making = true
        await gate
        return make(...args)
      })
      const starting = w.mgr.startAgent(s, { task: 'write the parser', wait: false })
      await w.until(() => making)
      // The child is being made at normal, the caller's preset when it was asked for
      await w.mgr.updateSettings(s, { permissionPreset: 'safe' })
      release()
      const r = await starting
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining('lowered to safe') })
      // Named for its job before it went to the trash
      expect(!r.ok && r.error).toContain('moved to the trash')
      expect(!r.ok && r.error).toContain('write the parser')
      expect(childrenOf(s)).toEqual([])
      const reached = [...w.adapters.get('claude')!.handles.values()].filter((h) => h.sent.some((t) => t.includes('write the parser')))
      expect(reached).toEqual([])
    })

    it('a preset raised while the card stood: the approval for the lower one starts nothing', async () => {
      const { s, requestId } = await pendingCard()
      expect(agentCard(s)!.detail).toMatchObject({ preset: 'safe' })
      await w.mgr.updateSettings(s, { permissionPreset: 'auto' })
      w.mgr.respondApproval(s, requestId, 'allow')
      await w.until(() => !!told(s, requestId))
      expect(told(s, requestId)).toContain('raised to auto')
      expect(childrenOf(s)).toEqual([])
    })

    it('a session that began handling another project\'s task while the card stood starts nothing (depth one)', async () => {
      const s = await session('safe')
      const p = w.mgr.startAgent(s, { task: 'wait for the person', wait: false })
      await w.until(() => !!agentCard(s))
      const requestId = agentCard(s)!.requestId
      // Another project asks this very session for something
      await w.mgr.setProjectTrusted(w.target.id, true)
      // The session waits on its card, a turn that is not the asker's: the task joins it as a note (#677), which needs auto
      const asker = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'auto' })).id
      w.store.setProjectConsent(w.target.id, w.caller.id, 'delegate')
      void w.mgr.askProject(asker, { project: w.caller.id, session: s, task: 'check something', ifBusy: 'note' })
      await w.until(() => !!handleOf(s)?.sent.some((t) => t.includes('check something')))
      w.mgr.respondApproval(s, requestId, 'allow')
      expect(await p).toMatchObject({ ok: false, error: expect.stringContaining('itself started or asked') })
      expect(childrenOf(s)).toEqual([])
    })
  })

  it('starts at once cannot pass the ceiling together: the place is taken at the check (#673 review)', async () => {
    const s = await session('normal')
    const adapter = w.adapters.get('codex')!
    const create = adapter.createSession.bind(adapter)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let reached = 0
    vi.spyOn(adapter, 'createSession').mockImplementation(async (opts, emit) => {
      reached++
      await gate
      return create(opts, emit)
    })
    const calls = Array.from({ length: 2 * AGENT_CEILING }, (_, i) => w.mgr.startAgent(s, { task: `job ${i}`, tool: 'codex', wait: false }))
    await w.until(() => reached >= AGENT_CEILING)
    // Give any call that slipped past the ceiling the time to reach the start too
    await new Promise((r) => setTimeout(r, 50))
    expect(reached).toBe(AGENT_CEILING)
    release()
    const results = await Promise.all(calls)
    expect(results.filter((r) => r.ok)).toHaveLength(AGENT_CEILING)
    expect(results.filter((r) => !r.ok).every((r) => !r.ok && r.error.includes('the most at once'))).toBe(true)
    expect(childrenOf(s)).toHaveLength(AGENT_CEILING)
    // A failed start gives its place back
    for (const c of childrenOf(s)) handleOf(c.id)!.answer('done')
    await new Promise((r) => setTimeout(r, 0))
    expect(await w.mgr.startAgent(s, { task: 'after', tool: 'codex', wait: false })).toMatchObject({ ok: true })
  })

  it('the same job asked again while its card stands gets the same handle, not a second card (#673 review)', async () => {
    const s = await session('safe')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const p = w.mgr.startAgent(s, { task: 'one job', wait: false })
    for (let i = 0; i < 50 && !agentCard(s); i++) await vi.advanceTimersByTimeAsync(0)
    const requestId = agentCard(s)!.requestId
    await vi.advanceTimersByTimeAsync(START_AGENT_SETUP_MS)
    await p
    vi.useRealTimers()
    // A host swap's drain cut the first call short and told the model to call again
    expect(await w.mgr.startAgent(s, { task: 'one job', wait: false })).toMatchObject({ ok: true, state: 'pending', sessionId: requestId })
    expect(w.events.filter((e) => e.type === 'approval_request' && e.sessionId === s && (e as { seq?: number }).seq != null)).toHaveLength(1)
    expect(w.store.listAgentStartRequests()).toHaveLength(1)
    // Another job is another request
    const other = w.mgr.startAgent(s, { task: 'another job', wait: false })
    await w.until(() => w.store.listAgentStartRequests().length === 2)
    w.mgr.respondApproval(s, requestId, 'deny')
    await w.until(() => agentCard(s)?.requestId !== requestId && !!agentCard(s))
    w.mgr.respondApproval(s, agentCard(s)!.requestId, 'deny')
    expect(await other).toMatchObject({ ok: false })
  })

  it('deleting the session that asked withdraws its card, with a line in that session (#673)', async () => {
    const s = await session('safe')
    const p = w.mgr.startAgent(s, { task: 'wait for the person', wait: false })
    await w.until(() => !!agentCard(s))
    await w.mgr.trashSession(s)
    expect(await p).toMatchObject({ ok: false })
    expect(childrenOf(s)).toEqual([])
    expect(w.store.listAgentStartRequests()).toEqual([])
    const notice = w.store.loadMessages(s, 20).map((m) => JSON.stringify(m.payload)).find((t) => t.includes('this session was deleted'))
    expect(notice).toBeDefined()
  })

  it('a call cancelled while its card stands withdraws it, with a line for the person (#673)', async () => {
    const s = await session('safe')
    const ctl = new AbortController()
    const p = w.mgr.startAgent(s, { task: 'wait for the person', wait: false }, ctl.signal)
    await w.until(() => !!agentCard(s))
    ctl.abort()
    expect(await p).toMatchObject({ ok: false, error: expect.stringContaining('withdrawn') })
    expect(agentCard(s)).toBeUndefined()
    const notice = w.store.loadMessages(s, 20).map((m) => JSON.stringify(m.payload)).find((t) => t.includes('the call that asked was cancelled'))
    expect(notice).toBeDefined()
  })

  describe('the whole call stays inside the bridge bound (#660)', () => {
    const settled = async <T,>(p: Promise<T>) => Promise.race([p, Promise.resolve('pending' as const)])
    const cardOf = async (s: string) => {
      for (let i = 0; i < 50 && !agentCard(s); i++) await vi.advanceTimersByTimeAsync(0)
      expect(agentCard(s)).toBeDefined()
    }

    it('wait=true: a card answered late leaves only the rest of the bound to wait, then answers "working"', async () => {
      const s = await session('safe')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const p = w.mgr.startAgent(s, { task: 'a long job' })
      await cardOf(s)
      await vi.advanceTimersByTimeAsync(150_000)
      w.mgr.respondApproval(s, agentCard(s)!.requestId, 'allow')
      await vi.advanceTimersByTimeAsync(START_AGENT_CALL_MS - 150_000 + 1_000)
      // Waiting the full ask bound after the card would still be pending here
      expect(await settled(p)).toMatchObject({ ok: true, state: 'working', reported: true })
      expect(childrenOf(s)).toHaveLength(1)
    })

    it('a session that is slow to start past the bound says one may exist, and its report is armed when it comes up', async () => {
      allowProject()
      const s = await session()
      const adapter = w.adapters.get('codex')!
      const create = adapter.createSession.bind(adapter)
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      vi.spyOn(adapter, 'createSession').mockImplementation(async (opts, emit) => {
        await gate
        return create(opts, emit)
      })
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const p = w.mgr.startAgent(s, { task: 'slow start', tool: 'codex', wait: false })
      await vi.advanceTimersByTimeAsync(START_AGENT_SETUP_MS)
      const r = await p
      expect(r).toMatchObject({ ok: false, error: expect.stringContaining('may or may not exist') })
      expect(childrenOf(s)).toEqual([])
      vi.useRealTimers()
      release()
      await w.until(() => childrenOf(s).length === 1)
      // The report promised for any child that outlives the call is there
      expect(await w.mgr.agentSession(s, { sessionId: childrenOf(s)[0]!.id, action: 'status' })).toMatchObject({ ok: true, state: 'working', reported: true })
      // and stored, so a host swap keeps it (#646)
      expect(w.store.listReportMarks()).toEqual([{ sessionId: childrenOf(s)[0]!.id, callerSessionId: s }])
    })

    it('a task still being handed over at the bound is answered as "working", with the report and the unchecked note', async () => {
      allowProject()
      const s = await session()
      w.adapters.get('codex')!.listModels = () => new Promise<ModelOption[]>(() => {})
      vi.spyOn(w.mgr as unknown as { deliver: () => Promise<void> }, 'deliver').mockImplementation(() => new Promise<void>(() => {}))
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      const p = w.mgr.startAgent(s, { task: 'slow hand-over', tool: 'codex', model: 'gpt-x', wait: false })
      await vi.advanceTimersByTimeAsync(START_AGENT_MODEL_CHECK_MS)
      await vi.advanceTimersByTimeAsync(START_AGENT_SETUP_MS)
      const r = await p
      expect(r).toMatchObject({ ok: true, state: 'working', reported: true, notice: expect.stringContaining('"gpt-x" not checked') })
      // The armed report is stored, so a host swap keeps it (#646)
      expect(w.store.listReportMarks()).toEqual([{ sessionId: r.ok ? r.sessionId : '', callerSessionId: s }])
    })

    it('an approval and the bound in the same instant: the answer is "pending", and the child starts with its report (#673)', async () => {
      const s = await session('safe')
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
      // Registered before the call's own timer, so on one synchronous advance the person's "allow" is given first
      // and the bound follows before the start that the "allow" releases can run
      setTimeout(() => w.mgr.respondApproval(s, agentCard(s)!.requestId, 'allow'), START_AGENT_SETUP_MS)
      const p = w.mgr.startAgent(s, { task: 'race', wait: false })
      await cardOf(s)
      vi.advanceTimersByTime(START_AGENT_SETUP_MS)
      const r = await p
      expect(r).toMatchObject({ ok: true, state: 'pending' })
      for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(0)
      expect(childrenOf(s)).toHaveLength(1)
      expect(agentCard(s)).toBeUndefined()
      expect(w.store.listReportMarks()).toEqual([{ sessionId: childrenOf(s)[0]!.id, callerSessionId: s }])
    })
  })

  describe('what the model check says about the list (#660)', () => {
    const option = (id: string): ModelOption => ({ id, label: id, efforts: [], defaultEffort: null, tiers: [] })

    it('an empty list is said to be empty, not late', async () => {
      allowProject()
      const s = await session()
      w.adapters.get('codex')!.listModels = async () => []
      const r = await w.mgr.startAgent(s, { task: 'x', tool: 'codex', model: 'gpt-x', wait: false })
      expect(r).toMatchObject({ ok: true, notice: expect.stringContaining('listed no models') })
      expect(!r.ok ? '' : r.notice).not.toContain('not available in time')
    })

    it('a name the saved list lacks is checked against a fresh list before it is refused (the CLI may have been updated)', async () => {
      allowProject()
      const s = await session()
      let models = [option('gpt-old')]
      w.adapters.get('codex')!.listModels = async () => models
      expect(await w.mgr.startAgent(s, { task: 'one', tool: 'codex', model: 'gpt-old', wait: false })).toMatchObject({ ok: true })
      models = [option('gpt-old'), option('gpt-new')]
      expect(await w.mgr.startAgent(s, { task: 'two', tool: 'codex', model: 'gpt-new', wait: false })).toMatchObject({ ok: true })
      expect(childrenOf(s).map((c) => c.model)).toEqual(['gpt-old', 'gpt-new'])
      // Still refused when the fresh list does not have it either
      expect(await w.mgr.startAgent(s, { task: 'three', tool: 'codex', model: 'gpt-typo', wait: false })).toMatchObject({ ok: false, error: expect.stringContaining('has no model "gpt-typo". Its models: gpt-old, gpt-new') })
    })
  })

  it('a refusal tells the calling model to ask the person, not to fall back to its own subagents', async () => {
    const s = await session('safe')
    const p = w.mgr.startAgent(s, { task: 'implement the parser' })
    await w.until(() => !!agentCard(s))
    w.mgr.respondApproval(s, agentCard(s)!.requestId, 'deny')
    const r = await p
    expect(!r.ok && r.error).toContain('tell the person')
  })

  it('asks the person first; denied, nothing is started and the model reads a refusal', async () => {
    const s = await session('safe')
    const p = w.mgr.startAgent(s, { task: 'implement the parser', tool: 'codex' })
    await w.until(() => !!agentCard(s))
    expect(agentCard(s)!.detail).toMatchObject({ kind: 'agent_start', project: { id: w.caller.id }, tool: 'Codex', preset: 'safe', text: 'implement the parser' })
    w.mgr.respondApproval(s, agentCard(s)!.requestId, 'deny')
    const r = await p
    expect(!r.ok && r.error).toContain('did not allow')
    expect(childrenOf(s)).toEqual([])
  })

  it('opens a visible child in the same folder on the tool asked for, framed and recorded as sent by the parent, and returns its answer', async () => {
    const s = await session('safe')
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
    const s = await session('safe')
    const first = w.mgr.startAgent(s, { task: 'one', wait: false })
    await w.until(() => !!agentCard(s))
    w.mgr.respondApproval(s, agentCard(s)!.requestId, 'always', 'session')
    expect(await first).toMatchObject({ ok: true })
    expect(await w.mgr.startAgent(s, { task: 'two', wait: false })).toMatchObject({ ok: true })
    expect(agentCard(s)).toBeUndefined()

    const other = await session('safe')
    const third = w.mgr.startAgent(other, { task: 'three', wait: false })
    await w.until(() => !!agentCard(other))
    w.mgr.respondApproval(other, agentCard(other)!.requestId, 'always', 'project')
    expect(await third).toMatchObject({ ok: true })
    expect(w.mgr.projectConsents()).toEqual([expect.objectContaining({ fromProjectId: w.caller.id, toProjectId: w.caller.id, kind: 'agents' })])
    const fresh = await session('safe')
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
    // Busy with the person's turn (#677): the choices, and no note from a session that is not auto
    expect(await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'note' })).toMatchObject({
      ok: true, state: 'busy', choices: [{ choice: 'note', available: false, why: expect.stringContaining('auto') }, { choice: 'queue', available: true }, { choice: 'fork' }],
    })
    expect(await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'note', ifBusy: 'note' })).toMatchObject({ ok: false, error: expect.stringContaining('auto') })
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

  /*
   * `stop` ends background work only of a child the caller started, at rest, with nobody else's turn, wait or report on
   * it (#718 review): the person may have typed into a finished child, and an auto caller reaches sessions it did not start
   */
  describe('stopping background work at rest (#718)', () => {
    const dev = { id: 'bg-dev', kind: 'shell' as const, description: 'pnpm dev', status: 'running' as const, stoppable: true }
    const watchStops = (id: string) => {
      const stopped: string[] = []
      ;(handleOf(id) as unknown as { stopBackgroundTask(id: string): Promise<void> }).stopBackgroundTask = async (task) => { stopped.push(task) }
      return stopped
    }

    it('leaves the dev server a turn of the person\'s started in the finished child while that turn runs', async () => {
      allowProject()
      const s = await session()
      const c = await startRunning(s)
      handleOf(c)!.answer('done')
      expect(await w.mgr.agentSession(s, { sessionId: c, action: 'wait' })).toMatchObject({ ok: true, state: 'done' })
      const stopped = watchStops(c)
      handleOf(c)!.event({ type: 'state_change', sessionId: c, state: 'working' })
      handleOf(c)!.event({ type: 'background_tasks', sessionId: c, live: [dev] })
      expect(await w.mgr.agentSession(s, { sessionId: c, action: 'stop' })).toMatchObject({ ok: false })
      expect(stopped).toEqual([])
    })

    it('an auto caller does not stop the work of a session the person made', async () => {
      allowProject()
      const caller = await session('auto')
      const person = await session()
      await w.mgr.send(person, 'run the dev server')
      handleOf(person)!.answer('it runs')
      await w.until(() => w.mgr.listSessions().find((x) => x.id === person)?.state === 'waiting_input')
      const stopped = watchStops(person)
      handleOf(person)!.event({ type: 'background_tasks', sessionId: person, live: [dev] })
      expect(await w.mgr.agentSession(caller, { sessionId: person, action: 'stop' })).toMatchObject({ ok: false })
      expect(stopped).toEqual([])
    })
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
      // Its startup merge check would otherwise ask the machine's gh about the branch (#415)
      next.prLookup = async () => null
      try {
        expect(next.listSessions().find((row) => row.id === c.id)?.worktree).toEqual(worktree)
        // The folder is gone, so there is nothing to lose: the session goes to the trash (#715)
        expect(await next.agentSession(s, { sessionId: c.id, action: 'delete' })).toMatchObject({ ok: true, state: 'deleted', note: expect.stringContaining('already gone') })
        expect(w.store.trashedSession(c.id)).not.toBeNull()
        expect(next.listSessions().some((row) => row.id === c.id)).toBe(false)
      } finally {
        await next.disposeAll()
      }
    })

    /*
     * Its turn over, a child kept a background loop running (#718): `delete` refused "still working — stop it or wait
     * first" and `stop` answered that nothing was running, so the caller had no way out. `delete` now names the work and
     * `stop` stops it; a timer the tool holds (`/loop`), which `stop` cannot reach, does not hold `delete`.
     */
    /** A worktree child that finished the task and was read, with a stop that its tool reports a moment later, as Claude's */
    async function finishedWorktreeChild(branch: string) {
      repo()
      allowProject()
      const s = await session()
      await w.mgr.startAgent(s, { task: 'worktree task', branch, wait: false })
      const c = childrenOf(s)[0]!
      const h = handleOf(c.id)!
      h.answer('done')
      expect(await w.mgr.agentSession(s, { sessionId: c.id, action: 'wait' })).toMatchObject({ ok: true, state: 'done' })
      const stopped: string[] = []
      ;(h as unknown as { stopBackgroundTask(id: string): Promise<void> }).stopBackgroundTask = async (id) => {
        stopped.push(id)
        const now = w.mgr.listSessions().find((x) => x.id === c.id)!.backgroundTasks.filter((t) => t.status === 'running')
        const task = now.find((t) => t.id === id)!
        setTimeout(() => h.event({ type: 'background_tasks', sessionId: c.id, live: now.filter((t) => t.id !== id), ended: [{ ...task, status: 'stopped' }] }), 50)
      }
      return { s, c, h, stopped }
    }
    const poll = { id: 'bg-poll', kind: 'shell' as const, description: 'until gh run view 7; do sleep 15; done', status: 'running' as const, stoppable: true }
    const loop = { id: 'schedule-wakeup-1', kind: 'other' as const, description: 'Wakes itself at 12:00 (/loop)', status: 'running' as const, stoppable: false, timer: true }

    it('a child at rest with only background work left: delete names it, stop stops it, then delete goes through (#718)', async () => {
      const { s, c, h, stopped } = await finishedWorktreeChild('feat/looping')
      h.event({ type: 'background_tasks', sessionId: c.id, live: [poll, loop] })

      const refused = await w.mgr.agentSession(s, { sessionId: c.id, action: 'delete' })
      expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('background work is still running: until gh run view 7; do sleep 15; done.') })
      expect(!refused.ok && refused.error).toContain('agent_session(action="stop") stops until gh run view 7; do sleep 15; done.')
      expect(!refused.ok && refused.error).not.toContain('Wakes itself')

      const r = await w.mgr.agentSession(s, { sessionId: c.id, action: 'stop' })
      expect(r).toMatchObject({ ok: true, state: 'stopped', notice: expect.stringContaining('Stopped its background work: until gh run view 7; do sleep 15; done.') })
      expect(stopped).toEqual(['bg-poll'])

      // Right after the stop, though the tool reported its end only after the stop returned
      const deleted = await w.mgr.agentSession(s, { sessionId: c.id, action: 'delete' })
      expect(deleted).toMatchObject({ ok: true, state: 'deleted', note: 'Its timers ended with its process: Wakes itself at 12:00 (/loop).' })
      expect(w.store.trashedSession(c.id)).not.toBeNull()
    })

    it('work that cannot be stopped on its own: delete does not point to stop, and stop says nothing was stopped (#718)', async () => {
      const { s, c, h, stopped } = await finishedWorktreeChild('feat/stuck')
      const thread = { id: 'thread-1', kind: 'agent' as const, description: 'a child thread', status: 'running' as const }
      h.event({ type: 'background_tasks', sessionId: c.id, live: [thread] })
      const refused = await w.mgr.agentSession(s, { sessionId: c.id, action: 'delete' })
      expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('a child thread cannot be stopped from here') })
      expect(!refused.ok && refused.error).not.toContain('agent_session')
      expect(await w.mgr.agentSession(s, { sessionId: c.id, action: 'stop' })).toMatchObject({
        ok: false, error: expect.stringContaining('Not stoppable from here, still running: a child thread'),
      })
      expect(stopped).toEqual([])
    })

    /*
     * A manager checks whether its worktree branches were merged when it starts, without waiting, and that check runs
     * gh in the project's folder. The check used to outlive the manager: on windows-2022, where gh is installed and
     * can take 10 s, removing the project right after the test failed with EPERM (#368).
     */
    it('a manager let go of leaves no merge check working in the project folder (#368)', async () => {
      repo()
      allowProject()
      const s = await session()
      await w.mgr.startAgent(s, { task: 'worktree task', branch: 'feat/checked', wait: false })
      await w.mgr.detachAll()
      for (const letGo of ['disposeAll', 'detachAll'] as const) {
        const next = new SessionManager(w.store, w.adapters, () => {})
        let asked = false
        let stopped: boolean | undefined
        let answered = false
        // A gh that answers only once it is told to stop, and a moment after that
        next.prLookup = (_cwd, _branch, signal) => new Promise((resolve) => {
          asked = true
          stopped = signal?.aborted ?? false
          signal?.addEventListener('abort', () => setTimeout(() => {
            stopped = true
            answered = true
            resolve(null)
          }, 50))
        })
        await w.until(() => asked, 10_000)
        await next[letGo]()
        expect(stopped).toBe(true)
        expect(answered).toBe(true)
      }
    })

    describe('whose folder is already gone (#715)', () => {
      const startGone = async (branch: string, commit: boolean) => {
        repo()
        allowProject()
        const s = await session()
        await w.mgr.startAgent(s, { task: 'worktree task', branch, wait: false })
        const c = childrenOf(s)[0]!
        handleOf(c.id)!.answer('done')
        await w.mgr.agentSession(s, { sessionId: c.id, action: 'wait' })
        if (commit) {
          writeFileSync(join(c.worktree!.path, 'work.txt'), 'work')
          git(c.worktree!.path, 'add', '.')
          git(c.worktree!.path, 'commit', '-qm', 'work')
        }
        const real = same(c.worktree!.path)
        rmSync(c.worktree!.path, { recursive: true, force: true })
        return { s, c, real }
      }
      // git prints forward slashes and long names; the test's temp path may be a Windows 8.3 short name with backslashes
      const same = (path: string) => {
        const real = realpathSync.native(path).replace(/\\/g, '/')
        return process.platform === 'win32' ? real.toLowerCase() : real
      }
      const listed = () =>
        git(w.caller.path, 'worktree', 'list', '--porcelain')
          .split('\n')
          .filter((line) => line.startsWith('worktree '))
          .map((line) => line.slice('worktree '.length).trim().replace(/\\/g, '/'))
          .map((path) => (process.platform === 'win32' ? path.toLowerCase() : path))
      const branches = () => git(w.caller.path, 'branch', '--format=%(refname:short)').split('\n')

      it('trashes the session, prunes git\'s entry and keeps a branch with commits the trunk lacks', async () => {
        const { s, c, real } = await startGone('feat/gone-ahead', true)
        expect(listed()).toContain(real)
        const r = await w.mgr.agentSession(s, { sessionId: c.id, action: 'delete' })
        expect(r).toMatchObject({ ok: true, state: 'deleted', branch: 'feat/gone-ahead', note: expect.stringMatching(/already gone.*kept/) })
        expect(w.store.trashedSession(c.id)).not.toBeNull()
        expect(listed()).not.toContain(real)
        expect(branches()).toContain('feat/gone-ahead')
      })

      it('leaves a live second worktree listed when git prunes the stale one', async () => {
        const { s, c, real } = await startGone('feat/gone-first', true)
        const live = join(dirname(c.worktree!.path), 'live-second')
        git(w.caller.path, 'worktree', 'add', '-q', '-b', 'feat/live-second', live)
        const liveReal = same(live)
        expect(await w.mgr.agentSession(s, { sessionId: c.id, action: 'delete' })).toMatchObject({ ok: true, state: 'deleted', note: expect.stringContaining('git\'s entry was pruned') })
        expect(listed()).not.toContain(real)
        expect(listed()).toContain(liveReal)
        expect(existsSync(live)).toBe(true)
      })

      it('keeps a branch that another worktree has checked out, and says where', async () => {
        const { s, c } = await startGone('feat/gone-shared', false)
        const other = join(dirname(c.worktree!.path), 'holds-branch')
        // The stale entry still claims the branch until it is pruned; -f takes it over
        git(w.caller.path, 'worktree', 'add', '-q', '-f', other, 'feat/gone-shared')
        const r = await w.mgr.agentSession(s, { sessionId: c.id, action: 'delete' })
        expect(r).toMatchObject({ ok: true, state: 'deleted', note: expect.stringMatching(/was kept: it is checked out at .*holds-branch/) })
        expect(branches()).toContain('feat/gone-shared')
        expect(existsSync(other)).toBe(true)
      })

      it('refuses when the folder is missing but the folder above it is too (a volume not mounted)', async () => {
        const { s, c } = await startGone('feat/gone-unmounted', true)
        rmSync(dirname(c.worktree!.path), { recursive: true, force: true })
        const r = await w.mgr.agentSession(s, { sessionId: c.id, action: 'delete' })
        expect(r).toMatchObject({ ok: false, error: expect.stringContaining('Cannot reach the worktree folder') })
        expect(w.store.trashedSession(c.id)).toBeNull()
        expect(branches()).toContain('feat/gone-unmounted')
      })

      // chmod cannot make a folder unreadable on Windows (it only sets the read-only flag), nor for root
      it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('refuses when the folder cannot be read for a reason other than ENOENT', async () => {
        const { s, c } = await startGone('feat/gone-eacces', true)
        const parent = dirname(c.worktree!.path)
        chmodSync(parent, 0o000)
        try {
          const r = await w.mgr.agentSession(s, { sessionId: c.id, action: 'delete' })
          expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/Cannot reach the worktree folder.*EACCES/) })
        } finally {
          chmodSync(parent, 0o755)
        }
        expect(w.store.trashedSession(c.id)).toBeNull()
        expect(branches()).toContain('feat/gone-eacces')
      })

      it('removes a branch that holds nothing the trunk lacks', async () => {
        const { s, c, real } = await startGone('feat/gone-merged', false)
        expect(listed()).toContain(real)
        const r = await w.mgr.agentSession(s, { sessionId: c.id, action: 'delete' })
        expect(r).toMatchObject({ ok: true, state: 'deleted', note: expect.stringContaining('already gone') })
        expect(w.store.trashedSession(c.id)).not.toBeNull()
        expect(listed()).not.toContain(real)
        expect(branches()).not.toContain('feat/gone-merged')
      })
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
      const s = await session('safe')
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
