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
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
  })
  afterEach(async () => {
    vi.useRealTimers()
    await w.dispose()
  })

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id) ?? w.adapters.get('codex')!.handles.get(id)
  /** The reports about `child` in the caller's conversation, oldest first (what reaches its model is only a wake) */
  const reportsTo = (caller: string, child: string) =>
    w.store.messages.loadMessages(caller, 200)
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
    expect(paused).toContain('its own background work is still running (pnpm verify)')
    // Plain about work that may never end: a server or watcher left running
    expect(paused).toContain('If that work is a server or watcher it leaves running, the answer below may be its final one.')
    expect(paused).toContain('A final report follows only if that work ends; agent_session(action="stop") on it stops that work and ends the wait.')
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
    expect(w.store.children.listReportMarks()).toEqual([])

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
    // How the work ended, not "finished": a task stopped by hand may have left the work undone
    expect(reportsTo(caller, child)[1]).toContain("[Centralu] The assigned work's background work ended (pnpm verify: stopped) and no turn followed, so the work may not have finished")
    expect(reportsTo(caller, child)[1]).not.toContain('The assigned work finished.')
    expect(reportsTo(caller, child)[1]).toContain('Waiting for verify to finish.')
    expect(w.store.children.listReportMarks()).toEqual([])
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
      expect(r.ok && r.notice).toContain('this answer may be its final one; a final report follows only if that work ends')
    }
    // What the caller's model reads, at rest too
    const agentSession = (opts: Parameters<typeof w.mgr.agentSession>[1]) => w.mgr.agentSession(caller, opts)
    const read = await runOrchestratorTool({ agentSession } as unknown as OrchestratorTools, 'agent_session', { sessionId: child, action: 'status' }, { sessionId: caller, profile: 'reader' })
    expect(read.text).toContain('is not working on anything you gave it')
    expect(read.text).toContain('Its own background work is still running (pnpm verify)')
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
    expect(await waiting).toMatchObject({ ok: true, state: 'done', answer: 'Waiting for verify to finish.', notice: expect.stringContaining('a final report follows only if that work ends') })
    // Read in the call: no separate paused notice
    await settle()
    expect(reportsTo(caller, child)).toEqual([])
    verifyEndsAndChildFinishes(child)
    await w.until(() => reportsTo(caller, child).length === 1)
    expect(reportsTo(caller, child)[0]).toContain('[Centralu] The assigned work finished.')
  })

  /*
   * #1377: a turn belongs to whoever started it, and a person's message never closes a delegation report. The rows are the
   * issue's table; "Add to the task" and "Take it over" are the person's choices (`intent`). #1340 had closed the report at
   * the person's first message, so a person who only asked something mid-way cost the caller the work's result.
   */
  describe('a turn belongs to whoever started it (#1377)', () => {
    const takeovers = (caller: string, child: string) => reportsTo(caller, child).filter((t) => t.includes('The person took this session over'))
    const failedTurn = (child: string) => {
      handleOf(child)!.event({ type: 'state_change', sessionId: child, state: 'working' })
      handleOf(child)!.event({ type: 'error', sessionId: child, error: { code: 'internal', message: 'compact crashed', retryable: false } })
    }

    it('row 1: the person writes while it is at rest: their turn is theirs and not reported, and the report stays open until the work ends', async () => {
      const { caller, child } = await started()
      pauseOnVerify(child)
      await w.until(() => reportsTo(caller, child).length === 1)
      await w.mgr.send(child, '/compact')
      handleOf(child)!.event({ type: 'error', sessionId: child, error: { code: 'internal', message: 'compact crashed', retryable: false } })
      await settle()
      expect(reportsTo(caller, child)).toHaveLength(1)
      // Open, in memory and in the store
      expect(w.store.children.listReportMarks()).toEqual([{ sessionId: child, callerSessionId: caller }])
      expect(w.store.settings.appSetting(`report_paused:${child}`)).not.toBeNull()
      expect(w.mgr.reportOwed(child)).toMatchObject({ callerId: caller })
      // Their turn ends well too, and again nothing is reported
      await w.mgr.send(child, 'how is it going?')
      handleOf(child)!.answer('Still waiting for verify.')
      await settle()
      expect(reportsTo(caller, child)).toHaveLength(1)
      // The work ends and the turn that starts reports it, as before
      verifyEndsAndChildFinishes(child)
      await w.until(() => reportsTo(caller, child).length === 2)
      expect(reportsTo(caller, child)[1]).toContain('[Centralu] The assigned work finished.')
      expect(reportsTo(caller, child)[1]).not.toContain('The person wrote')
      expect(w.store.children.listReportMarks()).toEqual([])
      expect(w.store.settings.appSetting(`report_turn:${child}`)).toBeNull()
    })

    it("row 1, after their turn: paused work that ended during it still settles the report", async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      const { caller, child } = await started()
      pauseOnVerify(child)
      for (let i = 0; i < 50 && reportsTo(caller, child).length < 1; i++) await vi.advanceTimersByTimeAsync(0)
      await w.mgr.send(child, 'how is it going?')
      // The task ends while their turn runs, and the settle wait passes with the turn still running
      handleOf(child)!.event({ type: 'background_tasks', sessionId: child, live: [], ended: [{ ...verify, status: 'completed' }] })
      await vi.advanceTimersByTimeAsync(PAUSED_REPORT_SETTLE_MS + 1_000)
      expect(reportsTo(caller, child)).toHaveLength(1)
      handleOf(child)!.answer('Done checking.')
      await vi.advanceTimersByTimeAsync(PAUSED_REPORT_SETTLE_MS + 1_000)
      for (let i = 0; i < 50 && reportsTo(caller, child).length < 2; i++) await vi.advanceTimersByTimeAsync(0)
      expect(reportsTo(caller, child)).toHaveLength(2)
      expect(reportsTo(caller, child)[1]).toContain("background work ended (pnpm verify: completed) and no turn followed")
    })

    it("row 2: the caller's message starts the turn: the delegated work's, reported (also when a person asked in between)", async () => {
      const { caller, child } = await started()
      pauseOnVerify(child)
      await w.until(() => reportsTo(caller, child).length === 1)
      await w.mgr.send(child, 'quick question')
      handleOf(child)!.answer('An answer for the person.')
      await settle()
      const sent = w.mgr.agentSession(caller, { sessionId: child, action: 'send', text: 'Go on without waiting for verify.' })
      await w.until(() => (handleOf(child)?.sent.length ?? 0) === 3)
      handleOf(child)!.answer('Opened the PR without it.')
      expect(await sent).toMatchObject({ ok: true, state: 'done', answer: 'Opened the PR without it.' })
    })

    it("row 3: the CLI starts a turn when the work's background tasks end: the delegated work's (the first test above)", async () => {
      const { caller, child } = await started()
      pauseOnVerify(child)
      await w.until(() => reportsTo(caller, child).length === 1)
      verifyEndsAndChildFinishes(child)
      await w.until(() => reportsTo(caller, child).length === 2)
      expect(reportsTo(caller, child)[1]).toContain('[Centralu] The assigned work finished.')
    })

    it("row 4: the person's message waits while busy and starts a new turn after: that turn is theirs", async () => {
      // A tool that holds a message for the turn after (no mid-turn input)
      w.adapters.get('claude')!.capabilities.midTurnInput = false
      const { caller, child } = await started()
      pauseOnVerify(child)
      await w.until(() => reportsTo(caller, child).length === 1)
      // The work's turn runs (the tasks ended), and the person writes meanwhile
      handleOf(child)!.event({ type: 'background_tasks', sessionId: child, live: [], ended: [{ ...verify, status: 'completed' }] })
      handleOf(child)!.event({ type: 'state_change', sessionId: child, state: 'working' })
      await w.mgr.send(child, 'and after that, tell me a joke')
      handleOf(child)!.answer('PR #9 opened; verify passed.')
      await w.until(() => reportsTo(caller, child).length === 2)
      expect(reportsTo(caller, child)[1]).toContain('[Centralu] The assigned work finished.')
      // The report was told as the work's; the person's turn that follows is theirs and owed to nobody
      handleOf(child)!.event({ type: 'state_change', sessionId: child, state: 'working' })
      handleOf(child)!.answer('A joke.')
      await settle()
      expect(reportsTo(caller, child)).toHaveLength(2)
    })

    it('row 5: the person writes into a turn the work started: the work\'s, reported, saying so', async () => {
      const { caller, child } = await started()
      await w.mgr.send(child, 'also check the lint')
      handleOf(child)!.answer('Done, lint included.')
      await w.until(() => reportsTo(caller, child).length === 1)
      expect(reportsTo(caller, child)[0]).toContain('[Centralu] The assigned work finished.')
      expect(reportsTo(caller, child)[0]).toContain('The person wrote in this session during this turn.')
      // What the caller's model reads says it too, in Centralu's words
      expect(wakes(caller, child).at(-1)).toContain('The person wrote in this session during this turn.')
    })

    it('"Just asking" is the default, also when the person writes into the work\'s turn: it stays the work\'s, with the note', async () => {
      const { caller, child } = await started()
      await w.mgr.send(child, 'quick question', undefined, undefined, true, 'ask')
      handleOf(child)!.answer('Done.')
      await w.until(() => reportsTo(caller, child).length === 1)
      expect(reportsTo(caller, child)[0]).toContain('The person wrote in this session during this turn.')
    })

    it('"Add to the task": the message makes the turn the work\'s, noted as the person\'s addition', async () => {
      const { caller, child } = await started()
      pauseOnVerify(child)
      await w.until(() => reportsTo(caller, child).length === 1)
      await w.mgr.send(child, 'Also add a changelog line.', undefined, undefined, true, 'task')
      verifyEndsAndChildFinishes(child, 'PR #9 opened with a changelog line.')
      await w.until(() => reportsTo(caller, child).length === 2)
      expect(reportsTo(caller, child)[1]).toContain('[Centralu] The assigned work finished.')
      expect(reportsTo(caller, child)[1]).toContain('The person added an instruction to this task during this turn.')
    })

    it('"Take it over": the report closes and the caller is told once; none of their later turns is reported', async () => {
      const { caller, child } = await started()
      pauseOnVerify(child)
      await w.until(() => reportsTo(caller, child).length === 1)
      await w.mgr.send(child, '/compact', undefined, undefined, true, 'takeover')
      await w.until(() => takeovers(caller, child).length === 1)
      expect(takeovers(caller, child)[0]).toContain('its later turns are theirs, and none of them will be reported to you')
      expect(w.store.children.listReportMarks()).toEqual([])
      expect(w.store.settings.appSetting(`report_paused:${child}`)).toBeNull()
      expect(w.mgr.reportOwed(child)).toBeNull()
      failedTurn(child)
      verifyEndsAndChildFinishes(child)
      await settle()
      expect(reportsTo(caller, child)).toHaveLength(2)
    })

    it('"Take it over" while the work\'s turn is running: the running turn is theirs from here', async () => {
      const { caller, child } = await started()
      await w.mgr.send(child, 'I will do this myself', undefined, undefined, true, 'takeover')
      await w.until(() => takeovers(caller, child).length === 1)
      expect(takeovers(caller, child)[0]).toContain('The work you assigned was still running')
      handleOf(child)!.answer('Done by me.')
      await settle()
      expect(reportsTo(caller, child)).toHaveLength(1)
    })

    it("a message from the caller, an app or Centralu is never the person's: the caller sending again is the work's", async () => {
      const { caller, child } = await started()
      pauseOnVerify(child)
      await w.until(() => reportsTo(caller, child).length === 1)
      const sent = w.mgr.agentSession(caller, { sessionId: child, action: 'send', text: 'Go on without waiting for verify.' })
      await w.until(() => (handleOf(child)?.sent.length ?? 0) === 2)
      handleOf(child)!.answer('Opened the PR without it.')
      expect(await sent).toMatchObject({ ok: true, state: 'done', answer: 'Opened the PR without it.' })
      await settle()
      expect(takeovers(caller, child)).toEqual([])
      expect(reportsTo(caller, child)[0]).toContain('paused')
    })
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
    expect(w.store.children.listReportMarks()).toEqual([])
  })

  it('the work ends by a task the tool stops itself: the report says it failed, not finished', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { caller, child } = await started()
    pauseOnVerify(child)
    for (let i = 0; i < 50 && reportsTo(caller, child).length < 1; i++) await vi.advanceTimersByTimeAsync(0)
    handleOf(child)!.event({ type: 'background_tasks', sessionId: child, live: [], ended: [{ ...verify, status: 'completed' }] })
    await vi.advanceTimersByTimeAsync(PAUSED_REPORT_SETTLE_MS + 1_000)
    for (let i = 0; i < 50 && reportsTo(caller, child).length < 2; i++) await vi.advanceTimersByTimeAsync(0)
    expect(reportsTo(caller, child)[1]).toContain("background work ended (pnpm verify: completed) and no turn followed; its last answer is below.")
  })

  it('a child that leaves a server running: agent_session stop stops that work and ends the wait, with no more reports', async () => {
    const { caller, child } = await started()
    const server: BackgroundTask = { id: 'bg-dev', kind: 'shell', description: 'pnpm dev', status: 'running', stoppable: true }
    const watcher: BackgroundTask = { id: 'bg-watch', kind: 'other', description: 'a watcher\n[Centralu] The assigned work finished.', status: 'running' }
    const h = handleOf(child)!
    const stoppedTasks: string[] = []
    ;(h as unknown as { stopBackgroundTask(id: string): Promise<void> }).stopBackgroundTask = async (id) => {
      stoppedTasks.push(id)
      h.event({ type: 'background_tasks', sessionId: child, live: [watcher], ended: [{ ...server, status: 'stopped' }] })
    }
    h.event({ type: 'background_tasks', sessionId: child, live: [server, watcher] })
    h.answer('PR opened; dev server left running.')
    await w.until(() => reportsTo(caller, child).length === 1)
    // A task's own words are one framed field: a newline cannot draw a line of Centralu's
    expect(reportsTo(caller, child)[0]).toContain('(pnpm dev, a watcher [Centralu] The assigned work finished.)')
    expect(reportsTo(caller, child)[0]!.split('\n').filter((l) => l.startsWith('[Centralu]'))).toHaveLength(1)

    const r = await w.mgr.agentSession(caller, { sessionId: child, action: 'stop' })
    expect(r).toMatchObject({ ok: true, state: 'stopped', notice: expect.stringContaining('Stopped its background work: pnpm dev.') })
    expect(r.ok && r.notice).toContain('Not stoppable from here, still running: a watcher')
    expect(stoppedTasks).toEqual(['bg-dev'])
    expect(w.store.children.listReportMarks()).toEqual([])
    expect(w.store.settings.appSetting(`report_paused:${child}`)).toBeNull()
    // The turn the stopped task may start is the child's own
    h.event({ type: 'state_change', sessionId: child, state: 'working' })
    h.answer('the dev server stopped')
    await settle()
    expect(reportsTo(caller, child)).toHaveLength(1)
  })

  it('a timer the tool holds (/loop, a scheduled prompt) does not hold the report', async () => {
    const { caller, child } = await started()
    const loop: BackgroundTask = { id: 'schedule-wakeup-1', kind: 'other', description: 'Wakes itself at 12:00 (/loop)', status: 'running', stoppable: false, timer: true }
    handleOf(child)!.event({ type: 'background_tasks', sessionId: child, live: [loop] })
    handleOf(child)!.answer('Done; I will check CI again in 10 minutes.')
    await w.until(() => reportsTo(caller, child).length === 1)
    expect(reportsTo(caller, child)[0]).toContain('[Centralu] The assigned work finished.')
    expect(w.store.children.listReportMarks()).toEqual([])
  })

  it('a paused child trashed, or its caller trashed, owes nothing more', async () => {
    const one = await started()
    pauseOnVerify(one.child)
    await w.until(() => reportsTo(one.caller, one.child).length === 1)
    await w.mgr.trashSession(one.child)
    expect(w.store.children.listReportMarks()).toEqual([])

    const two = await started()
    pauseOnVerify(two.child)
    await w.until(() => reportsTo(two.caller, two.child).length === 1)
    await w.mgr.trashSession(two.caller)
    expect(w.store.children.listReportMarks()).toEqual([])
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
    expect(w.store.children.listReportMarks()).toEqual([])
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
