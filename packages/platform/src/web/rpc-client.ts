import {
  PROTOCOL_VERSION,
  parseServerFrame,
  type NormalizedEvent,
  type ProtocolError,
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
  private connHandlers = new Set<(s: ConnectionState) => void>()
  private nextId = 1
  private lastSeq = 0
  private attempt = 0
  private closed = false
  private queue: string[] = []
  private readonly WS: typeof WebSocket

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
    if (frame.kind === 'res') {
      const p = this.pending.get(frame.id)
      if (!p) return
      this.pending.delete(frame.id)
      if (frame.ok) p.resolve(frame.result)
      else p.reject(toError(frame.error))
    }
  }

  call<T>(method: string, params: unknown): Promise<T> {
    const id = String(this.nextId++)
    const frame = JSON.stringify({ kind: 'rpc', id, method, params })
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      if (this.ws?.readyState === 1) this.ws.send(frame)
      else this.queue.push(frame) // 재연결 후 전송
    })
  }

  onEvent(handler: (e: NormalizedEvent) => void): Unsubscribe {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
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
    for (const [, p] of this.pending) p.reject(new Error('연결이 종료되었습니다'))
    this.pending.clear()
  }
}

function toError(e: ProtocolError): Error {
  return Object.assign(new Error(e.message), { code: e.code, retryable: e.retryable })
}
