import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { SLOW } from '../../../../../tooling/test-timing.js'

/**
 * Resume works like Claude's — we do not make the person wait for it (dogfooding: the same 122MB
 * thread took 3 seconds in the CLI, 13+ seconds on our path. The cost of thread/resume re-reading
 * the file belongs to codex, but paying that cost in front of a "Waking…" screen was our own choice).
 *
 * Three contracts guarded here:
 *  1. For a large thread, the handle comes out first after 3 seconds — a message waits in the ready queue until delivered
 *  2. A lock error is thrown as-is within the 3-second window — this keeps the "split off and continue" fork-in-the-road UI alive
 *  3. When a background resume fails, it does not go quietly to sleep — the manager retires it via adapter_crashed
 *     (or conversation_locked, when the failure is the lock)
 */
const state = vi.hoisted(() => ({
  requests: [] as { method: string; params: Record<string, unknown> | undefined }[],
  hang: new Set<string>(),
  fail: new Map<string, string>(),
  resolvers: new Map<string, (v: unknown) => void>(),
  rejecters: new Map<string, (e: Error) => void>(),
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      state.requests.push({ method, params })
      const failMsg = state.fail.get(method)
      if (failMsg) return Promise.reject(new Error(failMsg))
      if (state.hang.has(method)) {
        return new Promise((res, rej) => {
          state.resolvers.set(method, res)
          state.rejecters.set(method, rej)
        })
      }
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 't1' } })
      if (method === 'thread/resume') return Promise.resolve({ thread: { id: params?.threadId } })
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
    async detach(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('./index.js')

const methods = () => state.requests.map((r) => r.method)
const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  state.requests.length = 0
  state.hang.clear()
  state.fail.clear()
  state.resolvers.clear()
  state.rejecters.clear()
})

describe('codex lazy resume — like Claude', () => {
  it('for a large thread, the handle comes out first after 3 seconds, and a message waits in the queue until delivered', { timeout: 10_000 * SLOW }, async () => {
    state.hang.add('thread/resume')
    const events: NormalizedEvent[] = []
    const adapter = new CodexAdapter()

    const t0 = Date.now()
    const h = await adapter.createSession(
      { sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal', resumeExternalId: 'big-thread' },
      (e) => events.push(e),
    )
    const waited = Date.now() - t0
    expect(waited).toBeGreaterThanOrEqual(2900) // the window for catching a lock error
    expect(waited).toBeLessThan(6000) // does not wait past that — that is the entire point of this feature
    expect(h.externalId).toBe('big-thread') // resume already knows the id — it must be possible to persist it immediately

    // A message sent before resume finishes waits in the queue
    h.send('message sent before it woke up')
    await tick()
    expect(methods()).not.toContain('turn/start')

    // Once resume finishes, the queue flows
    state.resolvers.get('thread/resume')!({ thread: { id: 'big-thread' } })
    await tick()
    await tick()
    const turn = state.requests.find((r) => r.method === 'turn/start')
    expect(turn?.params?.input).toEqual([{ type: 'text', text: 'message sent before it woke up' }])
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  /*
   * Before resume finishes, there is no turn to stop (#168). The old Stop did nothing, and a
   * message queued up behind it went out as turn/start once resume finished — the turn started
   * after the person had already stopped it.
   */
  it('a Stop pressed before resume finishes reclaims the queued message, and a message sent after it still goes out (#168)', { timeout: 10_000 * SLOW }, async () => {
    state.hang.add('thread/resume')
    const events: NormalizedEvent[] = []
    const h = await new CodexAdapter().createSession(
      { sessionId: 's4', cwd: '/tmp', permissionPreset: 'normal', resumeExternalId: 'big-thread' },
      (e) => events.push(e),
    )
    h.send('message sent before it woke up')
    h.interrupt()
    expect(events).toContainEqual({ type: 'state_change', sessionId: 's4', state: 'waiting_input', reason: 'interrupted' })
    h.send('message sent after it stopped')

    state.resolvers.get('thread/resume')!({ thread: { id: 'big-thread' } })
    await tick()
    await tick()
    const turns = state.requests.filter((r) => r.method === 'turn/start').map((r) => r.params?.input)
    expect(turns).toEqual([[{ type: 'text', text: 'message sent after it stopped' }]])
  })

  it('a lock error is thrown as-is within the 3-second window — the fork-in-the-road UI stays alive', async () => {
    state.fail.set('thread/resume', 'thread abc already has an active writer')
    const adapter = new CodexAdapter()
    await expect(
      adapter.createSession(
        { sessionId: 's2', cwd: '/tmp', permissionPreset: 'normal', resumeExternalId: 'locked' },
        () => {},
      ),
    ).rejects.toThrow(/already open elsewhere/)
  })

  /*
   * The lock error past the 3-second window (#168, item 5). It used to become adapter_crashed,
   * losing the code the fork offer is drawn from, and a message queued meanwhile raised the same
   * failure a second time as `internal`. The rejection text is codex-cli 0.153.4's (measured
   * 2026-10-03: -32600 from a second app-server resuming a held thread).
   */
  it('a lock error after the window keeps conversation_locked, said once, naming the message it swallowed (#168)', { timeout: 10_000 * SLOW }, async () => {
    state.hang.add('thread/resume')
    const events: NormalizedEvent[] = []
    const h = await new CodexAdapter().createSession(
      { sessionId: 's5', cwd: '/tmp', permissionPreset: 'normal', resumeExternalId: 'held' },
      (e) => events.push(e),
    )
    h.send('message sent while it was opening')

    state.rejecters.get('thread/resume')!(new Error('thread 01a0fd98-ac0b-7cf3-8dd9-a342a98dcac6 already has an active writer'))
    await tick()
    await tick()
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toEqual([
      {
        type: 'error',
        sessionId: 's5',
        error: {
          code: 'conversation_locked',
          message: expect.stringMatching(/already open elsewhere.*1 message\(s\) were sent while it was opening and were not delivered/),
          retryable: true,
        },
      },
    ])
    expect(methods()).not.toContain('turn/start')
  })

  /*
   * Closed while it was still waking (#428): the person moved on, a swap retired the handle. The real client rejects
   * the pending thread/resume when it is disposed, so ready fails after `closed` is set, and both places that used to
   * speak for the messages stayed quiet (send's catch defers to watchBackgroundStart, which returns once closed). The
   * screen showed them as sent; Claude's rule is that a message is never dropped silently.
   */
  it('closing it while it wakes says the messages sent meanwhile were not delivered, once', { timeout: 10_000 * SLOW }, async () => {
    state.hang.add('thread/resume')
    const events: NormalizedEvent[] = []
    const h = await new CodexAdapter().createSession(
      { sessionId: 's6', cwd: '/tmp', permissionPreset: 'normal', resumeExternalId: 'big-thread' },
      (e) => events.push(e),
    )
    h.send('first message while it wakes')
    h.send('second message while it wakes')
    await h.dispose()
    state.rejecters.get('thread/resume')!(new Error('request cancelled while closing the codex connection'))
    await tick()
    await tick()
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toEqual([
      {
        type: 'error',
        sessionId: 's6',
        error: { code: 'internal', message: expect.stringMatching(/^2 message\(s\) .* not delivered/), retryable: false },
      },
    ])
    expect(methods()).not.toContain('turn/start')
  })

  /*
   * A host swap goes through detach, not dispose: the next host resumes the thread, but the messages this host held
   * behind its still-waking resume go nowhere. Said here, while this host still records the session's events; the
   * client's detach then rejects the pending resume, and nothing says them again.
   */
  it('a host swap while it wakes says the messages sent meanwhile were not delivered, once', { timeout: 10_000 * SLOW }, async () => {
    state.hang.add('thread/resume')
    const events: NormalizedEvent[] = []
    const h = await new CodexAdapter().createSession(
      { sessionId: 's8', cwd: '/tmp', permissionPreset: 'normal', resumeExternalId: 'big-thread' },
      (e) => events.push(e),
    )
    h.send('message while it wakes')
    await h.detach!()
    state.rejecters.get('thread/resume')!(new Error('request abandoned: this host let go of codex'))
    await tick()
    await tick()
    const errors = events.filter((e) => e.type === 'error')
    expect(errors).toEqual([
      {
        type: 'error',
        sessionId: 's8',
        error: { code: 'internal', message: expect.stringMatching(/^1 message\(s\) .* not delivered/), retryable: false },
      },
    ])
    expect(methods()).not.toContain('turn/start')
  })

  // The same when the resume outlives its cap: the crash that retires the handle names the messages, once
  it('a resume past its cap names the messages sent meanwhile in the crash, once', { timeout: 10_000 * SLOW }, async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      state.hang.add('thread/resume')
      const events: NormalizedEvent[] = []
      const h = await new CodexAdapter().createSession(
        { sessionId: 's7', cwd: '/tmp', permissionPreset: 'normal', resumeExternalId: 'slow-thread' },
        (e) => events.push(e),
      )
      h.send('message while it wakes')
      await vi.advanceTimersByTimeAsync(150_000)
      state.rejecters.get('thread/resume')!(new Error('request cancelled while closing the codex connection'))
      await vi.advanceTimersByTimeAsync(0)
      const errors = events.filter((e) => e.type === 'error')
      expect(errors).toEqual([
        {
          type: 'error',
          sessionId: 's7',
          error: {
            code: 'adapter_crashed',
            message: expect.stringMatching(/did not finish within 150s — 1 message\(s\) were sent while it was opening and were not delivered/),
            retryable: true,
          },
        },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('adapter_crashed is raised when a background resume fails — does not leave a silent zombie', { timeout: 10_000 * SLOW }, async () => {
    state.hang.add('thread/resume')
    const events: NormalizedEvent[] = []
    const adapter = new CodexAdapter()
    await adapter.createSession(
      { sessionId: 's3', cwd: '/tmp', permissionPreset: 'normal', resumeExternalId: 'doomed' },
      (e) => events.push(e),
    )

    state.rejecters.get('thread/resume')!(new Error('rollout corrupted'))
    await tick()
    await tick()
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'error',
        sessionId: 's3',
        error: expect.objectContaining({ code: 'adapter_crashed', message: expect.stringContaining('rollout corrupted') }),
      }),
    )
  })
})
