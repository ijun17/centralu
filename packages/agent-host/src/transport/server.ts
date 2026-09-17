import { createServer, type Server } from 'node:http'
import { WebSocketServer, type WebSocket } from 'ws'
import { PROTOCOL_VERSION, ProtocolErrorCode, type NormalizedEvent, type ProtocolError, parseClientFrame } from '@cc/protocol'
import { EventLog } from './event-log.js'

/**
 * WS 서버 (docs/protocol.md §1). dev/prod 동일 — Tauri는 이 프로세스를 spawn만 한다.
 * 보안: loopback 바인딩 + 기동 시 생성한 토큰 핸드셰이크.
 */
export type { HostServerOptions, RpcHandler } from './server-types.js'
import { DEFAULT_LIMITS, rawText, type HostServerOptions, type SocketState } from './server-types.js'

export class HostServer {
  readonly log = new EventLog()
  readonly streamEpoch = this.log.streamEpoch
  private readonly wss: WebSocketServer
  private readonly http: Server
  private readonly clients = new Set<WebSocket>()
  private readonly sockets = new Map<WebSocket, SocketState>()
  private listenError: ((err: Error) => void) | null = null
  private closePromise: Promise<void> | null = null

  constructor(private readonly opts: HostServerOptions) {
    this.http = createServer((req, res) => {
      const hit = opts.onHttp?.(new URL(req.url ?? '/', 'http://x').pathname)
      if (!hit) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      res.writeHead(200, { 'content-type': hit.contentType })
      res.end(hit.body)
    })
    this.wss = new WebSocketServer({ server: this.http, maxPayload: opts.maxPayloadBytes ?? DEFAULT_LIMITS.maxPayloadBytes })
    this.wss.on('connection', (ws) => this.onConnection(ws))
    // ws는 http 서버 에러를 자기 인스턴스로 재방출한다 — 여기서 안 받으면 프로세스가 죽는다
    this.wss.on('error', (err) => this.listenError?.(err))
  }

  listen(): Promise<number> {
    return new Promise((resolve, reject) => {
      const onError = (err: NodeJS.ErrnoException) => {
        this.listenError = null
        if (err.code === 'EADDRINUSE') {
          reject(
            new Error(
              `Port ${this.opts.port} is already in use.\n` +
                `  · If a host is already running, just use it (start only the UI)\n` +
                `  · To clean up a leftover process: lsof -ti:${this.opts.port} | xargs kill\n` +
                `  · To use another port: pnpm host --port ${this.opts.port + 1}`,
            ),
          )
          return
        }
        reject(err)
      }
      // http와 ws 양쪽에서 올 수 있다 (ws가 http 에러를 재방출)
      this.listenError = onError
      this.http.once('error', onError)
      this.http.listen(this.opts.port, '127.0.0.1', () => {
        this.listenError = null
        this.http.removeListener('error', onError)
        const addr = this.http.address()
        resolve(typeof addr === 'object' && addr ? addr.port : this.opts.port)
      })
    })
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise
    this.closePromise = this.closeOnce()
    return this.closePromise
  }

  /** 이벤트 방송 — seq를 부여해 링 버퍼에 남기고 연결된 클라이언트에 push */
  broadcast(event: NormalizedEvent): void {
    const entry = this.log.append(event)
    const frame = JSON.stringify({ kind: 'event', seq: entry.seq, event })
    for (const ws of this.clients) this.sendIfReady(ws, frame)
  }

  /**
   * 터미널 출력 push.
   * 이벤트 로그(seq 링 버퍼)를 태우지 않는다 — 출력량이 대화 이벤트와 자릿수가 다르고,
   * 놓친 부분은 다시 붙을 때 host의 스크롤백에서 통째로 받는다.
   */
  pushTerminal(frame: { readonly terminalId: string; readonly data?: string; readonly exitCode?: number | null }): void {
    const payload =
      frame.data !== undefined
        ? { kind: 'term', terminalId: frame.terminalId, data: frame.data }
        : { kind: 'term_exit', terminalId: frame.terminalId, exitCode: frame.exitCode ?? null }
    const json = JSON.stringify(payload)
    for (const ws of this.clients) this.sendIfReady(ws, json)
  }

  private async closeOnce(): Promise<void> {
    const httpClosed = new Promise<void>((resolve) => this.http.close(() => resolve()))
    this.http.closeAllConnections()
    for (const state of this.sockets.values()) {
      clearTimeout(state.handshakeTimer)
      state.closed = true
    }
    for (const ws of this.wss.clients) ws.terminate()
    await new Promise<void>((resolve) => this.wss.close(() => resolve()))
    await httpClosed
    this.clients.clear()
    this.sockets.clear()
  }

  private onConnection(ws: WebSocket): void {
    if (this.sockets.size >= (this.opts.maxSockets ?? DEFAULT_LIMITS.maxSockets)) {
      this.closeSocket(ws, 1013, 'socket limit')
      return
    }
    const state: SocketState = {
      authed: false,
      closed: false,
      inFlight: 0,
      handshakeTimer: setTimeout(() => this.closeSocket(ws, 4001, 'auth timeout'), this.opts.handshakeTimeoutMs ?? DEFAULT_LIMITS.handshakeTimeoutMs),
    }
    this.sockets.set(ws, state)

    ws.on('message', (raw) => {
      void this.onMessage(ws, raw)
    })
    ws.on('close', () => this.forgetSocket(ws))
    ws.on('error', () => this.forgetSocket(ws))
  }

  private async onMessage(ws: WebSocket, raw: string | Buffer | ArrayBuffer | Buffer[]): Promise<void> {
    const state = this.sockets.get(ws)
    if (!state || state.closed) return
    const rawTextValue = rawText(raw)
    if (Buffer.byteLength(rawTextValue) > (this.opts.maxPayloadBytes ?? DEFAULT_LIMITS.maxPayloadBytes)) {
      this.closeSocket(ws, 1009, 'message too large')
      return
    }

    let parsedJson: unknown
    try {
      parsedJson = JSON.parse(rawTextValue)
    } catch {
      this.sendError(ws, null, { code: 'internal', message: 'Malformed JSON', retryable: false })
      return
    }
    const frame = parseClientFrame(parsedJson)
    if (!frame.success) {
      this.sendError(ws, null, { code: 'internal', message: 'Unknown frame', retryable: false })
      return
    }

    if (frame.data.kind === 'hello') {
      this.handleHello(ws, state, frame.data.token, frame.data.protocolVersion, frame.data.afterSeq ?? 0, frame.data.streamEpoch)
      return
    }

    if (!state.authed) {
      this.closeSocket(ws, 4001, 'not authed')
      return
    }

    const maxInFlight = this.opts.maxRpcInFlightPerSocket ?? DEFAULT_LIMITS.maxRpcInFlightPerSocket
    if (state.inFlight >= maxInFlight) {
      this.sendError(ws, frame.data.id, { code: 'internal', message: 'Too many in-flight RPCs', retryable: true })
      return
    }
    state.inFlight += 1
    try {
      const result = await this.opts.onRpc(frame.data.method, frame.data.params)
      this.sendIfReady(ws, JSON.stringify({ kind: 'res', id: frame.data.id, ok: true, result }))
    } catch (err) {
      const e = err as Error & { code?: unknown }
      this.sendError(ws, frame.data.id, {
        code: errorCode(e?.code),
        message: e?.message ?? 'Unknown error',
        retryable: false,
      })
    } finally {
      state.inFlight -= 1
    }
  }

  private handleHello(ws: WebSocket, state: SocketState, token: string, protocolVersion: number, afterSeq: number, streamEpoch?: string): void {
    if (state.authed) {
      this.sendIfReady(ws, this.helloFrame(false))
      return
    }
    if (token !== this.opts.token) {
      this.closeSocket(ws, 4001, 'bad token')
      return
    }
    if (protocolVersion !== PROTOCOL_VERSION) {
      this.sendError(ws, null, {
        code: 'version_mismatch',
        message: `Protocol version mismatch (server ${PROTOCOL_VERSION}, client ${protocolVersion})`,
        retryable: false,
      })
      this.closeSocket(ws, 4002, 'version mismatch')
      return
    }
    state.authed = true
    clearTimeout(state.handshakeTimer)
    this.clients.add(ws)

    // A numeric cursor is meaningful only within the lifetime that issued it.
    // Legacy clients may omit an epoch, but must snapshot instead of cross-lifetime replay.
    const epochMismatch = (afterSeq > 0 || streamEpoch !== undefined) && streamEpoch !== this.streamEpoch
    const replay = epochMismatch ? { events: [], resyncRequired: true } : this.log.since(afterSeq)
    const hello = this.helloFrame(replay.resyncRequired)
    const frames: string[] = []
    const limit = this.opts.maxBufferedBytes ?? DEFAULT_LIMITS.maxBufferedBytes
    // Reserve the whole burst, including maximum unmasked WS headers. Relying on
    // bufferedAmount alone makes replay success depend on how quickly TCP drains.
    let bytes = ws.bufferedAmount + Buffer.byteLength(hello) + 10
    for (const entry of replay.events) {
      const frame = JSON.stringify({ kind: 'event', seq: entry.seq, event: entry.event })
      bytes += Buffer.byteLength(frame) + 10
      if (bytes > limit) {
        // Never acknowledge replay and then close halfway through: the unchanged
        // cursor would reconnect into the same oversized window forever.
        this.sendIfReady(ws, this.helloFrame(true))
        return
      }
      frames.push(frame)
    }
    if (!this.sendIfReady(ws, hello)) return
    for (const frame of frames) if (!this.sendIfReady(ws, frame)) return
  }

  private helloFrame(resyncRequired: boolean): string {
    return JSON.stringify({
      kind: 'hello_ok', protocolVersion: PROTOCOL_VERSION, resyncRequired,
      currentSeq: this.log.currentSeq, streamEpoch: this.streamEpoch,
    })
  }

  private sendIfReady(ws: WebSocket, frame: string): boolean {
    if (ws.readyState !== ws.OPEN) return false
    if (ws.bufferedAmount + Buffer.byteLength(frame) > (this.opts.maxBufferedBytes ?? DEFAULT_LIMITS.maxBufferedBytes)) {
      this.closeSocket(ws, 1013, 'outbound buffer limit')
      return false
    }
    ws.send(frame, (error) => {
      if (error) this.closeSocket(ws, 1011, 'send failed')
    })
    return true
  }

  private sendError(ws: WebSocket, id: string | null, error: ProtocolError): void {
    this.sendIfReady(ws, JSON.stringify({ kind: 'res', id: id ?? '0', ok: false, error }))
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    const state = this.sockets.get(ws)
    if (state?.closed) return
    if (state) {
      state.closed = true
      clearTimeout(state.handshakeTimer)
    }
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      ws.close(code, reason)
      const deadline = setTimeout(() => ws.terminate(), 1000)
      deadline.unref()
      ws.once('close', () => clearTimeout(deadline))
    }
  }

  private forgetSocket(ws: WebSocket): void {
    const state = this.sockets.get(ws)
    if (state) clearTimeout(state.handshakeTimer)
    this.clients.delete(ws)
    this.sockets.delete(ws)
  }
}


/**
 * 프로토콜이 아는 코드만 나간다 (도그푸딩 2026-09-10).
 *
 * 여기 던져지는 실패의 대부분은 **Node의 실패**다 — `fs.stat`은 `code: 'ENOENT'`를,
 * `spawn`은 `'EACCES'`를 달고 온다. 그 글자를 그대로 봉투에 실으면 프로토콜 enum에 없는
 * 값이라 **클라이언트가 프레임을 통째로 버린다**: 실패가 실패로 도착하는 게 아니라
 * 아예 도착하지 않고, 그 호출을 기다리던 화면은 30초 타임아웃까지 '불러오는 중'에
 * 멈춰 있었다 (파일 링크가 빈 화면으로 보인 이유가 이것이다).
 *
 * 그래서 모르는 코드는 `internal`로 갈아 끼운다. **설명은 message가 그대로 나른다** —
 * 사람이 읽는 문장에서 'ENOENT'는 사라지지 않는다.
 */
function errorCode(raw: unknown): ProtocolError['code'] {
  const known = ProtocolErrorCode.safeParse(raw)
  return known.success ? known.data : 'internal'
}
