import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * The bug where stop did not work (dogfooding 2026-09-07: "only the tool call stops, and a few
 * seconds later it starts again").
 *
 * The measured cause was one line — `turn/interrupt` was sent with only threadId, and the server
 * **rejected** it with `Invalid request: missing field \`turnId\`` (-32600). That rejection was
 * only piped into an error event, and the turn ran to completion. So there is exactly one thing
 * checked here: **which turn does the stop command point at.**
 */
const state = vi.hoisted(() => ({
  requests: [] as { method: string; params: Record<string, unknown> | undefined }[],
  handlers: null as null | { onNotification: (n: { method: string; params?: unknown }) => void },
  /** The turn to load into the turn/start response (the test decides whether the notification or the response comes first) */
  startTurnId: null as string | null,
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    constructor(handlers: { onNotification: (n: { method: string; params?: unknown }) => void }) {
      state.handlers = handlers
    }
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      state.requests.push({ method, params })
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 't1' } })
      if (method === 'turn/start' && state.startTurnId) return Promise.resolve({ turn: { id: state.startTurnId } })
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('./index.js')

const tick = () => new Promise((r) => setTimeout(r, 0))
const interrupts = () => state.requests.filter((r) => r.method === 'turn/interrupt')

beforeEach(() => {
  state.requests.length = 0
  state.startTurnId = null
})

async function session() {
  const adapter = new CodexAdapter()
  return adapter.createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
}

describe('codex stop — must point at the running turn to work', () => {
  it('takes the turn turn/started reported as the target', async () => {
    const h = await session()
    h.send('a long-running task')
    await tick()
    state.handlers!.onNotification({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'turn-7' } } })

    h.interrupt()
    expect(interrupts()[0]?.params).toEqual({ threadId: 't1', turnId: 'turn-7' })
  })

  it('stops even when the response arrives before the notification — the case of pressing it very quickly', async () => {
    state.startTurnId = 'turn-9'
    const h = await session()
    h.send('a long-running task')
    await tick()
    await tick()

    h.interrupt()
    expect(interrupts()[0]?.params).toEqual({ threadId: 't1', turnId: 'turn-9' })
  })

  it('a stop after the turn has ended sends nothing anywhere — stopping an ended turn would just come back rejected', async () => {
    const h = await session()
    h.send('a quick task')
    await tick()
    state.handlers!.onNotification({ method: 'turn/started', params: { threadId: 't1', turn: { id: 'turn-7' } } })
    state.handlers!.onNotification({ method: 'turn/completed', params: { threadId: 't1', turn: { id: 'turn-7' } } })

    h.interrupt()
    expect(interrupts()).toHaveLength(0)
  })

  it('stays quiet when pressed on a session that has never sent anything', async () => {
    const h = await session()
    h.interrupt()
    expect(interrupts()).toHaveLength(0)
  })
})
