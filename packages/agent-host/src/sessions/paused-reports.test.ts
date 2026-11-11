import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackgroundTask } from '@cc/protocol'
import type { CentraluTools } from '../adapters/contract.js'
import type { HostMail } from '../mail/host-mail.js'
import { crossWorld, type CrossWorld } from './cross-project.test-helpers.js'
import { addressOf as addr, mailReader, wireHostMail } from './host-mail.test-helpers.js'
import { OWN_WORK_SETTLE_MS } from './child-ownership.js'
import { runCentraluTool } from './centralu-tools.js'

/**
 * A start_agent child that ends a turn while its own background work runs has not finished (#721). On 2026-10-15 six
 * children ended a turn "waiting for verify to finish" on a backgrounded `pnpm verify`; that turn used up the report
 * their caller was owed, the turn the verify's completion started finished the work and told no one, and the caller,
 * asleep, heard nothing for an hour. Now such a child is not at rest (docs/plans/mailbox.md §10.6.3): its task stays
 * open, and its last response answers it once that work has ended, by the turn the work's end starts or after the settle.
 */

const verify: BackgroundTask = { id: 'bg-verify', kind: 'shell', description: 'pnpm verify', status: 'running' }

describe('a child that waits on its own background work (#721)', () => {
  let w: CrossWorld
  let m: HostMail
  let read: ReturnType<typeof mailReader>
  beforeEach(async () => {
    w = await crossWorld()
    // Claude reports its background work (#290); the fake does when a test says so
    w.adapters.get('claude')!.capabilities.backgroundTasks = true
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    m = wireHostMail(w.mgr, w.store)
    read = mailReader(w.store)
  })
  afterEach(async () => {
    vi.useRealTimers()
    m.delivery.stop()
    await w.dispose()
  })

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id) ?? w.adapters.get('codex')!.handles.get(id)
  /** The caller's task to the child */
  const taskOf = (caller: string, child: string) => read.tasks(addr(caller), child)[0]!
  /** Centralu's reports on the caller's task, oldest first */
  const reportsOn = (caller: string, child: string) => read.reportsOn(taskOf(caller, child).id)
  const settle = () => new Promise((r) => setTimeout(r, 20))
  /** Lets a fake-timer test's promises run */
  const flush = async (until: () => boolean) => {
    for (let i = 0; i < 50 && !until(); i++) await vi.advanceTimersByTimeAsync(0)
  }

  /** A caller that started a child without waiting, and the child running its task */
  async function started(tool: 'claude' | 'codex' = 'claude') {
    const caller = await w.callerSession()
    const r = await w.mgr.startAgent(caller, { task: 'fix it and open a PR', tool, wait: false })
    if (!r.ok || r.state !== 'working') throw new Error(JSON.stringify(r))
    return { caller, child: r.sessionId }
  }

  /** The child backgrounds its verify and ends the turn waiting on it */
  async function pauseOnVerify(child: string) {
    const h = handleOf(child)!
    h.event({ type: 'background_tasks', sessionId: child, live: [verify] })
    h.answer('Waiting for verify to finish.')
    await w.until(() => w.mgr.sessionInfo(child)?.state !== 'working')
  }

  /** The verify ends; its completion starts the child's next turn, which finishes the work */
  function verifyEndsAndChildFinishes(child: string, answer = 'PR #9 opened; verify passed.') {
    const h = handleOf(child)!
    h.event({ type: 'background_tasks', sessionId: child, live: [], ended: [{ ...verify, status: 'completed' }] })
    h.event({ type: 'state_change', sessionId: child, state: 'working' })
    h.answer(answer)
  }

  it('a turn end with its own task running answers nothing; the turn that work’s end starts answers the task with its last response, once', async () => {
    const { caller, child } = await started()
    await pauseOnVerify(child)
    await settle()
    expect(reportsOn(caller, child)).toEqual([])
    expect(read.taskRow(taskOf(caller, child).id, child)).toMatchObject({ settled: null })
    // A child waiting on its own work does not keep its caller awake
    expect(w.mgr.processes.waitsOn(caller)).toEqual([])

    verifyEndsAndChildFinishes(child)
    await w.until(() => reportsOn(caller, child).length === 1)
    expect(reportsOn(caller, child)[0]).toMatchObject({ facts: expect.objectContaining({ outcome: 'finished', answer: 'PR #9 opened; verify passed.' }) })
    expect(read.row(reportsOn(caller, child)[0]!.id, addr(caller))).toBeDefined()
    expect(read.taskRow(taskOf(caller, child).id, child)).toMatchObject({ settled: 'reported' })

    // Once: a later turn of the child's own answers nothing again
    handleOf(child)!.event({ type: 'state_change', sessionId: child, state: 'working' })
    handleOf(child)!.answer('an unrelated later turn')
    await settle()
    expect(reportsOn(caller, child)).toHaveLength(1)
  })

  it('a turn the tasks start after they end is waited for, not cut short by the settling', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const { caller, child } = await started()
    const h = handleOf(child)!
    h.event({ type: 'background_tasks', sessionId: child, live: [verify] })
    h.answer('Waiting for verify to finish.')
    await flush(() => w.mgr.sessionInfo(child)?.state !== 'working')
    h.event({ type: 'background_tasks', sessionId: child, live: [], ended: [{ ...verify, status: 'completed' }] })
    h.event({ type: 'state_change', sessionId: child, state: 'working' })
    await vi.advanceTimersByTimeAsync(OWN_WORK_SETTLE_MS * 2)
    expect(reportsOn(caller, child)).toEqual([])
    h.answer('Done after a long turn.')
    await flush(() => reportsOn(caller, child).length > 0)
    expect(reportsOn(caller, child).map((r) => r.facts.answer)).toEqual(['Done after a long turn.'])
  })

  it('agent_session status and wait on a child whose own work runs read its answer, and leave its task open for its last response', async () => {
    const { caller, child } = await started()
    await pauseOnVerify(child)
    for (const action of ['status', 'wait'] as const) {
      const r = await w.mgr.agentSession(caller, { sessionId: child, action })
      expect(r).toMatchObject({ ok: true, answer: 'Waiting for verify to finish.', notice: expect.stringContaining('pnpm verify') })
      expect(r.ok && r.notice).toContain('this answer may be its final one; its last response answers your task only once that work ends')
    }
    expect(read.taskRow(taskOf(caller, child).id, child)).toMatchObject({ settled: null })
    // What the caller's model reads, at rest too
    const agentSession = (opts: Parameters<typeof w.mgr.agentSession>[1]) => w.mgr.agentSession(caller, opts)
    const status = await runCentraluTool({ agentSession } as unknown as CentraluTools, 'agent_session', { sessionId: child, action: 'status' }, { sessionId: caller, profile: 'reader' })
    expect(status.text).toContain('is not working on anything you gave it')
    expect(status.text).toContain('Its own background work is still running (pnpm verify)')
    expect(status.text).not.toContain('action="delete"')
    expect(status.text).not.toContain('Keep it only if')
    verifyEndsAndChildFinishes(child)
    await w.until(() => reportsOn(caller, child).length === 1)
    expect(reportsOn(caller, child)[0]!.facts.answer).toBe('PR #9 opened; verify passed.')
  })

  it('a caller waiting on the child reads its answer, told that its last response answers the task once that work ends', async () => {
    const caller = await w.callerSession()
    const waiting = w.mgr.startAgent(caller, { task: 'fix it' })
    await w.until(() => w.mgr.listSessions().some((s) => s.askedBy === caller))
    const child = w.mgr.listSessions().find((s) => s.askedBy === caller)!.id
    handleOf(child)!.event({ type: 'background_tasks', sessionId: child, live: [verify] })
    handleOf(child)!.answer('Waiting for verify to finish.')
    expect(await waiting).toMatchObject({ ok: true, state: 'done', answer: 'Waiting for verify to finish.', notice: expect.stringContaining('its last response answers your task only once that work ends') })
    // Read in the call, and the task stays open
    await settle()
    expect(reportsOn(caller, child)).toEqual([])
    expect(read.taskRow(taskOf(caller, child).id, child)).toMatchObject({ settled: null })
    verifyEndsAndChildFinishes(child)
    await w.until(() => reportsOn(caller, child).length === 1)
    expect(reportsOn(caller, child)[0]!.facts).toMatchObject({ outcome: 'finished', answer: 'PR #9 opened; verify passed.' })
  })

  it('a child that leaves a server running: agent_session stop stops that work and ends the wait, and the stop answers nothing', async () => {
    const { caller, child } = await started()
    const server: BackgroundTask = { id: 'bg-dev', kind: 'shell', description: 'pnpm dev', status: 'running', stoppable: true }
    const watcher: BackgroundTask = { id: 'bg-watch', kind: 'other', description: 'a watcher', status: 'running' }
    const h = handleOf(child)!
    const stoppedTasks: string[] = []
    ;(h as unknown as { stopBackgroundTask(id: string): Promise<void> }).stopBackgroundTask = async (id) => {
      stoppedTasks.push(id)
      h.event({ type: 'background_tasks', sessionId: child, live: [watcher], ended: [{ ...server, status: 'stopped' }] })
    }
    h.event({ type: 'background_tasks', sessionId: child, live: [server, watcher] })
    h.answer('PR opened; dev server left running.')
    await w.until(() => w.mgr.sessionInfo(child)?.state !== 'working')

    const r = await w.mgr.agentSession(caller, { sessionId: child, action: 'stop' })
    expect(r).toMatchObject({ ok: true, state: 'stopped', notice: expect.stringContaining('Stopped its background work: pnpm dev.') })
    expect(r.ok && r.notice).toContain('Not stoppable from here, still running: a watcher')
    expect(stoppedTasks).toEqual(['bg-dev'])
    await settle()
    expect(reportsOn(caller, child)).toEqual([])
  })

  it('a timer the tool holds (/loop, a scheduled prompt) does not hold the answer', async () => {
    const { caller, child } = await started()
    const loop: BackgroundTask = { id: 'schedule-wakeup-1', kind: 'other', description: 'Wakes itself at 12:00 (/loop)', status: 'running', stoppable: false, timer: true }
    handleOf(child)!.event({ type: 'background_tasks', sessionId: child, live: [loop] })
    handleOf(child)!.answer('Done; I will check CI again in 10 minutes.')
    await w.until(() => reportsOn(caller, child).length === 1)
    expect(reportsOn(caller, child)[0]!.facts).toMatchObject({ outcome: 'finished', answer: 'Done; I will check CI again in 10 minutes.' })
  })

  it('a child trashed while its own work runs, or its caller trashed, is answered by nothing', async () => {
    const one = await started()
    await pauseOnVerify(one.child)
    const task = taskOf(one.caller, one.child)
    await w.mgr.trash.trashSession(one.child)
    expect(read.reportsOn(task.id)).toEqual([])

    const two = await started()
    await pauseOnVerify(two.child)
    const second = taskOf(two.caller, two.child)
    await w.mgr.trash.trashSession(two.caller)
    verifyEndsAndChildFinishes(two.child)
    await settle()
    expect(read.reportsOn(second.id)).toEqual([])
    expect(w.mgr.processes.waitsOn(two.caller)).toEqual([])
  })

  it('a turn that fails while its task runs goes through the stop notice: the task is released and its sender told, with no report', async () => {
    const { caller, child } = await started()
    const task = taskOf(caller, child)
    const h = handleOf(child)!
    h.event({ type: 'background_tasks', sessionId: child, live: [verify] })
    h.event({ type: 'error', sessionId: child, error: { code: 'internal', message: 'the tool broke', retryable: false } })
    await w.until(() => read.taskRow(task.id, child)?.releasedAt != null)
    expect(read.taskRow(task.id, child)).toMatchObject({ releasedWhy: 'error', settled: null })
    expect(read.between('centralu', addr(caller), 'notice').some((n) => n.facts.unanswered?.some((u) => u.id === task.id))).toBe(true)
    expect(read.reportsOn(task.id)).toEqual([])
  })

  it('a Codex child with no background work answers its task once when its turn ends', async () => {
    const { caller, child } = await started('codex')
    handleOf(child)!.answer('done')
    await w.until(() => reportsOn(caller, child).length === 1)
    expect(reportsOn(caller, child)[0]!.facts.answer).toBe('done')
    await settle()
    expect(reportsOn(caller, child)).toHaveLength(1)
  })
})
