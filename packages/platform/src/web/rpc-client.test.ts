import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RpcClient } from './rpc-client.js'

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
  open(): void {
    this.readyState = 1
    this.onopen?.()
  }
  /** 서버 프레임 수신 */
  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent)
  }
  /** 연결이 뚝 끊긴 것처럼 (서버 다운·네트워크 단절) */
  drop(): void {
    this.readyState = 3
    this.onclose?.()
  }
}

function makeClient(opts?: { callTimeoutMs?: number }): RpcClient {
  return new RpcClient({
    url: 'ws://127.0.0.1:1/',
    token: 't',
    WebSocketImpl: FakeWebSocket as unknown as typeof WebSocket,
    callTimeoutMs: opts?.callTimeoutMs,
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
