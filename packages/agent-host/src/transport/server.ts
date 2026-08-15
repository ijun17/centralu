import { WebSocketServer, type WebSocket } from 'ws'
import { createServer, type Server } from 'node:http'
import {
  PROTOCOL_VERSION,
  type NormalizedEvent,
  type ProtocolError,
  parseClientFrame,
} from '@cc/protocol'
import { EventLog } from './event-log.js'

/**
 * WS 서버 (docs/protocol.md §1). dev/prod 동일 — Tauri는 이 프로세스를 spawn만 한다.
 * 보안: loopback 바인딩 + 기동 시 생성한 토큰 핸드셰이크.
 */
export type RpcHandler = (method: string, params: unknown) => Promise<unknown>

export type HostServerOptions = {
  port: number
  token: string
  onRpc: RpcHandler
  /** 정적 페이지 서빙 (dev에서 브라우저 접속용, 선택) */
  onHttp?: (path: string) => { body: string | Buffer; contentType: string } | null
}

export class HostServer {
  readonly log = new EventLog()
  private wss: WebSocketServer
  private http: Server
  private clients = new Set<WebSocket>()
  private listenError: ((err: Error) => void) | null = null

  constructor(private opts: HostServerOptions) {
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
    this.wss = new WebSocketServer({ server: this.http })
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
              `포트 ${this.opts.port}이 이미 사용 중입니다.\n` +
                `  · 이미 host가 떠 있다면 그대로 쓰면 됩니다 (UI만 실행하세요)\n` +
                `  · 남은 프로세스를 정리하려면: lsof -ti:${this.opts.port} | xargs kill\n` +
                `  · 다른 포트로 띄우려면: pnpm host --port ${this.opts.port + 1}`,
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
    for (const c of this.clients) c.close()
    await new Promise<void>((r) => this.wss.close(() => r()))
    await new Promise<void>((r) => this.http.close(() => r()))
  }

  /** 이벤트 방송 — seq를 부여해 링 버퍼에 남기고 연결된 클라이언트에 push */
  broadcast(event: NormalizedEvent): void {
    const entry = this.log.append(event)
    const frame = JSON.stringify({ kind: 'event', seq: entry.seq, event })
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(frame)
  }

  private onConnection(ws: WebSocket): void {
    let authed = false

    ws.on('message', async (raw) => {
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(String(raw))
      } catch {
        return this.sendError(ws, null, { code: 'internal', message: '잘못된 JSON', retryable: false })
      }
      const frame = parseClientFrame(parsedJson)
      if (!frame.success) {
        return this.sendError(ws, null, { code: 'internal', message: '알 수 없는 프레임', retryable: false })
      }

      if (frame.data.kind === 'hello') {
        if (frame.data.token !== this.opts.token) {
          ws.close(4001, 'bad token')
          return
        }
        if (frame.data.protocolVersion !== PROTOCOL_VERSION) {
          this.sendError(ws, null, {
            code: 'version_mismatch',
            message: `프로토콜 버전 불일치 (서버 ${PROTOCOL_VERSION}, 클라이언트 ${frame.data.protocolVersion})`,
            retryable: false,
          })
          ws.close(4002, 'version mismatch')
          return
        }
        authed = true
        this.clients.add(ws)

        const { events, resyncRequired } = this.log.since(frame.data.afterSeq ?? 0)
        ws.send(
          JSON.stringify({
            kind: 'hello_ok',
            protocolVersion: PROTOCOL_VERSION,
            resyncRequired,
            currentSeq: this.log.currentSeq,
          }),
        )
        // 유실분 재전송 — 재연결이 상태 유실이 되지 않게 (docs/protocol.md §1)
        for (const e of events) ws.send(JSON.stringify({ kind: 'event', seq: e.seq, event: e.event }))
        return
      }

      if (!authed) {
        ws.close(4001, 'not authed')
        return
      }

      // RPC
      try {
        const result = await this.opts.onRpc(frame.data.method, frame.data.params)
        ws.send(JSON.stringify({ kind: 'res', id: frame.data.id, ok: true, result }))
      } catch (err) {
        const e = err as Error & { code?: ProtocolError['code'] }
        this.sendError(ws, frame.data.id, {
          code: e.code ?? 'internal',
          message: e.message ?? '알 수 없는 오류',
          retryable: false,
        })
      }
    })

    ws.on('close', () => this.clients.delete(ws))
    ws.on('error', () => this.clients.delete(ws))
  }

  private sendError(ws: WebSocket, id: string | null, error: ProtocolError): void {
    if (ws.readyState !== ws.OPEN) return
    ws.send(JSON.stringify({ kind: 'res', id: id ?? '0', ok: false, error }))
  }
}
