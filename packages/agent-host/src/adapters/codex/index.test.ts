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
  readonly onNotification: (notification: { readonly method: string; readonly params?: unknown }) => void
}
type MockInstance = {
  readonly disposed: boolean
  readonly responses: readonly { readonly id: number | string; readonly payload: unknown }[]
  trigger(request: MockServerRequest): void
  notifyFrom(notification: { readonly method: string; readonly params?: unknown }): void
}

const state = vi.hoisted(() => ({
  failInitialize: true,
  /** What `initialize` answers */
  initialize: {} as Record<string, unknown>,
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
      if (method === 'initialize') return Promise.resolve(state.initialize)
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

    notifyFrom(notification: { readonly method: string; readonly params?: unknown }): void {
      this.handlers.onNotification(notification)
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

    client.notifyFrom({
      method: 'item/started',
      params: {
        threadId: 'thread-1',
        item: { type: 'fileChange', id: 'fc-11', status: 'inProgress', changes: [{ path: 'centralu/a.ts', kind: { type: 'add' }, diff: '+x' }, { path: 'b.ts', kind: { type: 'add' }, diff: '+y' }] },
      },
    })
    client.trigger({
      id: 11,
      method: 'item/fileChange/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'fc-11', startedAtMs: 1, reason: 'centralu', grantRoot: null },
    })

    expect(client.responses).toHaveLength(0)
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'approval_request',
        detail: expect.objectContaining({ kind: 'file_edit', multi: true }),
      }),
    )
  })

  /*
   * The frames below are the ones codex-cli 0.153.4 sent for one edit of one file under the safe preset
   * (scripts/probe-codex-file-approval.mts), with the temp folder shortened. The request names the item and
   * carries nothing else; the change is on the item that started 1ms before it.
   */
  const MEASURED_PATH = '/tmp/cc-codex-approval-KYZhtL/notes.txt'
  const MEASURED_DIFF = '@@ -1,2 +1,2 @@\n alpha\n-beta\n+gamma\n'
  const measuredItem = (status: string) => ({
    type: 'fileChange',
    id: 'exec-4d7c3f93-0d4a-4dbd-8a33-6bfbfbe021a7',
    changes: [{ path: MEASURED_PATH, kind: { type: 'update', move_path: null }, diff: MEASURED_DIFF }],
    status,
  })
  const measuredRequest = {
    id: 1,
    method: 'item/fileChange/requestApproval',
    params: {
      threadId: 'thread-1',
      turnId: '01a0fd90-5e3b-7f32-a73f-2df2b49846a5',
      itemId: 'exec-4d7c3f93-0d4a-4dbd-8a33-6bfbfbe021a7',
      startedAtMs: 1790960500740,
      reason: null,
      grantRoot: null,
    },
  }

  it('a file-change approval card shows the path and the diff of the item the request names (#169, measured frames)', async () => {
    const { events, client } = await createLiveSession()

    client.notifyFrom({
      method: 'item/started',
      params: { item: measuredItem('inProgress'), threadId: 'thread-1', turnId: measuredRequest.params.turnId, startedAtMs: 1790960500739 },
    })
    client.trigger(measuredRequest)

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'approval_request',
        detail: { kind: 'file_edit', path: MEASURED_PATH, diffPreview: MEASURED_DIFF, multi: false },
      }),
    )
  })

  it('a completed file-change item is forgotten, so a late request for it says (no path) (#169)', async () => {
    const { events, client } = await createLiveSession()

    client.notifyFrom({ method: 'item/started', params: { item: measuredItem('inProgress'), threadId: 'thread-1' } })
    client.notifyFrom({ method: 'item/completed', params: { item: measuredItem('completed'), threadId: 'thread-1' } })
    client.trigger(measuredRequest)

    expect(events).toContainEqual(
      expect.objectContaining({ type: 'approval_request', detail: expect.objectContaining({ path: '(no path)', diffPreview: '' }) }),
    )
  })

  it('a permissions request is refused in its own response shape, not answered with a decision (#169)', async () => {
    const { events, client } = await createLiveSession()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})

    client.trigger({
      id: 14,
      method: 'item/permissions/requestApproval',
      params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'p-1', environmentId: null, startedAtMs: 1, cwd: '/tmp', reason: null, permissions: {} },
    })

    expect(client.responses).toEqual([{ id: 14, payload: { permissions: {}, scope: 'turn' } }])
    expect(events.some((e) => (e as { type?: string }).type === 'approval_request')).toBe(false)
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('permissions request refused'), expect.any(String))
    errors.mockRestore()
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

describe('the CLI version a Codex app-server runs (#297)', () => {
  it('reports the version in the initialize answer’s user agent (measured shape, codex-cli 0.160.0)', async () => {
    state.failInitialize = false
    state.initialize = { userAgent: 'centralu/0.160.0 (Mac OS 27.0.1; arm64) unknown (centralu; 0.1.0-beta.10)', platformOs: 'macos' }
    const events: { type: string }[] = []
    await new CodexAdapter().createSession({ sessionId: 's9', cwd: '/tmp', permissionPreset: 'normal' }, (e) => events.push(e))
    expect(events.filter((e) => e.type === 'agent_version')).toEqual([{ type: 'agent_version', sessionId: 's9', version: '0.160.0' }])
    state.initialize = {}
  })

  it('says nothing when the answer carries no version', async () => {
    state.failInitialize = false
    state.initialize = {}
    const events: { type: string }[] = []
    await new CodexAdapter().createSession({ sessionId: 's10', cwd: '/tmp', permissionPreset: 'normal' }, (e) => events.push(e))
    expect(events.some((e) => e.type === 'agent_version')).toBe(false)
  })
})
