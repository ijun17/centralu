import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * Resume works like Claude's — we do not make the person wait for it (dogfooding: the same 122MB
 * thread took 3 seconds in the CLI, 13+ seconds on our path. The cost of thread/resume re-reading
 * the file belongs to codex, but paying that cost in front of a "Waking…" screen was our own choice).
 *
 * Three contracts guarded here:
 *  1. For a large thread, the handle comes out first after 3 seconds — a message waits in the ready queue until delivered
 *  2. A lock error is thrown as-is within the 3-second window — this keeps the "split off and continue" fork-in-the-road UI alive
 *  3. When a background resume fails, it does not go quietly to sleep — the manager retires it via adapter_crashed
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
  it('for a large thread, the handle comes out first after 3 seconds, and a message waits in the queue until delivered', { timeout: 10_000 }, async () => {
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
    h.send('깨기 전에 보낸 말')
    await tick()
    expect(methods()).not.toContain('turn/start')

    // Once resume finishes, the queue flows
    state.resolvers.get('thread/resume')!({ thread: { id: 'big-thread' } })
    await tick()
    await tick()
    const turn = state.requests.find((r) => r.method === 'turn/start')
    expect(turn?.params?.input).toEqual([{ type: 'text', text: '깨기 전에 보낸 말' }])
    expect(events.some((e) => e.type === 'error')).toBe(false)
  })

  /*
   * Before resume finishes, there is no turn to stop (#168). The old Stop did nothing, and a
   * message queued up behind it went out as turn/start once resume finished — the turn started
   * after the person had already stopped it.
   */
  it('a Stop pressed before resume finishes reclaims the queued message, and a message sent after it still goes out (#168)', { timeout: 10_000 }, async () => {
    state.hang.add('thread/resume')
    const events: NormalizedEvent[] = []
    const h = await new CodexAdapter().createSession(
      { sessionId: 's4', cwd: '/tmp', permissionPreset: 'normal', resumeExternalId: 'big-thread' },
      (e) => events.push(e),
    )
    h.send('깨기 전에 보낸 말')
    h.interrupt()
    expect(events).toContainEqual({ type: 'state_change', sessionId: 's4', state: 'waiting_input', reason: 'interrupted' })
    h.send('멈춘 뒤에 보낸 말')

    state.resolvers.get('thread/resume')!({ thread: { id: 'big-thread' } })
    await tick()
    await tick()
    const turns = state.requests.filter((r) => r.method === 'turn/start').map((r) => r.params?.input)
    expect(turns).toEqual([[{ type: 'text', text: '멈춘 뒤에 보낸 말' }]])
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

  it('adapter_crashed is raised when a background resume fails — does not leave a silent zombie', { timeout: 10_000 }, async () => {
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
