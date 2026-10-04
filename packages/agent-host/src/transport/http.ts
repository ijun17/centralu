import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type { IncomingHttpHeaders, RequestListener } from 'node:http'

/**
 * The host's HTTP door (M4 P-2).
 *
 * Previously, a synchronous hook taking just a path (`onHttp(path)`) sat open on the same port as
 * WebSocket **with no authentication**. The problem simply never surfaced because nothing used it.
 * Once app views (the sandbox proxy) started being served on this port, this door became open to
 * anyone able to reach loopback — another program on the same machine, and any web page opened in
 * a browser, can call `http://127.0.0.1:<port>`.
 *
 * So there is one rule: **every route sits behind a secret path segment.** The path's first
 * segment has to match the secret value generated fresh for that run before any route beyond it is
 * looked up. There is no public route. If the secret is missing or wrong, the exact **same** 404
 * goes out as when the route does not exist (status, body, and headers all identical). It does not
 * even reveal that the secret was wrong.
 *
 * Why the secret is in the path rather than a header: what opens this door is an iframe's `src`,
 * and an iframe cannot carry headers. Since the secret ends up in the URL instead, it uses a
 * **different value** from the WebSocket token — if a view's address leaks through devtools or a
 * log, the RPC door still does not open.
 *
 * WebSocket upgrades never pass through this handler. `ws` receives the http server's `upgrade`
 * event separately, and that path already has its own origin check and token handshake
 * (server.ts).
 */

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE'

export type HttpRequest = {
  method: string
  /** The remaining path with the secret segment stripped off (`/views/abc/`). Percent-encoding is not decoded */
  path: string
  query: URLSearchParams
  headers: IncomingHttpHeaders
  /** The segments captured by the path regex (an empty array for a string path) */
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
   * The whole path has to match. Since the regex is rewrapped here with `^…$`, leaving the ends
   * open still does not leak through as a prefix — a route matching `/views/x` must not also
   * accept `/views/x/../../secret`.
   */
  path: string | RegExp
  /** null means "there is no such thing." Goes out as the same 404 as a nonexistent route (so existence never leaks) */
  handle(req: HttpRequest): HttpResponse | null | Promise<HttpResponse | null>
}

export type HttpGate = {
  /** Generated fresh for every run (under the keeper, derived from its token: `deriveHttpSecret`). Since it becomes a path segment, only characters that survive intact in a URL are used */
  secret: string
  routes: readonly HttpRoute[]
}

/**
 * The minimum length of the secret. A 32-byte random value written as base64url is 43 characters
 * (main.ts). Short values are rejected. This door entrusts all of its authentication to this one
 * segment.
 */
export const SECRET_MIN_LENGTH = 32
const SECRET_CHARS = /^[A-Za-z0-9_-]+$/

/**
 * The HTTP secret of a host started by the keeper (#280 step 4), derived from the keeper's token.
 *
 * Why it is not random there: a view's address carries this secret, and under the keeper that
 * address has to survive a build switch — the iframe keeps it, and the next host behind the same
 * front door must still accept it. The keeper hands every host it starts the same token, so a value
 * derived from the token is the same on every one of them, with nothing new to hand over.
 *
 * Why this does not weaken the boundary: the two doors stay apart in the direction that matters. An
 * HMAC is one-way, so a leaked view address (devtools, a log) still gives nothing toward the token
 * and the RPC door stays closed, which is the reason the two are separate values at all. The other
 * direction was never a boundary: whoever holds the token already has every RPC, including
 * `apps.viewFrame`, which hands out this secret in its answer — the RPC door is more than the HTTP
 * door. The label keeps the value from being reused as anything else derived from the token.
 */
export function deriveHttpSecret(token: string): string {
  return createHmac('sha256', token).update('centralu http secret v1').digest('base64url')
}

/** A reason if the secret breaks the rules, null if it is fine */
export function secretError(secret: string): string | null {
  if (secret.length < SECRET_MIN_LENGTH) return `HTTP secret must be at least ${SECRET_MIN_LENGTH} characters`
  if (!SECRET_CHARS.test(secret)) return 'HTTP secret must be URL-safe (A-Z a-z 0-9 _ -)'
  return null
}

/**
 * A constant-time comparison.
 *
 * `timingSafeEqual` requires equal lengths, so it bails out early for inputs of different lengths.
 * That would leak the secret's length through response timing. Both sides are hashed down to a
 * fixed length first, and then compared.
 */
export function sameSecret(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

/**
 * Headers attached to every response.
 *
 * `Referrer-Policy: no-referrer` is the most important one. The secret lives in the path. If the
 * view (iframe) that this page renders inherited this page's address as its referrer, the view
 * would be able to read the secret. Both a srcdoc document's `document.referrer` and a per-app
 * origin view's Referer header are blocked right here.
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

/** The route name to record in the log. Only a value with no room for the secret is used (never the full URL) */
function routeLabel(route: HttpRoute): string {
  return `${route.method} ${typeof route.path === 'string' ? route.path : route.path.source}`
}

/**
 * The http server's request handler. Without a gate, every request is a 404 (the same as the old
 * default). Kept as this one implementation so that HostServer and the per-app origin server
 * (views/) both use the same rules.
 */
export function createHttpHandler(gate: HttpGate | undefined): RequestListener {
  if (gate) {
    const err = secretError(gate.secret)
    if (err) throw Object.assign(new Error(err), { code: 'internal' })
  }
  const routes = (gate?.routes ?? []).map(compile)

  return (req, res) => {
    const send = (r: HttpResponse) => {
      // The other side may have disconnected while an async answer was pending — never write to a closed response
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
      // `/<secret>/rest`. Since the URL parser has already collapsed `..`, the first segment is the one that actually gets used
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
          // The reason is recorded only in the host log. Putting it in the response would let an app view read the host's internals
          console.error(`[agent-host] http route failed: ${routeLabel(route)}: ${(e as Error)?.message ?? String(e)}`)
          return { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body: 'internal error' }
        }
      }
      return NOT_FOUND
    }

    void answer().then(send, () => send(NOT_FOUND))
  }
}
