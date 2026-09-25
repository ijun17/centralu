import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders, RequestListener } from 'node:http'

/**
 * host의 HTTP 길 (M4 P-2).
 *
 * 전에는 경로 하나만 받는 동기 훅(`onHttp(path)`)이 **인증 없이** WebSocket과 같은 포트에
 * 열려 있었다. 쓰는 곳이 없어서 문제가 드러나지 않았을 뿐이다. 앱 화면(샌드박스 프록시)이
 * 이 포트로 서빙되기 시작하면 이 길은 루프백에 붙을 수 있는 누구에게나 열린다. 같은 기계의
 * 다른 프로그램, 그리고 브라우저로 여는 아무 웹 페이지도 `http://127.0.0.1:<포트>`를 부를 수 있다.
 *
 * 그래서 규칙은 하나다. **모든 길은 비밀 칸 뒤에 있다.** 경로의 첫 칸이 실행마다 새로 만든
 * 비밀값과 같아야 그다음 칸부터 길을 찾는다. 공개 길은 두지 않는다. 비밀이 없거나 틀리면
 * 길이 없는 것과 **똑같은** 404가 나간다(상태·본문·헤더 모두). 비밀이 틀렸다는 사실조차 알려
 * 주지 않는다.
 *
 * 비밀이 헤더가 아니라 경로에 있는 이유: 이 길을 여는 것은 iframe의 `src`다. iframe은 헤더를
 * 실을 수 없다. 대신 비밀이 URL에 남으므로 WebSocket 토큰과는 **다른 값**을 쓴다. 화면 주소가
 * 개발자 도구나 로그로 새어도 RPC 문은 열리지 않는다.
 *
 * WebSocket 업그레이드는 이 처리기를 지나지 않는다. `ws`가 http 서버의 `upgrade` 이벤트를 따로
 * 받고, 거기에는 origin 검사와 토큰 핸드셰이크가 이미 있다(server.ts).
 */

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE'

export type HttpRequest = {
  method: string
  /** 비밀 칸을 떼어 낸 나머지 경로 (`/views/abc/`). 퍼센트 인코딩은 풀지 않는다 */
  path: string
  query: URLSearchParams
  headers: IncomingHttpHeaders
  /** 경로 정규식이 잡은 칸들 (문자열 경로면 빈 배열) */
  params: readonly string[]
}

export type HttpResponse = {
  status: number
  headers?: Readonly<Record<string, string>>
  body?: string | Buffer
}

export type HttpRoute = {
  method: HttpMethod
  /**
   * 경로 전체가 맞아야 한다. 정규식은 여기서 `^…$`로 다시 감싸므로 앞뒤를 열어 둬도
   * 접두사로 새지 않는다 — `/views/x`를 받는 길이 `/views/x/../../secret`까지 받으면 안 된다.
   */
  path: string | RegExp
  /** null은 "그런 것은 없다"다. 길이 없는 것과 같은 404로 나간다 (있는지 없는지 새지 않게) */
  handle(req: HttpRequest): HttpResponse | null | Promise<HttpResponse | null>
}

export type HttpGate = {
  /** 실행마다 새로 만든다. 경로의 한 칸이 되므로 URL에 그대로 설 수 있는 글자만 */
  secret: string
  routes: readonly HttpRoute[]
}

/**
 * 비밀값의 최소 길이. 32바이트 난수를 base64url로 쓰면 43자다(main.ts). 짧은 값은 거절한다.
 * 이 길은 인증을 이 칸 하나에 맡긴다.
 */
export const SECRET_MIN_LENGTH = 32
const SECRET_CHARS = /^[A-Za-z0-9_-]+$/

/** 비밀값 규칙을 어기면 이유를, 괜찮으면 null */
export function secretError(secret: string): string | null {
  if (secret.length < SECRET_MIN_LENGTH) return `HTTP secret must be at least ${SECRET_MIN_LENGTH} characters`
  if (!SECRET_CHARS.test(secret)) return 'HTTP secret must be URL-safe (A-Z a-z 0-9 _ -)'
  return null
}

/**
 * 상수 시간 비교.
 *
 * `timingSafeEqual`은 길이가 같아야 해서 길이가 다른 입력에서는 먼저 빠져나간다. 그러면
 * 비밀의 길이가 응답 시간으로 샌다. 양쪽을 같은 해시로 눌러 길이를 고정한 뒤 비교한다.
 */
export function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/**
 * 모든 응답에 붙는 헤더.
 *
 * `Referrer-Policy: no-referrer`가 가장 중요하다. 비밀은 경로에 있다. 이 페이지가 띄우는
 * 화면(iframe)이 이 페이지의 주소를 referrer로 물려받으면 화면이 비밀을 읽는다. srcdoc
 * 문서의 `document.referrer`와 앱별 출처 화면의 Referer 헤더가 모두 여기서 막힌다.
 */
const BASE_HEADERS: Readonly<Record<string, string>> = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
}

const NOT_FOUND: HttpResponse = { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'not found' }

type CompiledRoute = { route: HttpRoute; match: (path: string) => string[] | null }

function compile(route: HttpRoute): CompiledRoute {
  if (typeof route.path === 'string') {
    const exact = route.path
    return { route, match: (p) => (p === exact ? [] : null) }
  }
  const re = new RegExp(`^(?:${route.path.source})$`, route.path.flags.replace('g', ''))
  return { route, match: (p) => re.exec(p)?.slice(1) ?? null }
}

/** 로그에 남길 길 이름. 비밀이 들어갈 자리가 없는 값만 쓴다 (URL 전체를 적지 않는다) */
function routeLabel(route: HttpRoute): string {
  return `${route.method} ${typeof route.path === 'string' ? route.path : route.path.source}`
}

/**
 * http 서버의 요청 처리기. 게이트가 없으면 모든 요청이 404다(예전 기본과 같다).
 * HostServer와 앱별 출처 서버(views/)가 같은 규칙을 쓰도록 여기 한 벌만 둔다.
 */
export function createHttpHandler(gate: HttpGate | undefined): RequestListener {
  if (gate) {
    const err = secretError(gate.secret)
    if (err) throw Object.assign(new Error(err), { code: 'internal' })
  }
  const routes = (gate?.routes ?? []).map(compile)

  return (req, res) => {
    const send = (r: HttpResponse) => {
      // 비동기 답을 기다리는 동안 상대가 끊었을 수 있다 — 닫힌 응답에 쓰지 않는다
      if (res.writableEnded || res.destroyed) return
      res.writeHead(r.status, { ...BASE_HEADERS, ...r.headers })
      res.end(r.body)
    }

    const answer = async (): Promise<HttpResponse> => {
      if (!gate) return NOT_FOUND
      let url: URL
      try {
        url = new URL(req.url ?? '/', 'http://127.0.0.1')
      } catch {
        return NOT_FOUND
      }
      // `/<비밀>/나머지`. URL 파서가 `..`를 이미 접었으므로 첫 칸은 실제로 쓰일 칸이다
      const slash = url.pathname.indexOf('/', 1)
      const first = slash < 0 ? url.pathname.slice(1) : url.pathname.slice(1, slash)
      if (!sameSecret(first, gate.secret)) return NOT_FOUND
      const path = slash < 0 ? '/' : url.pathname.slice(slash)
      for (const { route, match } of routes) {
        if (route.method !== req.method) continue
        const params = match(path)
        if (!params) continue
        try {
          return (await route.handle({ method: req.method, path, query: url.searchParams, headers: req.headers, params })) ?? NOT_FOUND
        } catch (e) {
          // 이유는 host 로그에만 남긴다. 응답에 실으면 앱 화면이 host 내부를 읽는다
          console.error(`[agent-host] http route failed: ${routeLabel(route)}: ${(e as Error)?.message ?? String(e)}`)
          return { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'internal error' }
        }
      }
      return NOT_FOUND
    }

    void answer().then(send, () => send(NOT_FOUND))
  }
}
