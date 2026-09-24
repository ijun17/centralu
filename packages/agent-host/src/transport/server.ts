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

/**
 * `CC_HOST_ALLOWED_ORIGINS` (쉼표 구분) → allowedOrigins 오버라이드.
 *
 * 기본 목록은 우리가 아는 dev 포트와 Tauri WebView뿐이다. 그 밖의 주소에서 붙어야 할 때
 * — 다른 포트로 vite를 띄웠거나, 리버스 프록시 뒤에서 열어봤거나 — 지금까지는 host를
 * 고쳐 다시 빌드하는 것 말고 방법이 없었다. 게다가 막혔다는 사실이 화면에는
 * `Disconnected`로만 보여서, 탈출구가 없다는 것조차 알기 어려웠다.
 *
 * **빈 값은 오버라이드가 아니라 "설정 안 함"이다.** 빈 문자열이나 쉼표뿐인 값을 그대로
 * 통과시키면 허용목록이 공집합인 host가 되어 아무도 못 붙는다 — 오타 하나의 대가로는
 * 너무 크고, 환경변수가 실수로 비는 일은 흔하다. 항목별 공백도 같은 이유로 버린다:
 * 빈 문자열은 originAllowed에서 "Origin 헤더 없음"과 같은 뜻이라 목록에 있으면 안 된다.
 */
export function parseAllowedOrigins(raw: string | undefined): string[] | undefined {
  const parsed = raw
    ?.split(',')
    .map((o) => o.trim())
    .filter((o) => o !== '')
  return parsed?.length ? parsed : undefined
}

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
  /**
   * 이미 적어 준 거부 origin — 같은 문장을 5초마다 반복하지 않으려고 (아래 verifyClient).
   *
   * **상한이 있다.** 이 집합의 열쇠는 요청이 보낸 Origin 헤더, 즉 바깥에서 고르는 값이다.
   * 무한히 담으면 loopback에 붙을 수 있는 쪽이 매번 다른 Origin으로 두드려 host의 메모리를
   * 늘릴 수 있다 — 토큰도 필요 없다(같은 자리에서 종료 멈춤도 그랬다). 서로 다른 origin이
   * 64개를 넘길 만큼 나올 일은 정상 사용에서는 없으므로, 넘으면 비우고 다시 센다.
   * 잃는 것은 "이 origin은 이미 적었다"는 기억뿐이라 최악이 로그 한 줄 더 남는 것이다.
   */
  private readonly loggedRejections = new Set<string>()
  private static readonly MAX_LOGGED_REJECTIONS = 64

  constructor(private opts: HostServerOptions) {
    /*
     * 공백뿐인 토큰은 **자격증명이 아니다** — 브라우저가 이미 그렇게 판정한다.
     *
     * apps/web/src/bootstrap.ts의 browserHostOptions는 VITE_HOST_TOKEN을 trim한 뒤
     * 비면 MissingHostTokenError를 던진다. 여기서 trim 없이 `!opts.token`만 보면
     * `CC_HOST_TOKEN=" "` 하나로 양쪽 판정이 갈린다: host는 " "를 정상 토큰으로 받아
     * 몇 번만 찍어보면 맞는 비밀로 돌고, UI는 ''를 보내므로 아예 붙지 못한다.
     * 실제로 재현했다 — host는 listen까지 갔고, UI는 MissingHostTokenError를 던졌다.
     * 두 쪽이 같은 규칙을 쓰게 맞춘다.
     */
    if (!opts.token.trim()) throw Object.assign(new Error('Host token must not be empty'), { code: 'internal' })
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
        const origin = info.req.headers.origin
        const ok = this.originAllowed(origin)
        /*
         * 거부를 **적는다**. 브라우저는 업그레이드 403을 페이지 스크립트에 넘겨주지
         * 않으므로 화면에는 그냥 `Disconnected`가 뜨고 재시도만 돈다 — "host가 꺼져
         * 있다"와 구별이 안 된다. host 로그에도 아무것도 없으면 어디서 막혔는지
         * 알아낼 방법이 사람에게 남지 않는다. 거부당한 origin을 그대로 찍어야
         * CC_HOST_ALLOWED_ORIGINS에 무엇을 넣어야 하는지가 그 한 줄에서 나온다.
         *
         * **origin당 한 번만 적는다.** 막힌 UI는 포기하지 않는다 — rpc-client의 백오프는
         * 5초에서 멈추므로(web/rpc-client.ts) 계속 켜 두면 똑같은 문장이 시간당 700줄
         * 넘게 쌓인다. 버그 신고에 붙이라고 안내하는 바로 그 host.log다. 두 번째 줄부터는
         * 새로 알려주는 것이 없으니 첫 줄만 남긴다.
         */
        if (!ok) {
          const key = origin ?? ''
          if (!this.loggedRejections.has(key)) {
            if (this.loggedRejections.size >= HostServer.MAX_LOGGED_REJECTIONS) this.loggedRejections.clear()
            this.loggedRejections.add(key)
            console.error(
              `[agent-host] origin rejected: ${origin ?? '(none)'} — ` +
                `allowed: ${[...this.allowedOrigins].join(', ')}. ` +
                `To add one: CC_HOST_ALLOWED_ORIGINS='${origin ?? ''}'`,
            )
          }
        }
        done(ok, 403, 'forbidden origin')
      },
    })
    this.wss.on('connection', (ws) => this.onConnection(ws))
    // ws는 http 서버 에러를 자기 인스턴스로 재방출한다 — 여기서 안 받으면 프로세스가 죽는다
    this.wss.on('error', (err) => this.listenError?.(err))
  }

  /**
   * origin 경계 (docs/security-boundaries.md).
   *
   * **Origin이 없거나 빈 것을 통과시키는 것은 실수가 아니라 결정이다.** 브라우저는
   * 교차 출처 요청에 Origin을 반드시 붙이므로, 헤더가 아예 없는 연결은 브라우저가
   * 아니다 — 네이티브 클라이언트(Tauri WebView가 아닌 경로, 테스트의 ws 클라이언트,
   * curl)다. 그런 쪽은 origin으로 막을 수 있는 대상이 아니고, 어차피 loopback
   * 바인딩 + 토큰 핸드셰이크가 막는다. 여기서 없는 Origin을 거부하면 막히는 것은
   * 공격자가 아니라 우리 자신의 테스트와 사이드카뿐이다.
   *
   * 반면 문자열 `'null'`은 **있는 Origin이다.** sandbox iframe이나 file:// 페이지가
   * 실제로 보내는 값이라 없는 것과 같이 취급하면 안 된다 — 그래서 명시적으로 막는다.
   * server.test.ts가 origin 10종을 찌른다 — 허용목록 7개 전부, Origin 없음,
   * `http://evil.example`, 문자열 `'null'`. 동작은 문서와 일치한다.
   */
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

  /**
   * 닫기.
   *
   * **`this.clients`가 아니라 `wss.clients`를 순회한다.** 앞의 집합은 hello를 통과한
   * 소켓만 담는다 — 방송 대상이라서 그렇다. 그런데 업그레이드는 됐지만 아직 인증 전인
   * 소켓도 http 서버 입장에서는 살아 있는 연결이라, 안 닫으면 `http.close()`의 콜백이
   * 영영 안 온다.
   *
   * 테스트 얘기가 아니다 — 실측했다. 붙기만 하고 hello를 안 보낸 소켓 **하나**가 있을 때
   * `this.clients`판 close()는 5초를 기다려도 안 끝났고(그대로 두면 영영), `wss.clients`판은
   * 2ms에 끝났다. 즉 host 종료를 막는 데 인증도 필요 없다. 같은 것이 테스트에서는 훅
   * 타임아웃으로 나타난다: origin 검사를 일부러 무력화해 두 소켓을 열린 채로 남기면
   * `afterEach`가 각각 10초씩 걸려 파일이 644ms에서 20.54s가 됐고, 이 줄을 고치자
   * 같은 조건에서 617ms로 돌아왔다.
   */
  async close(): Promise<void> {
    for (const c of this.wss.clients) c.close()
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
