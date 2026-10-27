import { describe, expect, it, vi } from 'vitest'

/** The app-server client is swapped for a fake (as in index.test.ts), so the session's own notifications are what is sent */
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
  initialize: {},
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

/**
 * Reasoning summaries of two items run together (#1464). The headings below are the ones the issue quotes from a stored
 * session: `**Checking projects child process****흰 화면의 초기화 로그를 확인합니다.**` and
 * `**검증 기록 출처를 확인합니다****Awaiting RPC verification**`. Each pair is two reasoning items (each starts at part 0
 * and sends no `summaryPartAdded`), appended into one row by the host.
 */
describe('codex reasoning summaries stay apart (#1464)', () => {
  const live = async () => {
    state.failInitialize = false
    state.instances.length = 0
    const events: { type: string; text?: string }[] = []
    const adapter = new CodexAdapter()
    await adapter.createSession({ sessionId: 's1', cwd: '/tmp', permissionPreset: 'normal' }, (e) => events.push(e))
    const client = state.instances[0]!
    const say = (method: string, params: Record<string, unknown>) => client.notifyFrom({ method, params: { threadId: 'thread-1', turnId: 't1', ...params } })
    const delta = (itemId: string, summaryIndex: number, text: string) => say('item/reasoning/summaryTextDelta', { itemId, summaryIndex, delta: text })
    /** What one stored row would hold: the chunks of one open row, joined */
    const reasoning = () => events.filter((e) => e.type === 'reasoning_delta').map((e) => e.text ?? '').join('')
    return { events, say, delta, reasoning }
  }

  it('a second reasoning item starts after a blank line, not glued to the first', async () => {
    const { delta, reasoning } = await live()
    delta('rs_1', 0, '**Checking projects child process**')
    delta('rs_2', 0, '**흰 화면의 초기화 로그를 확인합니다.**')
    expect(reasoning()).toBe('**Checking projects child process**\n\n**흰 화면의 초기화 로그를 확인합니다.**')
  })

  it('the same for headings of two languages, streamed in chunks', async () => {
    const { delta, reasoning } = await live()
    delta('rs_1', 0, '**검증 기록 ')
    delta('rs_1', 0, '출처를 확인합니다**')
    delta('rs_2', 0, '**Awaiting RPC ')
    delta('rs_2', 0, 'verification**')
    expect(reasoning()).toBe('**검증 기록 출처를 확인합니다**\n\n**Awaiting RPC verification**')
  })

  it('parts of one item keep the one blank line summaryPartAdded gives them', async () => {
    const { say, delta, reasoning } = await live()
    delta('rs_1', 0, '**One**')
    say('item/reasoning/summaryPartAdded', { itemId: 'rs_1', summaryIndex: 1 })
    delta('rs_1', 1, '**Two**')
    delta('rs_2', 0, '**Three**')
    expect(reasoning()).toBe('**One**\n\n**Two**\n\n**Three**')
  })

  it('the first reasoning of a row, after a tool call or in the next turn, has no blank line in front', async () => {
    const { say, delta, reasoning } = await live()
    delta('rs_1', 0, '**One**')
    delta('rs_2', 0, '**Two**')
    say('item/completed', { item: { type: 'commandExecution', id: 'c1', command: 'ls', cwd: '/tmp', status: 'completed', aggregatedOutput: '', exitCode: 0, commandActions: [], source: 'agent', processId: null, durationMs: 1 } })
    delta('rs_3', 0, '**Three**')
    say('turn/completed', { turn: { id: 't1', status: 'completed', items: [], error: null } })
    delta('rs_4', 0, '**Four**')
    // Joined within the row of rs_1 and rs_2; the tool call and the turn's end each start a row, whose first chunk has none
    expect(reasoning()).toBe('**One**\n\n**Two****Three****Four**')
  })
})
