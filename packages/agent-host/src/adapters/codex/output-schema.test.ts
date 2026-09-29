import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * An agent an app asked for by giving a schema (M4 D-1) — Codex receives the schema **per turn**
 * (`turn/start`'s `outputSchema`, the generated type TurnStartParams in installed 0.153.4). Missing
 * it on even one turn leaves that turn's last message as free text outside the schema. This could
 * not be re-verified by running it while logged out — it only checks what is sent (the same fake
 * client approach as interrupt.test.ts).
 */
const state = vi.hoisted(() => ({
  requests: [] as { method: string; params: Record<string, unknown> | undefined }[],
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      state.requests.push({ method, params })
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 't1' } })
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('./index.js')
const tick = () => new Promise((r) => setTimeout(r, 0))
const turns = () => state.requests.filter((r) => r.method === 'turn/start').map((r) => r.params)

beforeEach(() => {
  state.requests.length = 0
})

describe('Codex — the schema is loaded per turn', () => {
  it('a session that received a schema loads outputSchema on every turn it sends', async () => {
    const schema = { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'], additionalProperties: false }
    const h = await new CodexAdapter().createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal', outputSchema: schema }, () => {})
    h.send('first')
    await tick()
    h.send('second')
    await tick()
    expect(turns().map((p) => p?.outputSchema)).toEqual([schema, schema])
  })

  it('loads nothing when there is no schema', async () => {
    const h = await new CodexAdapter().createSession({ sessionId: 's2', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
    h.send('plain')
    await tick()
    expect(turns().map((p) => (p ? 'outputSchema' in p : null))).toEqual([false])
  })
})
