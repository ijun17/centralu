import { describe, expect, it, vi } from 'vitest'

/**
 * 준비(핸드셰이크)에 실패한 세션은 핸들이 밖으로 나가지 않아 dispose를 불러줄 사람이 없다.
 * 그런데 app-server는 생성자에서 이미 떠 있다 — 여기서 거두지 않으면 실패할 때마다
 * 자식 프로세스가 하나씩 조용히 샜다. 클라이언트를 가짜로 갈아 끼워 그 계약만 본다.
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

describe('codex 세션 준비 실패', () => {
  it('핸드셰이크가 실패하면 띄워 둔 app-server를 거둔다 (실패당 자식 하나 누수 방지)', async () => {
    state.failInitialize = true
    const adapter = new CodexAdapter()

    await expect(
      adapter.createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' }, () => {}),
    ).rejects.toThrow(/connection refused/)

    expect(state.instances).toHaveLength(1)
    expect(state.instances[0]!.disposed).toBe(true)
  })
})


describe('codex 승인 요청', () => {
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

  it('centralu 문자열이 들어간 명령 승인을 자동 허용하지 않는다', async () => {
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

  it('centralu 경로가 포함된 다중 파일 승인을 자동 허용하지 않는다', async () => {
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

  it('저장된 항상 허용 규칙은 그대로 자동 허용한다', async () => {
    const { handle, client } = await createLiveSession()
    handle.applyRules?.(['printf centralu'])

    client.trigger({
      id: 12,
      method: 'item/commandExecution/requestApproval',
      params: { item: { command: 'printf centralu', cwd: '/tmp' } },
    })

    expect(client.responses).toContainEqual({ id: 12, payload: { decision: 'accept' } })
  })

  it('관리 MCP elicitation은 승인 우회가 아니라 elicitation 응답으로만 허용한다', async () => {
    const { client } = await createLiveSession()

    client.trigger({ id: 13, method: 'mcp/elicitation/create', params: { serverName: 'centralu' } })

    expect(client.responses).toContainEqual({
      id: 13,
      payload: { action: 'accept', content: null, _meta: null },
    })
  })
})
