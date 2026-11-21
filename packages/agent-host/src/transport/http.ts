import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders, RequestListener } from 'node:http'
import { rpcError } from '../rpc-error.js'

/**
 * The host's HTTP door, on the same port as the WebSocket and reachable by anything on loopback (another program, any web page in a
 * browser). Every route sits behind a secret path segment generated fresh for each run and checked before any route is looked up; a
 * missing or wrong secret gets the exact same 404 as a route that does not exist. The secret is in the path because an iframe's `src`
 * cannot carry headers, and it is a different value from the WebSocket token, so a view address leaked through devtools or a log does not
 * open the RPC door. WebSocket upgrades never pass here: `ws` takes the `upgrade` event, with its own origin check and handshake (server.ts)
 */

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE'

export type HttpRequest = {
  method: string
  // Percent-encoding is not decoded
  path: string
  query: URLSearchParams
  headers: IncomingHttpHeaders
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
   * The whole path has to match: the regex is wrapped in `^…$`, so an open end cannot leak through as a prefix (`/views/x` must
   * not accept `/views/x/../../secret`)
   */
  path: string | RegExp
  handle(req: HttpRequest): HttpResponse | null | Promise<HttpResponse | null>
}

export type HttpGate = {
  secret: string
  routes: readonly HttpRoute[]
}

/**
 * The minimum secret length: a 32-byte random value in base64url is 43 characters (main.ts). This door entrusts all its
 * authentication to this one segment
 */
export const SECRET_MIN_LENGTH = 32
const SECRET_CHARS = /^[A-Za-z0-9_-]+$/

/**
 * The HTTP secret of a host started by the keeper (#280 step 4), derived from the keeper's token: a view's address carries it and has
 * to survive a build switch, so every host the keeper starts must derive the same one. It does not weaken the boundary: an HMAC is
 * one-way, so a leaked view address gives nothing toward the token and the RPC door stays closed. The other direction was never a
 * boundary: whoever holds the token has every RPC, `apps.viewFrame` included, which hands out this secret. The label keeps it from being
 * reused as anything else derived from the token
 */
export function deriveHttpSecret(token: string): string {
  return createHmac('sha256', token).update('centralu http secret v1').digest('base64url')
}

export function secretError(secret: string): string | null {
  if (secret.length < SECRET_MIN_LENGTH) return `HTTP secret must be at least ${SECRET_MIN_LENGTH} characters`
  if (!SECRET_CHARS.test(secret)) return 'HTTP secret must be URL-safe (A-Z a-z 0-9 _ -)'
  return null
}

/**
 * A constant-time comparison: `timingSafeEqual` needs equal lengths and would leak the secret's length through timing, so both
 * sides are hashed to a fixed length first
 */
export function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/**
 * Headers on every response. `Referrer-Policy: no-referrer` matters most: the secret is in the path, and a view inheriting this
 * page's address as referrer could read it (a srcdoc's `document.referrer` and a per-app origin view's Referer both)
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

// Only a value with no room for the secret is used, never the full URL
function routeLabel(route: HttpRoute): string {
  return `${route.method} ${typeof route.path === 'string' ? route.path : route.path.source}`
}

/**
 * The http server's request handler; without a gate every request is a 404. One implementation, so HostServer and the per-app
 * origin server (views/) share the rules
 */
export function createHttpHandler(gate: HttpGate | undefined): RequestListener {
  if (gate) {
    const err = secretError(gate.secret)
    if (err) throw rpcError(err)
  }
  const routes = (gate?.routes ?? []).map(compile)

  return (req, res) => {
    const send = (r: HttpResponse) => {
      // The other side may have disconnected while an async answer was pending: never write to a closed response
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
      // `/<secret>/rest`: the URL parser has already collapsed `..`, so the first segment is the one that is used
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
          // The reason goes only to the host log: in the response an app view could read the host's internals
          console.error(`[agent-host] http route failed: ${routeLabel(route)}: ${(e as Error)?.message ?? String(e)}`)
          return { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'internal error' }
        }
      }
      return NOT_FOUND
    }

    void answer().then(send, () => send(NOT_FOUND))
  }
}
