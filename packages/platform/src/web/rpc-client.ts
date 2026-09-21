import {
  PROTOCOL_VERSION,
  parseServerFrame,
  type NormalizedEvent,
  type ProtocolError,
  type RpcMethodName,
  type RpcParams,
  type RpcResult,
} from '@cc/protocol'
import type { ConnectionState, Unsubscribe } from '../ports/index.js'
import { RpcCalls, rpcError } from './rpc-calls.js'

/**
 * WS RPC 클라이언트 — 재연결 + 백오프 + afterSeq 복원 (tech-stack.md: 자작 ~50줄).
 * 이 파일이 ui가 WebSocket을 직접 몰라도 되게 하는 유일한 지점이다.
 */
type RpcSocket = Pick<WebSocket, 'readyState' | 'send' | 'close' | 'onopen' | 'onmessage' | 'onclose' | 'onerror' | 'bufferedAmount'>

export type RpcClientOptions = {
  url: string
  token: string
  /** 테스트 주입용 */
  WebSocketImpl?: new (url: string) => RpcSocket
  maxBackoffMs?: number
  /** RPC 한 번의 응답 제한 시간. host가 응답을 영영 안 주는 경우의 마지막 안전망 */
  callTimeoutMs?: number
  handshakeTimeoutMs?: number
  maxPendingCalls?: number
  maxBufferedBytes?: number
}

/** RPC 응답 제한 시간 기본값. 세션 생성·깃 작업도 이 안에는 끝난다 (실측 수 초) */
const DEFAULT_CALL_TIMEOUT_MS = 30_000

/**
 * 세션을 **되살릴 수 있는** 호출들은 예산이 다르다 (도그푸딩: "리소스 업로드" 세션 —
 * codex의 thread/resume은 자기 rollout 파일을 통째로 되읽어서, 550MB 스레드가 13.5초,
 * 더 큰 스레드는 25초를 넘겼다. 30초 기본값 아래서는 큰 스레드가 영영 못 깨어나는
 * 세션이 된다). 파일은 자라기만 하므로 상한은 크기에 비례해 커질 수 있는 값이어야
 * 한다 — 180초는 실측 비율(550MB≈13.5s)로 7GB급까지 덮는다. 매니저 쪽 단계 제한
 * (150초)이 이 안쪽에 있어서, 시간이 다해도 이름 붙은 이유가 화면에 온다.
 */
const LONG_CALL_TIMEOUT_MS = 180_000
const LONG_CALLS = new Set<string>([
  'agents.resumeSession', // 명시적 깨우기
  'agents.send', // 잠든 세션이면 되살린 뒤 보낸다 — 같은 비용을 문다
  'agents.createSession', // resumeExternalId로 이전 대화를 이어받을 때
  'agents.restartSession', // 프로세스를 갈아 끼우고 다시 되살린다
  'agents.exportHandoffRecord', // 수백 MB 롤아웃을 스캔할 수 있다 (#78)
])

export class RpcClient {
  private ws: RpcSocket | null = null
  private calls: RpcCalls
  private eventHandlers = new Set<(e: NormalizedEvent) => void>()
  private termHandlers = new Set<(e: { terminalId: string; data: string }) => void>()
  private termExitHandlers = new Set<(e: { terminalId: string; exitCode: number | null }) => void>()
  private connHandlers = new Set<(s: ConnectionState) => void>()
  private nextId = 1
  private lastSeq = 0
  private attempt = 0
  private closed = false
  private ready = false
  private streamEpoch: string | undefined
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly WS: new (url: string) => RpcSocket

  /**
   * host가 다시 뜨면 포트·토큰이 바뀐다 (수퍼바이저가 빈 포트를 새로 잡으므로).
   * 옛 주소로 계속 재시도하면 앱은 영영 '연결 끊김'에 머문다 — 실측으로 확인한 결함.
   */
  updateEndpoint(url: string, token: string): void {
    if (this.opts.url === url && this.opts.token === token) return
    this.opts = { ...this.opts, url, token }
    this.attempt = 0
    this.ready = false
    this.streamEpoch = undefined
    this.clearConnectionTimers()
    this.lastSeq = 0 // 새 host는 이벤트 번호를 처음부터 매긴다
    /*
     * **옛 소켓의 핸들러를 먼저 뗀다.** close()는 비동기라 onclose가 나중에 도는데,
     * 그대로 두면 그 onclose가 방금 만든 새 소켓 참조(this.ws)를 지우고 재연결을 하나 더
     * 잡는다 — 소켓 둘이 같은 이벤트를 받아 스트리밍 델타가 이중 적용됐다 (실측).
     */
    const old = this.ws
    if (old) {
      old.onopen = null
      old.onmessage = null
      old.onclose = null
      old.onerror = null
      old.close()
    }
    this.ws = null
    // 옛 host로 나간 RPC의 응답은 영영 오지 않는다 — 여기서 거절하지 않으면
    // 낙관적 UI가 확인을 기다리며 영원히 '작업 중'에 멈춘다 (onclose 핸들러는 방금 뗐다)
    this.calls.disconnect('Host restarted')
    this.connect()
  }

  constructor(private opts: RpcClientOptions) {
    this.WS = opts.WebSocketImpl ?? WebSocket
    this.calls = new RpcCalls(opts.maxPendingCalls ?? 256, opts.maxBufferedBytes ?? 32 * 1024 * 1024)
  }

  get connectionState(): ConnectionState {
    if (this.closed) return 'disconnected'
    return this.ready ? 'connected' : 'connecting'
  }

  connect(): void {
    if (this.closed) return
    // 이미 소켓이 있으면 만들지 않는다 — 백오프 타이머와 updateEndpoint가 겹치면 둘이 된다
    if (this.ws) return
    this.clearConnectionTimers()
    this.ready = false
    this.emitConn('connecting')
    const ws = new this.WS(this.opts.url)
    this.ws = ws
    this.handshakeTimer = setTimeout(() => ws.close(), this.opts.handshakeTimeoutMs ?? 10_000)

    ws.onopen = () => {
      if (this.ws !== ws) return
      ws.send(
        JSON.stringify({
          kind: 'hello',
          token: this.opts.token,
          protocolVersion: PROTOCOL_VERSION,
          ...(this.lastSeq > 0 ? { afterSeq: this.lastSeq } : {}),
          ...(this.streamEpoch ? { streamEpoch: this.streamEpoch } : {}),
        }),
      )

    }

    ws.onmessage = (e: MessageEvent) => {
      if (this.ws !== ws) return // 교체된 소켓의 잔류 프레임은 무시한다
      this.onFrame(String(e.data))
    }

    ws.onclose = () => {
      if (this.ws !== ws) return // 이미 교체됐다면 새 소켓을 건드리지 않는다
      this.ws = null
      this.ready = false
      this.clearConnectionTimers()
      if (this.closed) return
      /*
       * **보내고 답을 못 받은 RPC는 여기서 거절한다.** 조용히 두면 낙관적 UI가
       * 영원히 확인을 기다리고(세션이 '작업 중'에 멈춘다) pending이 무한히 자란다 —
       * 그 응답은 재연결해도 오지 않는다 (host는 요청을 받은 적이 없거나 이미 버렸다).
       * 아직 큐에만 있는(안 보낸) 호출은 그대로 둔다 — 재연결 후 전송이 기존 계약이다.
       */
      this.calls.disconnect('Connection lost')
      this.emitConn('disconnected')
      const delay = Math.min(this.opts.maxBackoffMs ?? 5000, 200 * 2 ** this.attempt++)
      this.reconnectTimer = setTimeout(() => this.connect(), delay)
    }

    ws.onerror = () => {
      /* onclose가 뒤따르므로 여기선 아무것도 안 한다 */
    }
  }

  private onFrame(raw: string): void {
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      return
    }
    const parsed = parseServerFrame(json)
    if (!parsed.success) return this.salvage(json) // 모르는 프레임은 무시 (전방 호환)
    const frame = parsed.data

    if (frame.kind === 'hello_ok') {
      if (this.ready) return
      if (frame.protocolVersion !== PROTOCOL_VERSION) { this.close(); return }
      const resync = frame.resyncRequired || this.lastSeq > frame.currentSeq ||
        (this.streamEpoch !== undefined && this.streamEpoch !== frame.streamEpoch)
      if (resync) this.lastSeq = frame.currentSeq
      this.streamEpoch = frame.streamEpoch
      this.ready = true
      this.attempt = 0
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = undefined
      this.flushCalls()
      this.emitConn(resync ? 'resync_required' : 'connected')
      return
    }
    if (!this.ready) return
    if (frame.kind === 'event') {
      if (frame.seq <= this.lastSeq) return
      this.lastSeq = frame.seq
      for (const h of this.eventHandlers) h(frame.event)
      return
    }
    // 터미널 출력은 seq를 갖지 않는다 (재전송 버퍼를 태우지 않는다 — envelope 참고)
    if (frame.kind === 'term') {
      for (const h of this.termHandlers) h({ terminalId: frame.terminalId, data: frame.data })
      return
    }
    if (frame.kind === 'term_exit') {
      for (const h of this.termExitHandlers) h({ terminalId: frame.terminalId, exitCode: frame.exitCode })
      return
    }
    if (frame.kind === 'res') {
      const p = this.calls.take(frame.id)
      if (!p) return
      if (frame.ok) p.resolve(frame.result)
      else p.reject(toError(frame.error))
    }
  }

  /**
   * 읽을 수 없는 프레임이 **기다리던 응답**이면 그래도 끝을 낸다 (도그푸딩 2026-09-10).
   *
   * 모르는 프레임을 무시하는 규칙은 전방 호환을 위한 것이고 거기까진 맞다. 그런데 그
   * 그물에 host의 **실패 응답**이 걸린 적이 있다: 봉투가 프로토콜에 없는 에러 코드
   * (`ENOENT`)를 달고 와 검사에서 떨어졌고, 프레임은 조용히 버려졌다. 부른 쪽에서 보면
   * 실패가 온 것이 아니라 **아무것도 안 온 것**이라, 그 화면은 30초 타임아웃까지
   * '불러오는 중'으로 서 있었다 (파일 링크가 빈 화면이 된 이유).
   *
   * host는 이제 아는 코드만 보낸다. 그래도 이 그물을 남긴다 — 버전이 어긋난 host,
   * 프록시가 건드린 봉투처럼 **읽을 수 없는 응답은 앞으로도 온다.** 그때 화면이
   * 멈추는 것보다 "못 읽었다"고 지금 말하는 편이 언제나 낫다.
   *
   * 성공 응답을 살려 쓰지는 않는다 — 검사에 떨어진 값을 결과인 척 넘기면 그 거짓말은
   * 화면 어딘가에서 다른 모습으로 터진다. 끝내되, 사실대로 끝낸다.
   */
  private salvage(json: unknown): void {
    const f = json as { kind?: unknown; id?: unknown; error?: { message?: unknown } }
    if (f?.kind !== 'res' || typeof f.id !== 'string') return
    const p = this.calls.take(f.id)
    if (!p) return
    const message = typeof f.error?.message === 'string' ? f.error.message : 'Malformed response from the host'
    p.reject(Object.assign(new Error(message), { code: 'internal', retryable: false }))
  }

  /**
   * RPC 한 번. **메서드 이름도 파라미터도 결과도 `RpcMethods`에서 나온다.**
   *
   * 예전 시그니처는 `call<T>(method: string, params: unknown)`이었다. 셋 다 검사되지
   * 않는다는 뜻이다: 이름은 오타가 나도 컴파일이 지나가고, 결과 타입은 검증이 아니라
   * **단언**이라 host가 다른 것을 줘도 TypeScript는 거짓말을 믿는다.
   *
   * 그 틈으로 실제로 두 번 샜다 — RPC가 effort를 삼킨 것, Codex 모델 shape을 잘못 짚은 것.
   * 둘 다 "스키마는 A라는데 손으로 쓴 통로는 B"였다. 통로를 손으로 쓰는 한
   * 다음 것도 같은 방식으로 샌다.
   *
   * 이제 `commands.ts`를 고치면 **컴파일러가 따라야 할 곳을 전부 알려준다.**
   */
  call<M extends RpcMethodName>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    if (this.closed) return Promise.reject(rpcError('Connection closed', 'connection_closed'))
    const id = String(this.nextId++)
    const frame = JSON.stringify({ kind: 'rpc', id, method, params })
    return new Promise<RpcResult<M>>((resolve, reject) => {
      const timeout = this.opts.callTimeoutMs ?? (LONG_CALLS.has(method) ? LONG_CALL_TIMEOUT_MS : DEFAULT_CALL_TIMEOUT_MS)
      this.calls.add(id, frame, timeout, method, resolve as (value: unknown) => void, reject)
      if (this.ready) this.flushCalls()
    })
  }

  private flushCalls(): void {
    const ws = this.ws
    if (!this.ready || !ws) return
    this.calls.send((frame, bytes) => {
      if (ws.bufferedAmount + bytes > (this.opts.maxBufferedBytes ?? 32 * 1024 * 1024)) {
        throw rpcError('Outbound buffer limit reached', 'overloaded', true)
      }
      try { ws.send(frame) } catch {
        ws.close()
        throw rpcError('Connection lost', 'connection_lost', true)
      }
    })
  }

  private clearConnectionTimers(): void {
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.handshakeTimer)
    this.reconnectTimer = undefined
    this.handshakeTimer = undefined
  }

  onEvent(handler: (e: NormalizedEvent) => void): Unsubscribe {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  onTerminalOutput(handler: (e: { terminalId: string; data: string }) => void): Unsubscribe {
    this.termHandlers.add(handler)
    return () => this.termHandlers.delete(handler)
  }

  onTerminalExit(handler: (e: { terminalId: string; exitCode: number | null }) => void): Unsubscribe {
    this.termExitHandlers.add(handler)
    return () => this.termExitHandlers.delete(handler)
  }

  onConnectionChange(handler: (s: ConnectionState) => void): Unsubscribe {
    this.connHandlers.add(handler)
    return () => this.connHandlers.delete(handler)
  }

  private emitConn(s: ConnectionState): void {
    for (const h of this.connHandlers) h(s)
  }

  close(): void {
    this.closed = true
    this.ready = false
    this.clearConnectionTimers()
    this.ws?.close()
    this.ws = null
    this.calls.close()
  }
}

function toError(e: ProtocolError): Error {
  return Object.assign(new Error(e.message), { code: e.code, retryable: e.retryable })
}
