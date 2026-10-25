import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Where a Codex thread compacts by itself (#1376): `model_auto_compact_token_limit` in the per-thread config, on start and on
 * resume, a value that overrides the person's `config.toml` without editing it. Nothing is sent when Centralu does not
 * control it. The client is swapped for a fake and the request parameters inspected, as in verbosity.test.ts.
 */
const state = vi.hoisted(() => ({ requests: [] as { method: string; params: Record<string, unknown> | undefined }[] }))

vi.mock('./client.js', () => ({
  CodexClient: class {
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      state.requests.push({ method, params })
      return Promise.resolve(method === 'thread/start' || method === 'thread/resume' ? { thread: { id: 't1' } } : {})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('./index.js')
const { codexCompactAt } = await import('./thread-open.js')
const configOf = (method: string) => state.requests.find((r) => r.method === method)?.params?.config as Record<string, unknown> | undefined

beforeEach(() => {
  state.requests.length = 0
})

describe('model_auto_compact_token_limit', () => {
  it('rides thread/start and thread/resume', async () => {
    await new CodexAdapter().createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal', autoCompactTokens: 120_000 }, () => {})
    expect(configOf('thread/start')).toMatchObject({ model_auto_compact_token_limit: 120_000 })

    state.requests.length = 0
    await new CodexAdapter().createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal', autoCompactTokens: 600_000, resumeExternalId: 'ext-1' }, () => {})
    expect(configOf('thread/resume')).toMatchObject({ model_auto_compact_token_limit: 600_000 })
  })

  it("is not sent when Centralu does not set it, so the person's own config decides", async () => {
    await new CodexAdapter().createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
    await new CodexAdapter().createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal', resumeExternalId: 'ext-1' }, () => {})
    expect(configOf('thread/start')).not.toHaveProperty('model_auto_compact_token_limit')
    expect(configOf('thread/resume')).not.toHaveProperty('model_auto_compact_token_limit')
  })
})

describe('the point told with a context reading (#1553)', () => {
  it('is the limit the thread was started with, and nothing when Centralu did not set one or the process was adopted', () => {
    expect(codexCompactAt({ autoCompactTokens: 155_040 })).toBe(155_040)
    expect(codexCompactAt({})).toBeUndefined()
    expect(codexCompactAt({ autoCompactTokens: 155_040, processSource: { spawn: {} as never, adopt: {} as never } })).toBeUndefined()
  })
})
