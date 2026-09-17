import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcClient, type RpcClientOptions } from './rpc-client.js'

/**
 * 진짜 소켓 없이 연결·끊김·응답을 손으로 재현하는 가짜 WebSocket.
 * 재연결(백오프 setTimeout)까지 검증해야 하므로 fake timer와 함께 쓴다.
 */
class FakeWebSocket {
  static instances: FakeWebSocket[] = []
  static get last(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!
  }
  readyState = 0
  bufferedAmount = 0
  sent: string[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: MessageEvent) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(public url: string) {
    FakeWebSocket.instances.push(this)
  }
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.readyState = 3
  }
  /** 서버가 연결을 받아준 것처럼 */
  open(authenticate = true): void {
    this.readyState = 1
    this.onopen?.()
    if (authenticate) this.receive({ kind: 'hello_ok', protocolVersion: 1, currentSeq: 0, streamEpoch: 'host-a' })
  }
  /** 서버 프레임 수신 */
  receive(frame: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(frame) }))
  }
  /** 연결이 뚝 끊긴 것처럼 (서버 다운·네트워크 단절) */
  drop(): void {
    this.readyState = 3
    this.onclose?.()
  }
}

function makeClient(opts?: Partial<RpcClientOptions>): RpcClient {
  return new RpcClient({
    url: 'ws://127.0.0.1:1/',
    token: 't',
    WebSocketImpl: FakeWebSocket,
    ...opts,
  })
}

/** 마지막으로 나간 rpc 프레임의 id */
function lastRpcId(ws: FakeWebSocket): string {
  const frames = ws.sent.map((s) => JSON.parse(s) as { kind: string; id?: string }).filter((f) => f.kind === 'rpc')
  return frames[frames.length - 1]!.id!
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeWebSocket.instances = []
})

afterEach(() => {
  vi.useRealTimers()
})

/**
 * 읽을 수 없는 응답도 응답이다 (도그푸딩 2026-09-10).
 *
 * host가 프로토콜에 없는 에러 코드를 실어 보내자 프레임이 검사에서 떨어져 조용히
 * 버려졌고, 부른 쪽은 30초 타임아웃까지 답을 기다렸다 — 화면은 그동안 '불러오는 중'.
 */
describe('RpcClient 읽을 수 없는 응답 (도그푸딩)', () => {
  it('검사에 떨어진 실패 응답도 그 호출을 끝낸다 — 설명을 그대로 들고', async () => {
    const rpc = makeClient()
    rpc.connect()
    const ws = FakeWebSocket.last
    ws.open()

    const call = rpc.call('fs.readFile', { projectId: 'p', path: 'item.yml' })
    ws.receive({
      kind: 'res',
      id: lastRpcId(ws),
      ok: false,
      // 'ENOENT'는 ProtocolErrorCode에 없다 — 프레임 전체가 검사에서 떨어진다
      error: { code: 'ENOENT', message: 'ENOENT: no such file or directory', retryable: false },
    })

    await expect(call).rejects.toThrow('ENOENT: no such file or directory')
    rpc.close()
  })

  it('기다리는 호출이 아닌 이상한 프레임은 여전히 무시한다', async () => {
    const rpc = makeClient()
    rpc.connect()
    const ws = FakeWebSocket.last
    ws.open()

    const call = rpc.call('sessions.list', {})
    ws.receive({ kind: 'res', id: 'nobody-waits-for-this', ok: false, error: { code: 'ENOENT', message: 'x' } })
    ws.receive({ kind: 'wat', hello: 1 })
    // 우리 호출은 멀쩡히 살아 있다 — 그리고 진짜 답이 오면 그때 끝난다
    ws.receive({ kind: 'res', id: lastRpcId(ws), ok: true, result: { sessions: [] } })

    await expect(call).resolves.toMatchObject({ sessions: [] })
    rpc.close()
  })
})

describe('RpcClient 끊김 시 in-flight 거절 (U1)', () => {
  it('보내고 답을 못 받은 RPC는 연결이 끊기면 retryable 에러로 거절된다', async () => {
    const rpc = makeClient()
    rpc.connect()
    const ws = FakeWebSocket.last
    ws.open()

    const call = rpc.call('sessions.list', {})
    ws.drop()

    await expect(call).rejects.toMatchObject({ code: 'connection_lost', retryable: true })
    rpc.close()
  })

  it('끊긴 동안 큐에만 있던(안 보낸) RPC는 거절되지 않고 재연결 후 전송·해결된다', async () => {
    const rpc = makeClient()
    rpc.connect()
    const ws1 = FakeWebSocket.last
    ws1.open()
    ws1.drop()

    // 끊긴 상태에서 호출 — 큐잉이 기존 계약이다
    const call = rpc.call('sessions.list', {})

    // 백오프 타이머가 재연결을 만든다
    await vi.advanceTimersByTimeAsync(1000)
    const ws2 = FakeWebSocket.last
    expect(ws2).not.toBe(ws1)
    ws2.open()

    const id = lastRpcId(ws2)
    ws2.receive({ kind: 'res', id, ok: true, result: [] })
    await expect(call).resolves.toEqual([])
    rpc.close()
  })

  it('재연결 후 전송된(=이제 in-flight인) 큐 호출도 다음 끊김에서는 거절된다', async () => {
    const rpc = makeClient()
    rpc.connect()
    FakeWebSocket.last.open()
    FakeWebSocket.last.drop()

    const call = rpc.call('sessions.list', {})
    await vi.advanceTimersByTimeAsync(1000)
    const ws2 = FakeWebSocket.last
    ws2.open() // 큐가 비워지며 전송됐다
    ws2.drop() // 답을 받기 전에 또 끊겼다

    await expect(call).rejects.toMatchObject({ code: 'connection_lost', retryable: true })
    rpc.close()
  })

  it('응답이 영영 없으면 제한 시간에 거절된다 (소켓은 멀쩡해도)', async () => {
    const rpc = makeClient({ callTimeoutMs: 5000 })
    rpc.connect()
    FakeWebSocket.last.open()

    const call = rpc.call('sessions.list', {})
    const assertion = expect(call).rejects.toMatchObject({ code: 'timeout', retryable: true })
    await vi.advanceTimersByTimeAsync(5001)
    await assertion

    // 늦게 온 응답은 조용히 무시된다 (이중 해결 없음)
    FakeWebSocket.last.receive({ kind: 'res', id: lastRpcId(FakeWebSocket.last), ok: true, result: [] })
    rpc.close()
  })

  it('제한 시간은 큐에 갇힌 호출도 정리한다 — pending·queue가 무한히 자라지 않는다', async () => {
    const rpc = makeClient({ callTimeoutMs: 5000 })
    rpc.connect()
    FakeWebSocket.last.open()
    FakeWebSocket.last.drop()

    const call = rpc.call('sessions.list', {})
    const assertion = expect(call).rejects.toMatchObject({ code: 'timeout' })
    await vi.advanceTimersByTimeAsync(5001)
    await assertion

    // 거절된 호출의 프레임은 재연결 때 다시 나가면 안 된다
    await vi.advanceTimersByTimeAsync(10_000)
    const ws = FakeWebSocket.last
    ws.open()
    expect(ws.sent.filter((s) => (JSON.parse(s) as { kind: string }).kind === 'rpc')).toHaveLength(0)
    rpc.close()
  })

  it('updateEndpoint(host 재기동)도 옛 host로 나간 in-flight를 거절한다', async () => {
    const rpc = makeClient()
    rpc.connect()
    FakeWebSocket.last.open()

    const call = rpc.call('sessions.list', {})
    rpc.updateEndpoint('ws://127.0.0.1:2/', 't2')

    await expect(call).rejects.toMatchObject({ code: 'connection_lost', retryable: true })
    rpc.close()
  })
})


describe('authenticated recovery boundary', () => {
  it('does not send queued or new RPCs or announce readiness before hello_ok', async () => {
    const rpc = makeClient()
    const states: string[] = []
    rpc.onConnectionChange((state) => states.push(state))
    rpc.connect()
    const queued = rpc.call('sessions.list', {})
    const ws = FakeWebSocket.last
    ws.open(false)
    const opened = rpc.call('sessions.list', {})
    expect(states).not.toContain('connected')
    expect(rpc.connectionState).toBe('connecting')
    expect(ws.sent).toHaveLength(1)
    ws.receive({ kind: 'hello_ok', protocolVersion: 1, currentSeq: 0, streamEpoch: 'a' })
    expect(states).toContain('connected')
    expect(ws.sent).toHaveLength(3)
    ws.receive({ kind: 'res', id: '1', ok: true, result: [] })
    ws.receive({ kind: 'res', id: '2', ok: true, result: [] })
    await Promise.all([queued, opened])
    rpc.close()
  })

  it('deduplicates replay and detects a restarted host at the identical endpoint', async () => {
    const rpc = makeClient()
    const seen: string[] = []
    rpc.onEvent((e) => seen.push(e.type))
    rpc.onConnectionChange((s) => seen.push(s))
    rpc.connect()
    const first = FakeWebSocket.last
    first.open()
    const event = { type: 'message_delta', sessionId: 's', role: 'assistant', text: 'a' }
    first.receive({ kind: 'event', seq: 30, event })
    first.receive({ kind: 'event', seq: 30, event })
    expect(seen.filter((s) => s === 'message_delta')).toHaveLength(1)
    first.drop()
    await vi.advanceTimersByTimeAsync(200)
    const second = FakeWebSocket.last
    second.open(false)
    expect(JSON.parse(second.sent[0]!)).toMatchObject({ afterSeq: 30, streamEpoch: 'host-a' })
    second.receive({ kind: 'hello_ok', protocolVersion: 1, currentSeq: 0, streamEpoch: 'host-b', resyncRequired: true })
    second.receive({ kind: 'event', seq: 1, event })
    expect(seen.slice(-2)).toEqual(['resync_required', 'message_delta'])
    second.drop()
    await vi.advanceTimersByTimeAsync(200)
    FakeWebSocket.last.open(false)
    expect(JSON.parse(FakeWebSocket.last.sent[0]!)).toMatchObject({ afterSeq: 1, streamEpoch: 'host-b' })
    rpc.close()
  })

  it('close cancels reconnect timers and rejects subsequent calls immediately', async () => {
    const rpc = makeClient()
    rpc.connect()
    FakeWebSocket.last.open()
    FakeWebSocket.last.drop()
    rpc.close()
    expect(vi.getTimerCount()).toBe(0)
    await expect(rpc.call('sessions.list', {})).rejects.toMatchObject({ code: 'connection_closed' })
  })
})


describe('bounded pending calls', () => {
  it('rejects admission beyond the cap without sending it after reconnect', async () => {
    const rpc = makeClient({ maxPendingCalls: 1 })
    rpc.connect()
    const first = rpc.call('sessions.list', {})
    await expect(rpc.call('sessions.list', {})).rejects.toMatchObject({ code: 'overloaded' })
    const ws = FakeWebSocket.last
    ws.open()
    expect(ws.sent).toHaveLength(2)
    ws.receive({ kind: 'res', id: lastRpcId(ws), ok: true, result: [] })
    await first
    rpc.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('caps queued bytes and socket backlog independently of call count', async () => {
    const rpc = makeClient({ maxBufferedBytes: 100 })
    rpc.connect()
    await expect(rpc.call('sessions.rename', { sessionId: 's', name: 'x'.repeat(101) })).rejects.toMatchObject({ code: 'overloaded' })
    const ws = FakeWebSocket.last
    ws.open()
    ws.bufferedAmount = 100
    await expect(rpc.call('sessions.list', {})).rejects.toMatchObject({ code: 'overloaded' })
    expect(ws.sent).toHaveLength(1)
    rpc.close()
  })

  it('never replays sent side effects, even when the response was lost', async () => {
    const rpc = makeClient()
    rpc.connect()
    const first = FakeWebSocket.last
    first.open()
    const call = rpc.call('sessions.rename', { sessionId: 's', name: 'new' })
    first.drop()
    await expect(call).rejects.toMatchObject({ code: 'connection_lost' })
    await vi.advanceTimersByTimeAsync(200)
    const next = FakeWebSocket.last
    next.open()
    expect(next.sent).toHaveLength(1)
    rpc.close()
  })

  it('times out a withheld handshake and ignores events before authentication', async () => {
    const rpc = makeClient({ handshakeTimeoutMs: 100 })
    const events: unknown[] = []
    rpc.onEvent((e) => events.push(e))
    rpc.connect()
    const ws = FakeWebSocket.last
    ws.open(false)
    ws.receive({ kind: 'event', seq: 1, event: { type: 'turn_complete', sessionId: 's' } })
    expect(events).toEqual([])
    await vi.advanceTimersByTimeAsync(100)
    expect(ws.readyState).toBe(3)
    rpc.close()
  })
})


describe('existing attachment budget', () => {
  it('admits a base64-encoded 20 MiB attachment under default transport limits', async () => {
    const rpc = makeClient()
    rpc.connect()
    const ws = FakeWebSocket.last
    ws.open()
    const call = rpc.call('attachments.save', { sessionId: 's', name: 'large.bin', mime: 'application/octet-stream', dataBase64: 'A'.repeat(Math.ceil(20 * 1024 * 1024 / 3) * 4) })
    expect(ws.sent).toHaveLength(2)
    ws.receive({ kind: 'res', id: '1', ok: true, result: { path: '/fixture/large.bin' } })
    await expect(call).resolves.toMatchObject({ path: '/fixture/large.bin' })
    rpc.close()
  })
})

describe('upstream malformed-response salvage survives recovery refactor', () => {
  it.each([
    { ok: false, error: { code: 'ENOENT', message: 'file disappeared', retryable: false } },
    { ok: 'invalid', result: [] },
  ])('rejects an unreadable response immediately and clears its deadline: %j', async (response) => {
    const rpc = makeClient()
    rpc.connect()
    const ws = FakeWebSocket.last
    ws.open()
    const call = rpc.call('sessions.list', {})
    const rejected = expect(call).rejects.toMatchObject({ code: 'internal', retryable: false })
    ws.receive({ kind: 'res', id: lastRpcId(ws), ...response })
    await rejected
    expect(vi.getTimerCount()).toBe(0)
    rpc.close()
  })

  it('resync advances the reconnect watermark without applying discarded replay', async () => {
    const rpc = makeClient()
    const seen: string[] = []
    rpc.onEvent((event) => seen.push(event.type))
    rpc.connect()
    const ws = FakeWebSocket.last
    ws.open(false)
    ws.receive({ kind: 'hello_ok', protocolVersion: 1, currentSeq: 42, streamEpoch: 'host-a', resyncRequired: true })
    ws.receive({ kind: 'event', seq: 42, event: { type: 'turn_complete', sessionId: 's' } })
    expect(seen).toEqual([])
    ws.drop()
    await vi.advanceTimersByTimeAsync(200)
    FakeWebSocket.last.open(false)
    expect(JSON.parse(FakeWebSocket.last.sent[0]!)).toMatchObject({ afterSeq: 42, streamEpoch: 'host-a' })
    rpc.close()
  })
})
