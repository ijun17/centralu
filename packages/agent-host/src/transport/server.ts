import { WebSocketServer, type WebSocket } from 'ws'
import { createServer, type Server } from 'node:http'
import {
  PROTOCOL_VERSION,
  ProtocolErrorCode,
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

export const DEFAULT_ALLOWED_ORIGINS = [
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://tauri.localhost',
  'https://tauri.localhost',
  'tauri://localhost',
] as const

export type HostServerOptions = {
  port: number
  token: string
  onRpc: RpcHandler
  allowedOrigins?: readonly string[]
  /** 정적 페이지 서빙 (dev에서 브라우저 접속용, 선택) */
  onHttp?: (path: string) => { body: string | Buffer; contentType: string } | null
}

export class HostServer {
  readonly log = new EventLog()
  private wss: WebSocketServer
  private http: Server
  private clients = new Set<WebSocket>()
  private listenError: ((err: Error) => void) | null = null
  private readonly allowedOrigins: ReadonlySet<string>

  constructor(private opts: HostServerOptions) {
    if (!opts.token) throw Object.assign(new Error('Host token must not be empty'), { code: 'internal' })
    this.allowedOrigins = new Set(opts.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS)
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
    this.wss = new WebSocketServer({
      server: this.http,
      verifyClient: (info, done) => {
        done(this.originAllowed(info.req.headers.origin), 403, 'forbidden origin')
      },
    })
    this.wss.on('connection', (ws) => this.onConnection(ws))
    // ws는 http 서버 에러를 자기 인스턴스로 재방출한다 — 여기서 안 받으면 프로세스가 죽는다
    this.wss.on('error', (err) => this.listenError?.(err))
  }

  private originAllowed(origin: string | undefined): boolean {
    if (origin === undefined || origin === '') return true
    if (origin === 'null') return false
    return this.allowedOrigins.has(origin)
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

  /**
   * 터미널 출력 push.
   * 이벤트 로그(seq 링 버퍼)를 태우지 않는다 — 출력량이 대화 이벤트와 자릿수가 다르고,
   * 놓친 부분은 다시 붙을 때 host의 스크롤백에서 통째로 받는다.
   */
  pushTerminal(frame: { terminalId: string; data?: string; exitCode?: number | null }): void {
    const payload =
      frame.data !== undefined
        ? { kind: 'term', terminalId: frame.terminalId, data: frame.data }
        : { kind: 'term_exit', terminalId: frame.terminalId, exitCode: frame.exitCode ?? null }
    const json = JSON.stringify(payload)
    for (const ws of this.clients) if (ws.readyState === ws.OPEN) ws.send(json)
  }

  private onConnection(ws: WebSocket): void {
    let authed = false

    ws.on('message', async (raw) => {
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(String(raw))
      } catch {
        return this.sendError(ws, null, { code: 'internal', message: 'Malformed JSON', retryable: false })
      }
      const frame = parseClientFrame(parsedJson)
      if (!frame.success) {
        return this.sendError(ws, null, { code: 'internal', message: 'Unknown frame', retryable: false })
      }

      if (frame.data.kind === 'hello') {
        if (frame.data.token !== this.opts.token) {
          ws.close(4001, 'bad token')
          return
        }
        if (frame.data.protocolVersion !== PROTOCOL_VERSION) {
          this.sendError(ws, null, {
            code: 'version_mismatch',
            message: `Protocol version mismatch (server ${PROTOCOL_VERSION}, client ${frame.data.protocolVersion})`,
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
        const e = err as Error & { code?: unknown }
        this.sendError(ws, frame.data.id, {
          code: errorCode(e.code),
          message: e.message ?? 'Unknown error',
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
