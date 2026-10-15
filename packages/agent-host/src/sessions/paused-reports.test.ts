import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackgroundTask } from '@cc/protocol'
import type { OrchestratorTools } from '../adapters/contract.js'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'
import { PAUSED_REPORT_SETTLE_MS } from './manager.js'
import { runOrchestratorTool } from './orchestrator-tools.js'

/**
 * A start_agent child that ends a turn while its own background work runs has not finished (#721). On 2026-10-15 six
 * children ended a turn "waiting for verify to finish" on a backgrounded `pnpm verify`; that turn used up the report
 * their caller was owed, the turn the verify's completion started finished the work and told no one, and the caller,
 * asleep, heard nothing for an hour. The caller now hears of the last turn end of the work: a turn end with the
 * child's own tasks running is a "paused" notice that keeps the final report owed, and the final one wakes it.
 */

const verify: BackgroundTask = { id: 'bg-verify', kind: 'shell', description: 'pnpm verify', status: 'running' }

describe('a child that waits on its own background work (#721)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
    // Claude reports its background work (#290); the fake does when a test says so
    const claude = w.adapters.get('claude')!
    claude.capabilities.backgroundTasks = true
    // A conversation id to resume, so a caller put to sleep can be woken
    const create = claude.createSession.bind(claude)
    claude.createSession = async (opts, emit) => {
      const h = await create(opts, emit)
      h.externalId = opts.resumeExternalId ?? `ext-${opts.sessionId}`
      return h
    }
    w.store.setProjectConsent(w.caller.id, w.caller.id, 'agents')
  })
  afterEach(async () => {
    vi.useRealTimers()
    await w.dispose()
  })

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id) ?? w.adapters.get('codex')!.handles.get(id)
  /** The reports about `child` in the caller's conversation, oldest first (what reaches its model is only a wake) */
  const reportsTo = (caller: string, child: string) =>
    w.store.loadMessages(caller, 200)
      .filter((m) => m.role === 'user' && (m.payload as { from?: { sessionId?: string } }).from?.sessionId === child)
      .map((m) => String((m.payload as { text?: string }).text))
  const wakes = (caller: string, child: string) => (handleOf(caller)?.sent ?? []).filter((t) => t.includes(`sourceSessionId: ${child}`))
  const settle = () => new Promise((r) => setTimeout(r, 20))

  /** A caller that started a child without waiting, and the child running its task */
  async function started(tool: 'claude' | 'codex' = 'claude') {
    const caller = await w.callerSession()
    const r = await w.mgr.startAgent(caller, { task: 'fix it and open a PR', tool, wait: false })
    if (!r.ok || r.state !== 'working') throw new Error(JSON.stringify(r))
    expect(r.reported).toBe(true)
    return { caller, child: r.sessionId }
  }

  /** The child backgrounds its verify and ends the turn waiting on it */
  function pauseOnVerify(child: string) {
    const h = handleOf(child)!
    h.event({ type: 'background_tasks', sessionId: child, live: [verify] })
    h.answer('Waiting for verify to finish.')
  }

  /** The verify ends; its completion starts the child's next turn, which finishes the work */
  function verifyEndsAndChildFinishes(child: string, answer = 'PR #9 opened; verify passed.') {
    const h = handleOf(child)!
    h.event({ type: 'background_tasks', sessionId: child, live: [], ended: [{ ...verify, status: 'completed' }] })
    h.event({ type: 'state_change', sessionId: child, state: 'working' })
    h.answer(answer)
  }

  /** The caller ends the turn the paused notice gave it, and is put to sleep */
  async function callerSleeps(caller: string) {
    handleOf(caller)!.answer('Noted.')
    expect(await w.mgr.sleepSession(caller)).toBe(true)
    expect(w.mgr.listSessions().find((s) => s.id === caller)!.live).toBe(false)
  }

  it('a turn end with its own task running is "paused"; the turn that finishes the work wakes the sleeping caller with the final report', async () => {
    const { caller, child } = await started()
    pauseOnVerify(child)
    await w.until(() => reportsTo(caller, child).length === 1)
    const [paused] = reportsTo(caller, child)
    expect(paused).toContain('[Centralu] The assigned work paused')
    expect(paused).not.toContain('The assigned work finished')
    expect(paused).toContain('pnpm verify')
    expect(paused).toContain('Waiting for verify to finish.')
    // A child paused on its own work does not keep its caller awake; the final report wakes it
    expect(w.mgr.waitsOn(caller)).toEqual([])
    await callerSleeps(caller)

    verifyEndsAndChildFinishes(child)
    await w.until(() => reportsTo(caller, child).length === 2)
    const final = reportsTo(caller, child)[1]!
    expect(final).toContain('[Centralu] The assigned work finished.')
    expect(final).toContain('PR #9 opened; verify passed.')
    // Woken: a process again, and its model was handed the wake
    expect(w.mgr.listSessions().find((s) => s.id === caller)!.live).toBe(true)
    expect(wakes(caller, child)).toHaveLength(1)
    expect(w.store.listReportMarks()).toEqual([])

    // Told once: a later turn of the child's own is not the assigned work
    handleOf(child)!.event({ type: 'state_change', sessionId: child, state: 'working' })
    handleOf(child)!.answer('an unrelated later turn')
    await settle()
    expect(reportsTo(caller, child)).toHaveLength(2)
  })

  it('a second turn end while its tasks still run says nothing more; the caller hears the last one', async () => {
    const { caller, child } = await started()
    const lint: BackgroundTask = { id: 'bg-lint', kind: 'shell', description: 'pnpm lint', status: 'running' }
    const h = handleOf(child)!
    h.event({ type: 'background_tasks', sessionId: child, live: [verify, lint] })
    h.answer('Waiting for verify and lint.')
    await w.until(() => reportsTo(caller, child).length === 1)
    // lint ends and starts a turn; verify still runs when it ends
    h.event({ type: 'background_tasks', sessionId: child, live: [verify], ended: [{ ...lint, status: 'completed' }] })
    h.event({ type: 'state_change', sessionId: child, state: 'working' })
    h.answer('Lint passed; still waiting for verify.')
    await settle()
    expect(reportsTo(caller, child)).toHaveLength(1)
    verifyEndsAndChildFinishes(child, 'All green, PR opened.')
    await w.until(() => reportsTo(caller, child).length === 2)
    expect(reportsTo(caller, child)[1]).toContain('All green, PR opened.')
  })

  it('tasks that end without starting a turn settle the report after a while, with the last answer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { caller, child } = await started()
    pauseOnVerify(child)
    for (let i = 0; i < 50 && reportsTo(caller, child).length < 1; i++) await vi.advanceTimersByTimeAsync(0)
    expect(reportsTo(caller, child)).toHaveLength(1)
    // The person stops the task by hand: no turn follows
    handleOf(child)!.event({ type: 'background_tasks', sessionId: child, live: [], ended: [{ ...verify, status: 'stopped' }] })
    await vi.advanceTimersByTimeAsync(PAUSED_REPORT_SETTLE_MS - 1_000)
    expect(reportsTo(caller, child)).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(2_000)
    for (let i = 0; i < 50 && reportsTo(caller, child).length < 2; i++) await vi.advanceTimersByTimeAsync(0)
    expect(reportsTo(caller, child)).toHaveLength(2)
    expect(reportsTo(caller, child)[1]).toContain('The assigned work finished.')
    expect(reportsTo(caller, child)[1]).toContain('Waiting for verify to finish.')
    expect(w.store.listReportMarks()).toEqual([])
  })

  it('a turn the tasks start after they end is waited for, not cut short by the settling', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { caller, child } = await started()
    pauseOnVerify(child)
    for (let i = 0; i < 50 && reportsTo(caller, child).length < 1; i++) await vi.advanceTimersByTimeAsync(0)
    const h = handleOf(child)!
    h.event({ type: 'background_tasks', sessionId: child, live: [], ended: [{ ...verify, status: 'completed' }] })
    h.event({ type: 'state_change', sessionId: child, state: 'working' })
    await vi.advanceTimersByTimeAsync(PAUSED_REPORT_SETTLE_MS * 2)
    expect(reportsTo(caller, child)).toHaveLength(1)
    h.answer('Done after a long turn.')
    for (let i = 0; i < 50 && reportsTo(caller, child).length < 2; i++) await vi.advanceTimersByTimeAsync(0)
    expect(reportsTo(caller, child)).toHaveLength(2)
    expect(reportsTo(caller, child)[1]).toContain('Done after a long turn.')
  })

  it('agent_session status and wait on a paused child read its answer and keep the final report owed', async () => {
    const { caller, child } = await started()
    pauseOnVerify(child)
    await w.until(() => reportsTo(caller, child).length === 1)
    for (const action of ['status', 'wait'] as const) {
      const r = await w.mgr.agentSession(caller, { sessionId: child, action })
      expect(r).toMatchObject({ ok: true, answer: 'Waiting for verify to finish.', notice: expect.stringContaining('pnpm verify') })
      expect(r.ok && r.notice).toContain('You will be told when it ends')
    }
    // What the caller's model reads, at rest too
    const agentSession = (opts: Parameters<typeof w.mgr.agentSession>[1]) => w.mgr.agentSession(caller, opts)
    const read = await runOrchestratorTool({ agentSession } as unknown as OrchestratorTools, 'agent_session', { sessionId: child, action: 'status' }, { sessionId: caller, profile: 'reader' })
    expect(read.text).toContain('is not working on anything you gave it')
    expect(read.text).toContain('background work it started still runs (pnpm verify)')
    verifyEndsAndChildFinishes(child)
    await w.until(() => reportsTo(caller, child).length === 2)
    expect(reportsTo(caller, child)[1]).toContain('PR #9 opened; verify passed.')
  })

  it('a caller waiting on the child reads the paused answer, told that the final report will follow', async () => {
    const caller = await w.callerSession()
    const waiting = w.mgr.startAgent(caller, { task: 'fix it' })
    await w.until(() => w.mgr.listSessions().some((s) => s.askedBy === caller))
    const child = w.mgr.listSessions().find((s) => s.askedBy === caller)!.id
    pauseOnVerify(child)
    expect(await waiting).toMatchObject({ ok: true, state: 'done', answer: 'Waiting for verify to finish.', notice: expect.stringContaining('You will be told when it ends') })
    // Read in the call: no separate paused notice
    await settle()
    expect(reportsTo(caller, child)).toEqual([])
    verifyEndsAndChildFinishes(child)
    await w.until(() => reportsTo(caller, child).length === 1)
    expect(reportsTo(caller, child)[0]).toContain('[Centralu] The assigned work finished.')
  })

  it('the person talking to a paused child: their turn, ended while the task runs, says nothing; the final report still comes', async () => {
    const { caller, child } = await started()
    pauseOnVerify(child)
    await w.until(() => reportsTo(caller, child).length === 1)
    await w.mgr.send(child, 'how is it going?')
    handleOf(child)!.answer('Still waiting for verify.')
    await settle()
    expect(reportsTo(caller, child)).toHaveLength(1)
    verifyEndsAndChildFinishes(child)
    await w.until(() => reportsTo(caller, child).length === 2)
  })

  it('a caller that gives a paused child more work reads that work\'s answer once; the pause it was told of is over', async () => {
    const { caller, child } = await started()
    pauseOnVerify(child)
    await w.until(() => reportsTo(caller, child).length === 1)
    const sent = w.mgr.agentSession(caller, { sessionId: child, action: 'send', text: 'Go on without waiting for verify.' })
    await w.until(() => (handleOf(child)?.sent.length ?? 0) === 2)
    handleOf(child)!.event({ type: 'background_tasks', sessionId: child, live: [], ended: [{ ...verify, status: 'stopped' }] })
    handleOf(child)!.answer('Opened the PR without it.')
    expect(await sent).toMatchObject({ ok: true, state: 'done', answer: 'Opened the PR without it.' })
    await settle()
    expect(reportsTo(caller, child)).toHaveLength(1)
    expect(w.store.listReportMarks()).toEqual([])
  })

  it('a paused child trashed, or its caller trashed, owes nothing more', async () => {
    const one = await started()
    pauseOnVerify(one.child)
    await w.until(() => reportsTo(one.caller, one.child).length === 1)
    await w.mgr.trashSession(one.child)
    expect(w.store.listReportMarks()).toEqual([])

    const two = await started()
    pauseOnVerify(two.child)
    await w.until(() => reportsTo(two.caller, two.child).length === 1)
    await w.mgr.trashSession(two.caller)
    expect(w.store.listReportMarks()).toEqual([])
    verifyEndsAndChildFinishes(two.child)
    await settle()
    expect(w.mgr.waitsOn(two.caller)).toEqual([])
  })

  it('a turn that fails while its task runs is reported as it ended, not held as paused', async () => {
    const { caller, child } = await started()
    const h = handleOf(child)!
    h.event({ type: 'background_tasks', sessionId: child, live: [verify] })
    h.event({ type: 'error', sessionId: child, error: { code: 'internal', message: 'the tool broke', retryable: false } })
    await w.until(() => reportsTo(caller, child).length === 1)
    expect(reportsTo(caller, child)[0]).toContain('[Centralu] The assigned work failed.')
    expect(w.store.listReportMarks()).toEqual([])
  })

  it('a Codex child with no background work is reported once when its turn ends, as before', async () => {
    const { caller, child } = await started('codex')
    handleOf(child)!.answer('done')
    await w.until(() => reportsTo(caller, child).length === 1)
    expect(reportsTo(caller, child)[0]).toContain('[Centralu] The assigned work finished.')
    await settle()
    expect(reportsTo(caller, child)).toHaveLength(1)
  })
})
