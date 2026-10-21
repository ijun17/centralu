import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackgroundTask } from '@cc/protocol'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'
import { ASK_WAIT_MS } from './ask-project.js'
import { PAUSED_REPORT_SETTLE_MS } from './manager.js'
import { askProjectText } from './tool-answers.js'

/**
 * A local ask_project whose delegated turn ends while the session's own background work runs (#1460). It answered at that
 * turn end as if final and marked no report, so the work's later turn, which wrote the result, reached no one; a start_agent
 * child pauses over its own work (#721). The call answers as paused now, and the report is owed and paused for the work's
 * last turn end, kept in the store so a host swap does not lose it (report-marks.test.ts).
 */

const verify: BackgroundTask = { id: 'bg-verify', kind: 'shell', description: 'pnpm verify', status: 'running' }

describe('ask_project into a session that waits on its own background work (#1460)', () => {
  let w: CrossWorld
  let target: string
  let caller: string
  beforeEach(async () => {
    w = await crossWorld()
    const claude = w.adapters.get('claude')!
    claude.capabilities.backgroundTasks = true
    // A conversation id to resume, so the asker can be woken by the report
    const create = claude.createSession.bind(claude)
    claude.createSession = async (opts, emit) => {
      const h = await create(opts, emit)
      h.externalId = opts.resumeExternalId ?? `ext-${opts.sessionId}`
      return h
    }
    w.store.permissions.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    target = (await w.mgr.createSession({ projectId: w.target.id, cwd: w.target.path, tool: 'claude', permissionPreset: 'normal' })).id
    caller = await w.callerSession()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await w.dispose()
  })

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id)!
  const reports = () =>
    w.store.messages.loadMessages(caller, 200)
      .filter((m) => m.role === 'user' && (m.payload as { from?: { sessionId?: string } }).from?.sessionId === target)
      .map((m) => String((m.payload as { text?: string }).text))
  const settle = () => new Promise((r) => setTimeout(r, 30))
  const ask = (task?: string) => w.mgr.askProject(caller, { project: w.target.id, session: target, ...(task ? { task } : {}) })
  /** The delegated turn backgrounds its verify and ends the turn waiting on it */
  const pauseOnVerify = async (call: ReturnType<typeof ask>) => {
    await w.until(() => (handleOf(target)?.sent.length ?? 0) > 0)
    handleOf(target).event({ type: 'background_tasks', sessionId: target, live: [verify] })
    handleOf(target).answer('Started verify; I will summarize when it ends.')
    return call
  }
  const verifyEndsAndSessionFinishes = (answer = '8 pass / 2 fail') => {
    const h = handleOf(target)
    h.event({ type: 'background_tasks', sessionId: target, live: [], ended: [{ ...verify, status: 'completed' }] })
    h.event({ type: 'state_change', sessionId: target, state: 'working' })
    h.answer(answer)
  }

  it('answers as paused, and the turn the work ending starts reaches the asker once with the result', async () => {
    const r = await pauseOnVerify(ask('run the suite'))
    if (!r.ok || r.state !== 'done') throw new Error(JSON.stringify(r))
    expect(r.answer).toBe('Started verify; I will summarize when it ends.')
    expect(r.paused).toContain('background work is still running (pnpm verify)')
    expect(r.paused).toContain(`read_session(sessionId="${target}")`)
    expect(askProjectText(r).text).toContain('has not finished')
    // The report is owed and paused, in the store; the call is the answer to this turn, so nothing is sent for it
    expect(w.store.children.listReportMarks()).toEqual([{ sessionId: target, callerSessionId: caller }])
    expect(w.store.settings.appSetting(`report_paused:${target}`)).not.toBeNull()
    await settle()
    expect(reports()).toEqual([])

    verifyEndsAndSessionFinishes()
    await w.until(() => reports().length === 1)
    expect(reports()[0]).toContain('[Centralu] The assigned work finished.')
    expect(reports()[0]).toContain('8 pass / 2 fail')
    expect(w.store.children.listReportMarks()).toEqual([])
    // Once: a later turn of the session is not the assigned work
    handleOf(target).event({ type: 'state_change', sessionId: target, state: 'working' })
    handleOf(target).answer('an unrelated later turn')
    await settle()
    expect(reports()).toHaveLength(1)
  })

  it('a turn that ends on its work after the call stopped waiting (past its bound) is paused all the same, and the next call reads the pause', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const flush = async (until: () => boolean) => {
      for (let i = 0; i < 100 && !until(); i++) await vi.advanceTimersByTimeAsync(0)
    }
    const call = ask('run the suite')
    await flush(() => (handleOf(target)?.sent.length ?? 0) > 0)
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS + 1_000)
    expect(await call).toMatchObject({ ok: true, state: 'working' })
    // Nobody waits now: the turn ends on its background work
    handleOf(target).event({ type: 'background_tasks', sessionId: target, live: [verify] })
    handleOf(target).answer('Started verify; I will summarize when it ends.')
    await flush(() => w.store.children.listReportMarks().length > 0)
    expect(w.store.children.listReportMarks()).toEqual([{ sessionId: target, callerSessionId: caller }])
    expect(reports()).toEqual([])
    const collected = await ask()
    expect(collected).toMatchObject({ ok: true, state: 'done', answer: 'Started verify; I will summarize when it ends.', paused: expect.stringContaining('pnpm verify') })
    verifyEndsAndSessionFinishes()
    await flush(() => reports().length > 0)
    vi.useRealTimers()
    await w.until(() => reports().length === 1)
    expect(reports()[0]).toContain('8 pass / 2 fail')
    await settle()
    expect(reports()).toHaveLength(1)
  })

  it('a turn that ends with no such work is the answer, as before, and marks no report', async () => {
    const call = ask('run the suite')
    await w.until(() => (handleOf(target)?.sent.length ?? 0) > 0)
    handleOf(target).answer('all done')
    const r = await call
    expect(r).toMatchObject({ ok: true, state: 'done', answer: 'all done' })
    expect((r as { paused?: string }).paused).toBeUndefined()
    expect(w.store.children.listReportMarks()).toEqual([])
    handleOf(target).event({ type: 'state_change', sessionId: target, state: 'working' })
    handleOf(target).answer('later')
    await settle()
    expect(reports()).toEqual([])
  })

  it('work that ends with no turn after it settles the report with how it ended', async () => {
    const r = await pauseOnVerify(ask('run the suite'))
    expect(r).toMatchObject({ ok: true, state: 'done', paused: expect.any(String) })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    handleOf(target).event({ type: 'background_tasks', sessionId: target, live: [], ended: [{ ...verify, status: 'stopped' }] })
    await vi.advanceTimersByTimeAsync(PAUSED_REPORT_SETTLE_MS + 1_000)
    vi.useRealTimers()
    await w.until(() => reports().length === 1)
    expect(reports()[0]).toContain('background work ended (pnpm verify: stopped) and no turn followed')
  })

  it("the person's own turn in the session is theirs: not reported, and the work's end still is", async () => {
    await pauseOnVerify(ask('run the suite'))
    const h = handleOf(target)
    h.event({ type: 'user_message', sessionId: target, seq: 99, text: 'what is going on?' } as never)
    h.event({ type: 'state_change', sessionId: target, state: 'working' })
    h.answer('Verify is still running.')
    await settle()
    expect(reports()).toEqual([])
    verifyEndsAndSessionFinishes('8 pass / 2 fail')
    await w.until(() => reports().length === 1)
    expect(reports()[0]).toContain('8 pass / 2 fail')
  })

  it('a new task from the asker ends the pause: its own answer is the end, and the first report is not delivered besides', async () => {
    await pauseOnVerify(ask('run the suite'))
    handleOf(target).event({ type: 'background_tasks', sessionId: target, live: [], ended: [{ ...verify, status: 'completed' }] })
    const second = ask('and the lint')
    await w.until(() => handleOf(target).sent.length > 1)
    handleOf(target).answer('lint ok')
    expect(await second).toMatchObject({ ok: true, state: 'done', answer: 'lint ok' })
    await settle()
    expect(reports()).toEqual([])
    expect(w.store.children.listReportMarks()).toEqual([])
  })
})
