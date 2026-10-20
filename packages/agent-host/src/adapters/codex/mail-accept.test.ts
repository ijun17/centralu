import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A wake the mailbox hands Codex is taken when `turn/start` answers (docs/plans/mailbox.md §7.6.2), not when the write returns:
 * a rejected `turn/start`, or a thread that never comes up, is a failure the mailbox tries again, not a delivery.
 */
const state = vi.hoisted(() => ({
  holdStart: null as null | ((release: () => void) => void),
  startRefused: null as string | null,
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    request(method: string): Promise<unknown> {
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 't1' } })
      if (method === 'turn/start') {
        if (state.startRefused) return Promise.reject(new Error(state.startRefused))
        const res = { turn: { id: 'turn-1' } }
        const hold = state.holdStart
        return hold ? new Promise((resolve) => hold(() => resolve(res))) : Promise.resolve(res)
      }
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('./index.js')
const tick = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  state.holdStart = null
  state.startRefused = null
})

const open = () => new CodexAdapter().createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' }, () => {})

describe('a wake handed to Codex', () => {
  it('is accepted when turn/start answers, once, before the turn is recorded; a rejected turn/start fails it', async () => {
    const h = await open()
    let release!: () => void
    state.holdStart = (r) => (release = r)
    const seen: string[] = []
    void h.sendTracked!('wake', { accepted: () => seen.push('accepted'), complete: () => seen.push('complete'), fail: (e) => seen.push(`fail:${e.message}`) })
    await tick()
    // Written, and not yet taken
    expect(seen).toEqual([])
    release()
    await tick()
    expect(seen).toEqual(['accepted'])

    // And a rejected turn/start is a failure, never an acceptance
    state.holdStart = null
    state.startRefused = 'Invalid request'
    const refused: string[] = []
    await h.sendTracked!('wake', { accepted: () => refused.push('accepted'), complete: () => refused.push('complete'), fail: (e) => refused.push(`fail:${e.message}`) }).catch(() => {})
    await tick()
    expect(refused).toEqual(['fail:Invalid request'])
  })
})
