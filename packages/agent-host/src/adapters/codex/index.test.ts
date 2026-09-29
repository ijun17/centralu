import { describe, expect, it, vi } from 'vitest'

/**
 * A session that fails to get ready (handshake) never has its handle handed out, so there is
 * nobody left to call dispose. But the app-server has already been started in the constructor —
 * without reclaiming it here, a child process leaked silently, one at a time, on every failure.
 * The client is swapped for a fake so only this contract is checked.
 */
type MockServerRequest = { readonly id: number | string; readonly method: string; readonly params?: unknown }
type MockHandlers = {
  readonly onServerRequest: (request: MockServerRequest) => void
}
type MockInstance = {
  readonly disposed: boolean
  readonly responses: readonly { readonly id: number | string; readonly payload: unknown }[]
  trigger(request: MockServerRequest): void
}

const state = vi.hoisted(() => ({
  failInitialize: true,
  instances: [] as MockInstance[],
}))

vi.mock('./client.js', () => ({
  CodexClient: class implements MockInstance {
    disposed = false
    responses: { readonly id: number | string; readonly payload: unknown }[] = []
    private readonly handlers: MockHandlers

    constructor(handlers: MockHandlers) {
      this.handlers = handlers
      state.instances.push(this)
    }

    request(method: string): Promise<Record<string, unknown>> {
      if (state.failInitialize) {
        return Promise.reject(new Error(`connection refused during ${method}`))
      }
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'thread-1' } })
      return Promise.resolve({})
    }

    notify(): void {}

    respond(id: number | string, payload: unknown): void {
      this.responses.push({ id, payload })
    }

    trigger(request: MockServerRequest): void {
      this.handlers.onServerRequest(request)
    }

    async dispose(): Promise<void> {
      this.disposed = true
    }
  },
}))

const { CodexAdapter } = await import('./index.js')

describe('codex session readiness failure', () => {
  it('reclaims the started app-server when the handshake fails (guards against a leaked child per failure)', async () => {
    state.failInitialize = true
    const adapter = new CodexAdapter()

    await expect(
      adapter.createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' }, () => {}),
    ).rejects.toThrow(/connection refused/)

    expect(state.instances).toHaveLength(1)
    expect(state.instances[0]!.disposed).toBe(true)
  })
})


describe('codex approval requests', () => {
  const createLiveSession = async () => {
    state.failInitialize = false
    state.instances.length = 0
    const events: unknown[] = []
    const adapter = new CodexAdapter()
    const handle = await adapter.createSession(
      { sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' },
      (event) => events.push(event),
    )
    return { handle, events, client: state.instances[0]! }
  }

  it('does not auto-approve a command approval just because it contains the string centralu', async () => {
    const { events, client } = await createLiveSession()

    client.trigger({
      id: 10,
      method: 'item/commandExecution/requestApproval',
      params: { item: { command: 'printf safe', cwd: '/tmp' }, reason: 'centralu' },
    })

    expect(client.responses).toHaveLength(0)
    expect(events).toContainEqual(
      expect.objectContaining({ type: 'approval_request', requestId: 'codex-req-1' }),
    )
  })

  it('does not auto-approve a multi-file approval just because a path includes centralu', async () => {
    const { events, client } = await createLiveSession()

    client.trigger({
      id: 11,
      method: 'item/fileChange/requestApproval',
      params: { item: { changes: [{ path: 'centralu/a.ts', diff: '+x' }, { path: 'b.ts', diff: '+y' }] }, reason: 'centralu' },
    })

    expect(client.responses).toHaveLength(0)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'approval_request',
        detail: expect.objectContaining({ kind: 'file_edit', multi: true }),
      }),
    )
  })

  it('a saved always-allow rule auto-approves as-is', async () => {
    const { handle, client } = await createLiveSession()
    handle.applyRules?.(['printf centralu'])

    client.trigger({
      id: 12,
      method: 'item/commandExecution/requestApproval',
      params: { item: { command: 'printf centralu', cwd: '/tmp' } },
    })

    expect(client.responses).toContainEqual({ id: 12, payload: { decision: 'accept' } })
  })

  it('accepts our own management MCP elicitation only through an elicitation response, not by bypassing approval', async () => {
    const { client } = await createLiveSession()

    client.trigger({ id: 13, method: 'mcp/elicitation/create', params: { serverName: 'centralu' } })

    expect(client.responses).toContainEqual({
      id: 13,
      payload: { action: 'accept', content: null, _meta: null },
    })
  })
})
