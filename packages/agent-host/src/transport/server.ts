import { WebSocketServer, type WebSocket } from 'ws'
import { createServer, type Server } from 'node:http'
import {
  PROTOCOL_VERSION,
  ProtocolErrorCode,
  type HostBuild,
  type NormalizedEvent,
  type ProtocolError,
  parseClientFrame,
} from '@cc/protocol'
import { EventLog } from './event-log.js'
import { createHttpHandler, type HttpGate } from './http.js'
import { DrainCut, type Drain } from '../drain.js'

/**
 * The WS server (docs/protocol.md §1). Identical in dev and prod — Tauri only spawns this process.
 * Security: loopback binding + a token handshake generated at startup.
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
 * `CC_HOST_ALLOWED_ORIGINS` (comma-separated) → overrides allowedOrigins.
 *
 * The default list is only the dev ports and Tauri WebView we know about. When a connection has to
 * come from somewhere else — vite started on a different port, or opened behind a reverse proxy —
 * there was until now no way to do that other than editing the host and rebuilding it. On top of
 * that, being blocked only ever showed up on screen as `Disconnected`, making it hard to even know
 * there was a way out.
 *
 * **An empty value is "not configured," not an override.** Passing an empty string or a
 * comma-only value straight through would turn the allow list into an empty set, and no one could
 * connect — too big a cost for one typo, and an environment variable ending up empty by accident
 * is common. Whitespace-only entries are dropped for the same reason: an empty string means "no
 * Origin header" to originAllowed, and it must never end up in this list.
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
  /**
   * The HTTP door on the same port (M4 P-2). Every route sits behind a secret path generated fresh
   * for that run (http.ts). Without one, every HTTP request is a 404. WebSocket upgrades follow the
   * rule below independently of this.
   */
  http?: HttpGate
  /**
   * How long a socket may stay connected without a valid hello (#82). Until then it holds a
   * socket, a timer and a slot in the http server's connection list for nothing.
   */
  handshakeTimeoutMs?: number
  /**
   * The undrained backlog a peer may leave on one socket before it is cut (#82). See
   * `sendTo` for why the rule is "already over the bound", not "this frame would cross it".
   */
  maxBufferedBytes?: number
  /**
   * The largest replay one hello may start, counted as bytes on the wire, WebSocket framing
   * included (#82). A bigger replay is answered with a resync instead. Clamped to
   * `maxBufferedBytes` so that a replay can never trip the outbound bound by itself.
   */
  replayBudgetBytes?: number
  /** How long a socket gets to finish the close handshake on shutdown before it is cut (#82) */
  closeGraceMs?: number
  /** Which build this host is, sent in every `hello_ok` (#280) */
  build?: HostBuild
  /**
   * Tracks every RPC for a planned host swap (#280 step 3, drain.ts): once the drain begins, new
   * RPCs are refused and running ones get its bound to finish. Refused and cut calls are answered
   * `retryable: true`, because the same call reaches the next host.
   */
  drain?: Drain
}

/**
 * Transport bounds (#82). These bound what one socket can make the host hold; they are not a
 * process-wide memory quota.
 *
 * - The outbound bound is 64 MiB because the host legitimately sends single frames in the tens of
 *   megabytes: a diff can be as large as the 32 MiB output buffer the host allows its VCS calls,
 *   and an image event carries up to 8 MiB of base64-inflated data. A backlog above that is a peer
 *   that stopped reading (a suspended WebView, a hung client), and measured on main it grew
 *   without limit: 99.5 MB after 1,000 broadcasts of 100 kB to a paused peer.
 * - The replay budget is 16 MiB. Above that a snapshot reload is cheaper and just as correct as a
 *   replay, and it keeps a reconnect burst well under the outbound bound.
 */
export const TRANSPORT_LIMITS = {
  handshakeTimeoutMs: 10_000,
  maxBufferedBytes: 64 * 1024 * 1024,
  replayBudgetBytes: 16 * 1024 * 1024,
  closeGraceMs: 250,
} as const

/** WebSocket close codes this server uses (4001 is the token rule's own) */
const CLOSE_GOING_AWAY = 1001
const CLOSE_AUTH = 4001

/** Bytes a server-to-client WebSocket frame adds around its payload (RFC 6455 §5.2, unmasked) */
function frameOverhead(payloadBytes: number): number {
  return payloadBytes < 126 ? 2 : payloadBytes < 65_536 ? 4 : 10
}

/** What a frame costs on the wire */
function wireBytes(frame: string): number {
  const n = Buffer.byteLength(frame)
  return n + frameOverhead(n)
}

export class HostServer {
  readonly log = new EventLog()
  private wss: WebSocketServer
  private http: Server
  private clients = new Set<WebSocket>()
  /** Handshake deadlines of sockets that have not sent a valid hello yet */
  private handshakeTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>()
  private closing: Promise<void> | null = null
  private readonly limits: { handshakeTimeoutMs: number; maxBufferedBytes: number; replayBudgetBytes: number; closeGraceMs: number }
  private listenError: ((err: Error) => void) | null = null
  private readonly allowedOrigins: ReadonlySet<string>
  /**
   * Rejected origins already logged — so the same message does not repeat every 5 seconds (see
   * verifyClient below).
   *
   * **This has a cap.** This set's keys are the Origin header a request sends, a value chosen from
   * outside. Storing them without bound would let anyone able to reach loopback knock with a
   * different Origin each time and grow the host's memory — no token even required (the same spot
   * used to hang shutdown too). More than 64 distinct origins never comes up in normal use, so once
   * exceeded the set is cleared and counting starts over. All that is lost is the memory of "this
   * origin was already logged," so the worst case is one extra log line.
   */
  private readonly loggedRejections = new Set<string>()
  private static readonly MAX_LOGGED_REJECTIONS = 64

  constructor(private opts: HostServerOptions) {
    /*
     * A whitespace-only token is **not a credential** — the browser already treats it that way.
     *
     * apps/web/src/bootstrap.ts's browserHostOptions trims VITE_HOST_TOKEN and throws
     * MissingHostTokenError if it comes out empty. If this side only checked `!opts.token` with no
     * trim, a single `CC_HOST_TOKEN=" "` would split the two sides' judgment: the host would accept
     * " " as a normal token and run with it as the correct secret after just a few guesses, while
     * the UI sends '' and never connects at all. This was actually reproduced — the host got as far
     * as listen, and the UI threw MissingHostTokenError. Both sides are aligned to use the same
     * rule.
     */
    if (!opts.token.trim()) throw Object.assign(new Error('Host token must not be empty'), { code: 'internal' })
    this.allowedOrigins = new Set(opts.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS)
    const maxBufferedBytes = opts.maxBufferedBytes ?? TRANSPORT_LIMITS.maxBufferedBytes
    this.limits = {
      handshakeTimeoutMs: opts.handshakeTimeoutMs ?? TRANSPORT_LIMITS.handshakeTimeoutMs,
      maxBufferedBytes,
      replayBudgetBytes: Math.min(opts.replayBudgetBytes ?? TRANSPORT_LIMITS.replayBudgetBytes, maxBufferedBytes),
      closeGraceMs: opts.closeGraceMs ?? TRANSPORT_LIMITS.closeGraceMs,
    }
    this.http = createServer(createHttpHandler(opts.http))
    this.wss = new WebSocketServer({
      server: this.http,
      verifyClient: (info, done) => {
        const origin = info.req.headers.origin
        const ok = this.originAllowed(origin)
        /*
         * The rejection **is logged.** The browser never hands the upgrade's 403 to the page
         * script, so the screen just shows `Disconnected` and keeps retrying — indistinguishable
         * from "the host is off." If the host log has nothing either, there is no way left for a
         * person to find out where it was blocked. Printing the rejected origin as is means that
         * one line alone tells them what to put in CC_HOST_ALLOWED_ORIGINS.
         *
         * **Logged only once per origin.** A blocked UI does not give up — rpc-client's backoff
         * caps out at 5 seconds (web/rpc-client.ts), so leaving it running would pile up more than
         * 700 identical lines an hour. This is the exact host.log people are told to attach to a bug
         * report. From the second line on there is nothing new to say, so only the first line is
         * kept.
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
    // ws re-emits http server errors on its own instance — if this is not received here, the process dies
    this.wss.on('error', (err) => this.listenError?.(err))
  }

  /**
   * The origin boundary (docs/security-boundaries.md).
   *
   * **Letting a missing or empty Origin through is a decision, not an oversight.** A browser always
   * attaches Origin to a cross-origin request, so a connection with no header at all is not a
   * browser — it is a native client (a path other than the Tauri WebView, a test's ws client,
   * curl). That kind of client cannot be blocked by origin anyway, and loopback binding plus the
   * token handshake already block it regardless. Rejecting a missing Origin here would block not
   * an attacker but only our own tests and sidecars.
   *
   * The string `'null'`, on the other hand, **is an Origin that is present.** A sandbox iframe or a
   * file:// page genuinely sends this value, so it must not be treated the same as missing — hence
   * it is blocked explicitly. server.test.ts pokes at 10 kinds of origin — all 7 on the allow list,
   * no Origin, `http://evil.example`, and the string `'null'`. Behavior matches the docs.
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
      // Can come from either http or ws (ws re-emits http errors)
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
   * Closing.
   *
   * **Iterates `wss.clients`, not `this.clients`.** The latter set holds only sockets that passed
   * hello — that is fine for broadcasting. But a socket that finished the upgrade but has not
   * authenticated yet is still, from the http server's point of view, a live connection, and if it
   * is not closed, `http.close()`'s callback never comes.
   *
   * This is not a hypothetical — it was measured. With **one** socket that had connected but never
   * sent hello, close() on the `this.clients` version did not finish even after waiting 5 seconds
   * (and never would have, left alone), while the `wss.clients` version finished in 2ms. In other
   * words, blocking host shutdown does not even require authentication. The same thing shows up in
   * tests as a hook timeout: deliberately disabling the origin check to leave two sockets open made
   * `afterEach` take 10 seconds each, pushing the file from 644ms to 20.54s, and fixing this line
   * brought it back to 617ms under the same conditions.
   *
   * **Every connection gets a deadline, not just a request to leave (#82).** Two more ways to hang
   * remained, both measured on main as still waiting after 3 seconds:
   *   - a WebSocket peer that never answers the close frame (a suspended WebView, a hung client):
   *     `ws` waits 30 seconds for it, far past the desktop supervisor's 3-second budget, after
   *     which the host is SIGKILLed mid-cleanup;
   *   - a raw HTTP connection holding a half-sent request: `http.close()` only drops idle
   *     connections, so the callback never comes.
   * So the close frame is sent, a peer gets `closeGraceMs` to answer it, and then the socket is
   * cut; plain HTTP connections are dropped outright. Calling close() again returns the same
   * promise instead of starting a second shutdown.
   */
  close(): Promise<void> {
    this.closing ??= this.shutdown()
    return this.closing
  }

  private async shutdown(): Promise<void> {
    for (const timer of this.handshakeTimers.values()) clearTimeout(timer)
    this.handshakeTimers.clear()
    const sockets = [...this.wss.clients]
    const gone = sockets.map((c) =>
      c.readyState === c.CLOSED ? Promise.resolve() : new Promise<void>((r) => c.once('close', () => r())),
    )
    for (const c of sockets) c.close(CLOSE_GOING_AWAY, 'host shutting down')
    const cut = setTimeout(() => {
      for (const c of sockets) c.terminate()
    }, this.limits.closeGraceMs)
    await Promise.all(gone)
    clearTimeout(cut)
    this.clients.clear()
    const httpClosed = new Promise<void>((r) => this.http.close(() => r()))
    this.http.closeAllConnections()
    await new Promise<void>((r) => this.wss.close(() => r()))
    await httpClosed
  }

  /** Broadcasts an event — assigns a seq, keeps it in the ring buffer, and pushes it to connected clients */
  broadcast(event: NormalizedEvent): void {
    const entry = this.log.append(event)
    const frame = JSON.stringify({ kind: 'event', seq: entry.seq, event })
    for (const ws of this.clients) this.sendTo(ws, frame)
  }

  /** This host lifetime's id — sent in every `hello_ok` (#82) */
  get streamEpoch(): string {
    return this.log.streamEpoch
  }

  /**
   * Pushes terminal output.
   * Does not run this through the event log (the seq ring buffer) — the volume of output is orders
   * of magnitude different from conversation events, and anything missed is received whole from the
   * host's scrollback on reconnect.
   */
  pushTerminal(frame: { terminalId: string; data?: string; exitCode?: number | null }): void {
    const payload =
      frame.data !== undefined
        ? { kind: 'term', terminalId: frame.terminalId, data: frame.data }
        : { kind: 'term_exit', terminalId: frame.terminalId, exitCode: frame.exitCode ?? null }
    const json = JSON.stringify(payload)
    for (const ws of this.clients) this.sendTo(ws, json)
  }

  /**
   * The one way a frame leaves this server (#82).
   *
   * A peer whose backlog is **already** above `maxBufferedBytes` has stopped reading, and is cut
   * (terminate, not close: a close frame would queue behind the very backlog that is the problem).
   * It reconnects when it wakes and gets a replay or a resync; the host's agents never wait on it.
   *
   * Why "already above" rather than "this frame would cross it": the host sends single frames in
   * the tens of megabytes (see TRANSPORT_LIMITS), and refusing one of those because it would cross
   * the line would cut a perfectly healthy reader. What is bounded is the backlog plus one frame.
   */
  private sendTo(ws: WebSocket, frame: string): boolean {
    if (ws.readyState !== ws.OPEN) return false
    if (ws.bufferedAmount > this.limits.maxBufferedBytes) {
      console.error(
        `[agent-host] a client stopped reading (${ws.bufferedAmount} bytes waiting); dropping its socket, it will resync when it reconnects`,
      )
      this.clients.delete(ws)
      ws.terminate()
      return false
    }
    ws.send(frame)
    return true
  }

  private onConnection(ws: WebSocket): void {
    let authed = false
    // A socket that never says hello is closed, not kept forever (#82)
    this.handshakeTimers.set(
      ws,
      setTimeout(() => {
        this.handshakeTimers.delete(ws)
        if (!authed) ws.close(CLOSE_AUTH, 'auth timeout')
      }, this.limits.handshakeTimeoutMs),
    )

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
        /*
         * A second hello on a socket that is already in is ignored (#82). Answering it replayed
         * the window again on the same socket — measured on main: two hellos with afterSeq 1
         * delivered seq 2 twice — and the client has no way to tell a repeat from new work.
         */
        if (authed) return
        if (frame.data.token !== this.opts.token) {
          ws.close(CLOSE_AUTH, 'bad token')
          return
        }
        if (frame.data.protocolVersion !== PROTOCOL_VERSION) {
          this.sendError(ws, null, {
            code: 'version_mismatch',
            message: versionMismatchMessage(PROTOCOL_VERSION, frame.data.protocolVersion, this.opts.build?.version),
            retryable: false,
          })
          ws.close(4002, 'version mismatch')
          return
        }
        authed = true
        clearTimeout(this.handshakeTimers.get(ws))
        this.handshakeTimers.delete(ws)
        this.clients.add(ws)
        this.greet(ws, frame.data.afterSeq ?? 0, frame.data.streamEpoch)
        return
      }

      if (!authed) {
        ws.close(CLOSE_AUTH, 'not authed')
        return
      }

      // RPC
      const { method, params, id } = frame.data
      try {
        const run = () => this.opts.onRpc(method, params)
        const result = await (this.opts.drain ? this.opts.drain.track(`rpc ${method}`, run) : run())
        this.sendTo(ws, JSON.stringify({ kind: 'res', id, ok: true, result }))
      } catch (err) {
        const e = err as Error & { code?: unknown }
        this.sendError(ws, id, {
          code: errorCode(e.code),
          message: e.message ?? 'Unknown error',
          // Only a swap's refusal or cut says "send it again": the next host will take it (#280)
          retryable: err instanceof DrainCut,
        })
      }
    })

    const forget = () => {
      clearTimeout(this.handshakeTimers.get(ws))
      this.handshakeTimers.delete(ws)
      this.clients.delete(ws)
    }
    ws.on('close', forget)
    ws.on('error', forget)
  }

  /**
   * `hello_ok` and the replay of what was missed (docs/protocol.md §1) — sent in one go, so no
   * broadcast can slip in between.
   *
   * **The whole replay is priced before any of it is sent (#82).** A replay that would not fit
   * the budget is not started at all: the client gets `resyncRequired` with the current seq and
   * reloads its snapshot. Starting it and cutting the socket halfway would leave the client's
   * cursor where it was, and its next reconnect would ask for the same oversized window — a
   * reconnect loop that never converges (the livelock the review of #91 found). Measured on main:
   * a 2,000 x 50 kB history replayed to a stalled peer left 99.6 MB buffered in the host.
   */
  private greet(ws: WebSocket, afterSeq: number, streamEpoch: string | undefined): void {
    const hello = (resyncRequired: boolean) =>
      JSON.stringify({
        kind: 'hello_ok',
        protocolVersion: PROTOCOL_VERSION,
        resyncRequired,
        currentSeq: this.log.currentSeq,
        streamEpoch: this.log.streamEpoch,
        ...(this.opts.build ? { build: this.opts.build } : {}),
      })
    const window = this.log.since(afterSeq, streamEpoch)
    const frames = window.events.map((e) => JSON.stringify({ kind: 'event', seq: e.seq, event: e.event }))
    let bytes = ws.bufferedAmount + wireBytes(hello(window.resyncRequired))
    for (const f of frames) bytes += wireBytes(f)
    if (bytes > this.limits.replayBudgetBytes) {
      this.sendTo(ws, hello(true))
      return
    }
    this.sendTo(ws, hello(window.resyncRequired))
    // Resend what was missed — so that reconnecting never loses state (docs/protocol.md §1)
    for (const f of frames) this.sendTo(ws, f)
  }

  private sendError(ws: WebSocket, id: string | null, error: ProtocolError): void {
    this.sendTo(ws, JSON.stringify({ kind: 'res', id: id ?? '0', ok: false, error }))
  }
}


/**
 * The refusal a client of another protocol gets (#82), worded for the person who has to act on it.
 *
 * With the app and the host on one machine they always came from one install, so "server 1,
 * client 2" was enough. With a host on another machine (`centralu serve`) the two are updated
 * separately, and the message has to say which of them is behind: the older side is the one to
 * update. The client shows it as is. `centralu serve --connection` reads the host's number back
 * out of either wording (`mismatchServerVersion` in packaging/npm/centralu/bin/serve.mjs), so
 * "host speaks protocol N" stays in the text.
 */
export function versionMismatchMessage(server: number, client: number, hostVersion?: string): string {
  const host = hostVersion ? `Centralu ${hostVersion}` : 'This host'
  const which =
    server < client
      ? 'The host is older: update Centralu where the host runs (npm i -g centralu), then restart it.'
      : 'The app is older: update the Centralu app on this computer.'
  return `Protocol version mismatch: ${host} speaks protocol ${server}, the app speaks protocol ${client}. ${which}`
}

/**
 * Only a code the protocol knows about ever goes out (dogfooding, 2026-09-10).
 *
 * Most of the failures thrown here are **Node's own failures** — `fs.stat` comes with
 * `code: 'ENOENT'`, `spawn` with `'EACCES'`. Putting that string into the envelope as is means a
 * value the protocol enum does not have, and **the client drops the entire frame**: instead of a
 * failure arriving as a failure, nothing arrives at all, and the view waiting on that call sat
 * stuck on "loading" until the 30-second timeout (this is why a file link showed up as a blank
 * screen).
 *
 * So an unrecognized code is swapped for `internal`. **The message still carries the explanation
 * as is** — 'ENOENT' does not disappear from the sentence a person reads.
 */
function errorCode(raw: unknown): ProtocolError['code'] {
  const known = ProtocolErrorCode.safeParse(raw)
  return known.success ? known.data : 'internal'
}
