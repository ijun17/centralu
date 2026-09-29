import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Deleting the original conversation (dogfooding 2026-09-07: "created a worktree session by
 * mistake and it will not delete").
 *
 * The measured circumstances: codex only issues the id at thread/start and writes the rollout
 * file on **the first turn**. A session that never had a single message exchanged has no file to
 * delete, so thread/delete rejects it with -32600, and if that rejection is thrown from the
 * manager, neither the session row nor the worktree gets removed.
 *
 * Contract: **a request to delete something that does not exist succeeds**, and every other
 * failure is still thrown.
 */
const state = vi.hoisted(() => ({
  requests: [] as string[],
  fail: null as string | null,
  disposed: 0,
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    request(method: string): Promise<unknown> {
      state.requests.push(method)
      if (method === 'thread/delete' && state.fail) return Promise.reject(new Error(state.fail))
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {
      state.disposed++
    }
  },
}))

const { CodexAdapter } = await import('./index.js')

beforeEach(() => {
  state.requests.length = 0
  state.fail = null
  state.disposed = 0
})

describe('codex deleteExternalConversation', () => {
  it('calls thread/delete when there is something to delete', async () => {
    await new CodexAdapter().deleteExternalConversation('t1', '/tmp')
    expect(state.requests).toContain('thread/delete')
  })

  it('a rejection saying no rollout exists is treated as success — this is what a session that was never used looks like', async () => {
    state.fail = '{"code":-32600,"message":"no rollout found for thread id 01a0"}'
    await expect(new CodexAdapter().deleteExternalConversation('t1', '/tmp')).resolves.toBeUndefined()
  })

  it('does not swallow other failures — must not report success while the original still exists', async () => {
    state.fail = 'permission denied'
    await expect(new CodexAdapter().deleteExternalConversation('t1', '/tmp')).rejects.toThrow(/permission denied/)
  })

  it('closes the short-lived client either way', async () => {
    state.fail = '{"code":-32600,"message":"no rollout found for thread id x"}'
    await new CodexAdapter().deleteExternalConversation('t1', '/tmp')
    expect(state.disposed).toBe(1)
  })
})
