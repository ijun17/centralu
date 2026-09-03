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
  /** RPC 한 번의 응답 제한 시간. host가 응답을 영영 안 주는 경우의 마지막 안전망 */
  callTimeoutMs?: number
}

/**
 * `sent`: 프레임이 실제로 소켓을 탔는가.
 * 끊길 때 **탄 것만** 거절한다 — 아직 큐에 있는 것은 재연결 후 전송되는 것이 기존 계약이다.
 */
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; sent: boolean }

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
])

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
  private queue: { id: string; frame: string }[] = []
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
    this.failInFlight('Host restarted')
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
    // 이미 소켓이 있으면 만들지 않는다 — 백오프 타이머와 updateEndpoint가 겹치면 둘이 된다
    if (this.ws) return
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
      for (const q of this.queue.splice(0)) {
        ws.send(q.frame)
        // 이제부터는 '보냈고 답을 기다리는' 호출이다 — 다음 끊김 때 거절 대상이 된다
        const p = this.pending.get(q.id)
        if (p) p.sent = true
      }
      this.emitConn('connected')
    }

    ws.onmessage = (e: MessageEvent) => {
      if (this.ws !== ws) return // 교체된 소켓의 잔류 프레임은 무시한다
      this.onFrame(String(e.data))
    }

    ws.onclose = () => {
      if (this.ws !== ws) return // 이미 교체됐다면 새 소켓을 건드리지 않는다
      this.ws = null
      if (this.closed) return
      /*
       * **보내고 답을 못 받은 RPC는 여기서 거절한다.** 조용히 두면 낙관적 UI가
       * 영원히 확인을 기다리고(세션이 '작업 중'에 멈춘다) pending이 무한히 자란다 —
       * 그 응답은 재연결해도 오지 않는다 (host는 요청을 받은 적이 없거나 이미 버렸다).
       * 아직 큐에만 있는(안 보낸) 호출은 그대로 둔다 — 재연결 후 전송이 기존 계약이다.
       */
      this.failInFlight('Connection lost')
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
      const p = this.take(frame.id)
      if (!p) return
      if (frame.ok) p.resolve(frame.result)
      else p.reject(toError(frame.error))
    }
  }

  /** pending에서 하나를 꺼낸다 — 타이머·큐 정리까지가 '꺼내기'다 (안 그러면 유령 타이머가 남는다) */
  private take(id: string): Pending | undefined {
    const p = this.pending.get(id)
    if (!p) return undefined
    this.pending.delete(id)
    clearTimeout(p.timer)
    this.queue = this.queue.filter((q) => q.id !== id)
    return p
  }

  /** 보냈는데 답을 못 받은 호출을 전부 거절한다 (재시도 가능 표시와 함께) */
  private failInFlight(reason: string): void {
    for (const [id, p] of [...this.pending]) {
      if (!p.sent) continue
      this.take(id)
      p.reject(Object.assign(new Error(reason), { code: 'connection_lost', retryable: true }))
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
      /*
       * 제한 시간 안전망. 끊김은 onclose가 잡지만, 소켓은 멀쩡한데 host가 응답을
       * 삼키는 경우(핸들러 버그·행)에는 아무도 거절해 주지 않는다 — 그때 pending이
       * 무한히 자라고 그 호출의 UI는 영원히 기다린다. 큐에서 못 나간 호출도 여기서 정리된다.
       */
      const timer = setTimeout(() => {
        if (!this.take(id)) return
        reject(Object.assign(new Error(`RPC timed out: ${method}`), { code: 'timeout', retryable: true }))
      }, this.opts.callTimeoutMs ?? (LONG_CALLS.has(method) ? LONG_CALL_TIMEOUT_MS : DEFAULT_CALL_TIMEOUT_MS))
      const sent = this.ws?.readyState === 1
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, sent })
      if (sent) this.ws!.send(frame)
      else this.queue.push({ id, frame }) // 재연결 후 전송
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
    for (const [, p] of this.pending) {
      clearTimeout(p.timer) // 타이머를 안 지우면 닫힌 클라이언트가 프로세스를 물고 있는다
      p.reject(new Error('Connection closed'))
    }
    this.pending.clear()
    this.queue = []
  }
}

function toError(e: ProtocolError): Error {
  return Object.assign(new Error(e.message), { code: e.code, retryable: e.retryable })
}
