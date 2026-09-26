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

/*
 * 되살리기로 끝나는 RPC는 긴 예산을 받는다 (#164). 되살리기는 프로세스 시작에만 150초까지 쓰는데(매니저의 단계 제한),
 * 이 다섯은 목록에 없어서 30초에 끊겼다 — host는 설정을 적용하고 다시 띄웠는데 화면은 실패를 띄웠다.
 */
describe('RpcClient — 되살리기로 끝나는 호출의 예산 (#164)', () => {
  const RESUMING = [
    'agents.updateSettings',
    'agents.forkConversation',
    'agents.resolveMcpProposal',
    'agents.resolveSkillProposal',
    'agents.deleteOrchestratorSkill',
  ] as const

  it.each(RESUMING)('%s는 30초에 끊기지 않고 180초에 끊긴다', async (method) => {
    const rpc = makeClient()
    rpc.connect()
    FakeWebSocket.last.open()
    let settled = false
    const call = (rpc.call as (m: string, p: unknown) => Promise<unknown>)(method, {})
    const assertion = expect(call.finally(() => (settled = true))).rejects.toMatchObject({ code: 'timeout' })

    await vi.advanceTimersByTimeAsync(30_001)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(150_000)
    await assertion
    rpc.close()
  })
})

/*
 * #173: 재생의 출발점. 처음 만난 host는 버퍼를 통째로 재생하는데 그것은 화면이 붙기 전에 끝난 일이다(끝난 턴마다
 * "done" 카드가 섰다). 같은 주소로 다시 뜬 host에 옛 번호를 들고 붙으면 아무것도 재생받지 못했다.
 */
describe('RpcClient — 재생의 출발점 (#173)', () => {
  const ev = (seq: number) => ({
    kind: 'event',
    seq,
    event: { type: 'message_delta', sessionId: 's1', role: 'assistant', text: `e${seq}` },
  })
  const hellos = (ws: FakeWebSocket) =>
    ws.sent.map((s) => JSON.parse(s) as { kind: string; afterSeq?: number }).filter((f) => f.kind === 'hello')

  function connected() {
    const rpc = makeClient()
    const got: string[] = []
    const conn: string[] = []
    rpc.onEvent((e) => got.push((e as { text: string }).text))
    rpc.onConnectionChange((s) => conn.push(s))
    rpc.connect()
    FakeWebSocket.last.open()
    return { rpc, got, conn }
  }

  it('처음 만난 host가 재생하는 옛 이벤트는 넘기지 않고, 그 뒤의 것부터 넘긴다', () => {
    const { rpc, got, conn } = connected()
    const ws = FakeWebSocket.last
    expect(hellos(ws)[0]!.afterSeq).toBeUndefined()
    ws.receive({ kind: 'hello_ok', protocolVersion: 1, resyncRequired: false, currentSeq: 3 })
    for (const n of [1, 2, 3, 4]) ws.receive(ev(n))
    expect(got).toEqual(['e4'])
    // 처음 만났으니 다시 읽을 것도 없다 — 화면은 방금 목록과 저장소에서 시작했다
    expect(conn).not.toContain('resync_required')

    // 다음 재연결은 받은 데까지를 말하고, 그 뒤의 재생은 놓친 것이므로 넘긴다
    ws.drop()
    vi.advanceTimersByTime(1000)
    const ws2 = FakeWebSocket.last
    ws2.open()
    expect(hellos(ws2)[0]!.afterSeq).toBe(4)
    ws2.receive({ kind: 'hello_ok', protocolVersion: 1, resyncRequired: false, currentSeq: 5 })
    ws2.receive(ev(5))
    expect(got).toEqual(['e4', 'e5'])
    rpc.close()
  })

  it('host가 같은 주소로 다시 떠 번호가 작아졌으면 재동기화를 알리고 새 번호로 내려앉는다', () => {
    const { rpc, got, conn } = connected()
    const ws = FakeWebSocket.last
    ws.receive({ kind: 'hello_ok', protocolVersion: 1, resyncRequired: false, currentSeq: 0 })
    for (let n = 1; n <= 50; n++) ws.receive(ev(n))

    ws.drop()
    vi.advanceTimersByTime(1000)
    const ws2 = FakeWebSocket.last
    ws2.open()
    expect(hellos(ws2)[0]!.afterSeq).toBe(50)
    // 새 host는 이벤트 셋까지만 매겼다
    ws2.receive({ kind: 'hello_ok', protocolVersion: 1, resyncRequired: false, currentSeq: 3 })
    expect(conn.filter((s) => s === 'resync_required')).toHaveLength(1)
    ws2.receive(ev(4))
    expect(got[got.length - 1]).toBe('e4')

    // 그다음 끊김에서는 새 host의 번호로 재생을 청한다 — 옛 50이 아니라
    ws2.drop()
    vi.advanceTimersByTime(1000)
    const ws3 = FakeWebSocket.last
    ws3.open()
    expect(hellos(ws3)[0]!.afterSeq).toBe(4)
    rpc.close()
  })

  it('새 host로 옮겨 붙은 첫 만남은 재생을 넘기지 않되, 화면이 든 것을 다시 읽으라고 알린다', () => {
    const { rpc, got, conn } = connected()
    FakeWebSocket.last.receive({ kind: 'hello_ok', protocolVersion: 1, resyncRequired: false, currentSeq: 0 })
    rpc.updateEndpoint('ws://127.0.0.1:2/', 't2')
    const ws2 = FakeWebSocket.last
    ws2.open()
    ws2.receive({ kind: 'hello_ok', protocolVersion: 1, resyncRequired: false, currentSeq: 2 })
    ws2.receive(ev(1))
    ws2.receive(ev(2))
    expect(got).toEqual([])
    expect(conn).toContain('resync_required')
    rpc.close()
  })
})
