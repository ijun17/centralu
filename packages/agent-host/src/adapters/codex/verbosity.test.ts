import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * Response verbosity (#54) is only ever passed through **thread config.**
 *
 * It looks like the same kind of setting as effort, but the shape differs — turn/start has no slot
 * for verbosity (absent from generated/v2/TurnStartParams.ts, measured). So this checks whether it
 * is loaded at the two spots where a thread is started (thread/start, thread/resume). Leaving it
 * out here becomes the kind of loss nobody can see: the screen shows it selected, but codex runs
 * on its default.
 *
 * The client is swapped for a fake and **the request parameters are inspected directly** — since
 * the whole of this contract is "what was sent," there is no better check than recording what was sent.
 */
const state = vi.hoisted(() => ({
  requests: [] as { method: string; params: Record<string, unknown> | undefined }[],
}))

vi.mock('./client.js', () => ({
  CodexClient: class {
    request(method: string, params?: Record<string, unknown>): Promise<unknown> {
      state.requests.push({ method, params })
      if (method === 'thread/start' || method === 'thread/resume') {
        return Promise.resolve({ thread: { id: 't1' } })
      }
      return Promise.resolve({})
    }
    notify(): void {}
    respond(): void {}
    async dispose(): Promise<void> {}
  },
}))

const { CodexAdapter } = await import('./index.js')

const paramsOf = (method: string) => state.requests.find((r) => r.method === method)?.params

beforeEach(() => {
  state.requests.length = 0
})

describe('carrying codex response verbosity through', () => {
  it("is loaded into thread/start's config.model_verbosity", async () => {
    const adapter = new CodexAdapter()
    await adapter.createSession(
      { sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal', verbosity: 'low' },
      () => {},
    )
    expect(paramsOf('thread/start')?.config).toMatchObject({ model_verbosity: 'low' })
  })

  it('carries through on resume (thread/resume) too — settings must not reset after waking up', async () => {
    const adapter = new CodexAdapter()
    await adapter.createSession(
      { sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal', verbosity: 'high', resumeExternalId: 'ext-1' },
      () => {},
    )
    expect(paramsOf('thread/resume')?.config).toMatchObject({ model_verbosity: 'high' })
  })

  /** Response speed (service_tier) uses the same plumbing — both start and resume */
  it("a speed tier is loaded into thread/start's and thread/resume's config.service_tier", async () => {
    const a1 = new CodexAdapter()
    await a1.createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal', serviceTier: 'priority' }, () => {})
    expect(paramsOf('thread/start')?.config).toMatchObject({ service_tier: 'priority' })

    state.requests.length = 0
    const a2 = new CodexAdapter()
    await a2.createSession(
      { sessionId: 's2', cwd: '/tmp', permissionPreset: 'normal', serviceTier: 'priority', resumeExternalId: 'ext-1' },
      () => {},
    )
    expect(paramsOf('thread/resume')?.config).toMatchObject({ service_tier: 'priority' })
  })

  it('with nothing selected, the service_tier key does not exist at all — the default speed also belongs to codex', async () => {
    const adapter = new CodexAdapter()
    await adapter.createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
    const config = paramsOf('thread/start')?.config as Record<string, unknown>
    expect(config.service_tier).toBeUndefined()
  })

  /*
   * The old contract was "send no config at all if nothing is selected." #58 changed one spot:
   * we turn on model_reasoning_summary ourselves — without that switch, the reasoning stream never
   * arrives, not once, which makes the feature we wired up equivalent to not existing (measured).
   * Every other default still belongs to codex: if verbosity was not selected, that key must be absent.
   */
  it('sends no verbosity key when nothing is selected — only the reasoning-summary switch is ours to turn on', async () => {
    const adapter = new CodexAdapter()
    await adapter.createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' }, () => {})
    const config = paramsOf('thread/start')?.config as Record<string, unknown>
    expect(config.model_reasoning_summary).toBe('auto')
    expect(config.model_verbosity).toBeUndefined()
  })

  /*
   * config is also used by the orchestrator block. When two spreads produce the same key, **the
   * later one overwrites the earlier one entirely** — they do not merge. Without this test,
   * neither the person who added verbosity nor whoever adds a third thing to config later would be
   * able to read that fact from the code.
   */
  it("merges into one block with the orchestrator's config — neither overwrites the other", async () => {
    const adapter = new CodexAdapter()
    await adapter.createSession(
      {
        sessionId: 's1',
        cwd: '/tmp',
        permissionPreset: 'normal',
        verbosity: 'medium',
        orchestratorTools: {} as never,
        orchestratorBridge: { url: 'http://127.0.0.1:1', token: 't' },
      },
      () => {},
    )
    const config = paramsOf('thread/start')?.config as Record<string, unknown>
    expect(config.model_verbosity).toBe('medium')
    expect(config.mcp_servers).toBeDefined()
    expect(config.project_doc_max_bytes).toBe(0)
  })
})
