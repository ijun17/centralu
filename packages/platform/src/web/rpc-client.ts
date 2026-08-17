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

/**
 * WS RPC 클라이언트 — 재연결 + 백오프 + afterSeq 복원 (tech-stack.md: 자작 ~50줄).
 * 이 파일이 ui가 WebSocket을 직접 몰라도 되게 하는 유일한 지점이다.
 */
export type RpcClientOptions = {
  url: string
  token: string
  /** 테스트 주입용 */
  WebSocketImpl?: typeof WebSocket
  maxBackoffMs?: number
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class RpcClient {
  private ws: WebSocket | null = null
  private pending = new Map<string, Pending>()
  private eventHandlers = new Set<(e: NormalizedEvent) => void>()
  private termHandlers = new Set<(e: { terminalId: string; data: string }) => void>()
  private termExitHandlers = new Set<(e: { terminalId: string; exitCode: number | null }) => void>()
  private connHandlers = new Set<(s: ConnectionState) => void>()
  private nextId = 1
  private lastSeq = 0
  private attempt = 0
  private closed = false
  private queue: string[] = []
  private readonly WS: typeof WebSocket

  /**
   * host가 다시 뜨면 포트·토큰이 바뀐다 (수퍼바이저가 빈 포트를 새로 잡으므로).
   * 옛 주소로 계속 재시도하면 앱은 영영 '연결 끊김'에 머문다 — 실측으로 확인한 결함.
   */
  updateEndpoint(url: string, token: string): void {
    if (this.opts.url === url && this.opts.token === token) return
    this.opts = { ...this.opts, url, token }
    this.attempt = 0
    this.lastSeq = 0 // 새 host는 이벤트 번호를 처음부터 매긴다
    this.ws?.close()
    this.ws = null
    this.connect()
  }

  constructor(private opts: RpcClientOptions) {
    this.WS = opts.WebSocketImpl ?? WebSocket
  }

  get connectionState(): ConnectionState {
    if (this.closed) return 'disconnected'
    return this.ws?.readyState === 1 ? 'connected' : 'connecting'
  }

  connect(): void {
    if (this.closed) return
    this.emitConn('connecting')
    const ws = new this.WS(this.opts.url)
    this.ws = ws

    ws.onopen = () => {
      this.attempt = 0
      ws.send(
        JSON.stringify({
          kind: 'hello',
          token: this.opts.token,
          protocolVersion: PROTOCOL_VERSION,
          ...(this.lastSeq > 0 ? { afterSeq: this.lastSeq } : {}),
        }),
      )
      for (const q of this.queue.splice(0)) ws.send(q)
      this.emitConn('connected')
    }

    ws.onmessage = (e: MessageEvent) => this.onFrame(String(e.data))

    ws.onclose = () => {
      this.ws = null
      if (this.closed) return
      this.emitConn('disconnected')
      const delay = Math.min(this.opts.maxBackoffMs ?? 5000, 200 * 2 ** this.attempt++)
      setTimeout(() => this.connect(), delay)
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
    if (!parsed.success) return // 모르는 프레임은 무시 (전방 호환)
    const frame = parsed.data

    if ('kind' in frame && frame.kind === 'hello_ok') {
      if (frame.resyncRequired) this.emitConn('resync_required')
      return
    }
    if (frame.kind === 'event') {
      this.lastSeq = Math.max(this.lastSeq, frame.seq)
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
      const p = this.pending.get(frame.id)
      if (!p) return
      this.pending.delete(frame.id)
      if (frame.ok) p.resolve(frame.result)
      else p.reject(toError(frame.error))
    }
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
    const id = String(this.nextId++)
    const frame = JSON.stringify({ kind: 'rpc', id, method, params })
    return new Promise<RpcResult<M>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      if (this.ws?.readyState === 1) this.ws.send(frame)
      else this.queue.push(frame) // 재연결 후 전송
    })
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
    this.ws?.close()
    this.ws = null
    for (const [, p] of this.pending) p.reject(new Error('Connection closed'))
    this.pending.clear()
  }
}

function toError(e: ProtocolError): Error {
  return Object.assign(new Error(e.message), { code: e.code, retryable: e.retryable })
}
