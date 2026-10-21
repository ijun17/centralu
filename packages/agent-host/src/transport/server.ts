import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import {
  CANCEL_CALL_METHOD,
  PROTOCOL_VERSION,
  ProtocolErrorCode,
  type HostBuild,
  type HostHandover,
  type HostLogon,
  type RpcAnswer,
  type NormalizedEvent,
  type ProtocolError,
  parseClientFrame,
  SHOWS_HOST_REQUESTS,
  errorMessage,
} from '@cc/protocol'
import { EventLog } from './event-log.js'
import { createHttpHandler, sameSecret, type HttpGate } from './http.js'
import { bridgeRefusal, bridgeSessionOf } from './bridge-token.js'
import { isLimitedToken } from './limited-token.js'
import { limitedRefusal } from './method-rights.js'
import { hostProof } from './host-proof.js'
import { DrainCut, type Drain } from '../drain.js'
import { rpcError } from '../rpc-error.js'

/**
 * The WS server (docs/protocol.md §1). Identical in dev and prod — Tauri only spawns this process.
 * Security: loopback binding + a token handshake generated at startup.
 */
/**
 * Which connection a call came in on. `client` is a number this server gives each socket once its
 * hello is accepted, never reused within one host's life. Something a window holds for as long as
 * it stays (a leased app view, #392) is tied to it, and let go when `onClientGone` names it.
 */
export type RpcContext = {
  client: number
  /**
   * What the socket said hello with (#1405): `full`, the host's token (a window, or a hub linked to this host), or
   * `limited`, the limited credential (`limited-token.ts`) every other process of this user is meant to hold. A limited
   * call reaches the handler only when `method-rights.ts` lets it; a bridge's calls carry `full`, since what a bridge
   * may call is already narrowed to its own session's tool channel (`bridgeRefusal`)
   */
  rights: 'full' | 'limited'
  /** What the program called itself in its hello (#1405), cut and never checked; null when it said nothing. Words of the program's own: a header or a screen takes it through `scriptLabel` */
  label?: string | null
}

export type RpcHandler = (method: string, params: unknown, ctx?: RpcContext) => Promise<unknown>

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
  /** Started by `centralu serve`: a taken port gets serve's advice, not a developer's (#482) */
  servedBy?: 'serve'
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
   * How many sockets may wait for their hello at once. A new upgrade past this is refused with a 503, so
   * connections that never speak cannot hold a slot each for the whole handshake deadline.
   */
  maxPendingHandshakes?: number
  /** The largest frame a socket may send once it has said hello, as bytes of payload. Defaults to `TRANSPORT_LIMITS.maxFrameBytes` */
  maxFrameBytes?: number
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
  /** Whether this host runs with administrator rights, read at every `hello_ok` (#702, elevation.ts); null: not known */
  elevated?: () => boolean | null
  /** Which Windows logon this host runs in, read at every `hello_ok` (#1224, elevation.ts); null: not known, or not Windows */
  logon?: () => HostLogon | null
  /** A sign-in's serve waiting to take over from this host, read at every `hello_ok` (#1224, `host.handover`) */
  handover?: () => HostHandover | null
  /** A connection that passed hello has ended (its `RpcContext.client`) */
  onClientGone?: (client: number) => void
  /**
   * A call made with the limited credential that asks the person (#1405, `asks` in method-rights.ts): what answers it,
   * after the person did (host-requests.ts). `from.client` is what the program called itself in its hello; `signal`
   * fires when its socket goes. Without it, such a call is refused as before
   */
  onAsk?: (method: string, params: unknown, from: { client: string | null }, signal: AbortSignal) => Promise<unknown>
  /** How many windows that show host requests are attached, each time it changes (#1405, `HostRequests.showingChanged`) */
  onShowing?: (count: number) => void
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
  maxPendingHandshakes: 16,
  /**
   * The largest frame a socket may send after hello: the library's own default (100 MiB), set here so it
   * is a decision and not an accident. A call carries a file as one base64 string (an attachment, a
   * dropped file), and a file bigger than the usual cap has always worked, so this stays as it was.
   * Before hello a socket gets much less (`maxHelloFrameBytes`).
   */
  maxFrameBytes: 100 * 1024 * 1024,
  /**
   * What a socket may send before it has said hello: a hello is a token and two numbers. Counted as
   * bytes read from the socket (`onConnection`), so a frame cannot be buffered whole first, and also as
   * the size of the one frame allowed.
   */
  maxHelloFrameBytes: 64 * 1024,
  maxBufferedBytes: 64 * 1024 * 1024,
  replayBudgetBytes: 16 * 1024 * 1024,
  closeGraceMs: 250,
} as const

/** What the pre-hello byte count allows beyond the one frame: its WebSocket header, and the bytes of a close it may answer */
const PRE_HELLO_SLACK_BYTES = 1024

/** A call this host sent a client (#550), until its answer */
type ReverseCall = { resolve: (v: unknown) => void; reject: (e: Error) => void }

/** How long a call this host sends a client may wait for its answer, when the caller sets no bound (#550) */
export const REVERSE_CALL_TIMEOUT_MS = 30 * 60_000

/** WebSocket close codes this server uses (4001 is the token rule's own) */
const CLOSE_GOING_AWAY = 1001
const CLOSE_AUTH = 4001

/** `hello_ok`'s `elevated`, only when it is known (#702) */
function elevatedField(elevated: boolean | null | undefined): { elevated?: boolean } {
  return typeof elevated === 'boolean' ? { elevated } : {}
}

/** The payload size of a received message, whichever shape `ws` hands it in */
function rawBytes(raw: RawData): number {
  if (Array.isArray(raw)) return raw.reduce((n, b) => n + b.length, 0)
  return raw.byteLength
}

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
  /** Bounded by the replay budget as well as by count: an event no replay can reach is held for nothing (#392) */
  readonly log: EventLog
  private wss: WebSocketServer
  private http: Server
  private clients = new Set<WebSocket>()
  /** The sockets holding the token that said in their hello they show host requests (#1405): windows of this build on */
  private showing = new Set<WebSocket>()
  /** The last `RpcContext.client` given out */
  private lastClient = 0
  /** Handshake deadlines of sockets that have not sent a valid hello yet */
  private handshakeTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>()
  /** The sockets in `clients` by their `RpcContext.client`, for a call to one of them (`call`, #550) */
  private byClient = new Map<number, WebSocket>()
  /** This host's calls to a client still waiting for its answer, per socket (#550) */
  private calls = new Map<WebSocket, Map<string, ReverseCall>>()
  /** The last id of a call this host sent a client */
  private lastCall = 0
  private closing: Promise<void> | null = null
  private readonly limits: {
    handshakeTimeoutMs: number
    maxPendingHandshakes: number
    maxFrameBytes: number
    maxBufferedBytes: number
    replayBudgetBytes: number
    closeGraceMs: number
  }
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
    if (!opts.token.trim()) throw rpcError('Host token must not be empty')
    this.allowedOrigins = new Set(opts.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS)
    const maxBufferedBytes = opts.maxBufferedBytes ?? TRANSPORT_LIMITS.maxBufferedBytes
    this.limits = {
      handshakeTimeoutMs: opts.handshakeTimeoutMs ?? TRANSPORT_LIMITS.handshakeTimeoutMs,
      maxPendingHandshakes: opts.maxPendingHandshakes ?? TRANSPORT_LIMITS.maxPendingHandshakes,
      maxFrameBytes: opts.maxFrameBytes ?? TRANSPORT_LIMITS.maxFrameBytes,
      maxBufferedBytes,
      replayBudgetBytes: Math.min(opts.replayBudgetBytes ?? TRANSPORT_LIMITS.replayBudgetBytes, maxBufferedBytes),
      closeGraceMs: opts.closeGraceMs ?? TRANSPORT_LIMITS.closeGraceMs,
    }
    this.log = new EventLog(2000, this.limits.replayBudgetBytes)
    this.http = createServer(createHttpHandler(opts.http))
    this.wss = new WebSocketServer({
      server: this.http,
      // A frame over this closes the socket with 1009 before it is handed to us
      maxPayload: this.limits.maxFrameBytes,
      verifyClient: (info, done) => {
        // Sockets that have not said hello are limited in number: past that a new upgrade is refused
        if (this.handshakeTimers.size >= this.limits.maxPendingHandshakes) return done(false, 503, 'too many connections waiting for hello')
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
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req))
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
            new Error(portInUseMessage(this.opts.port, this.opts.servedBy)),
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
    // Serialised once: its size charges the replay buffer, and the frame is built around it
    const body = JSON.stringify(event)
    const entry = this.log.append(event, body.length)
    const frame = `{"kind":"event","seq":${entry.seq},"event":${body}}`
    for (const ws of this.clients) this.sendTo(ws, frame)
  }

  /**
   * The connections that receive events: windows and a hub linked to this host (the token), and the limited
   * credential's (#1405). Never a bridge
   */
  get clientCount(): number {
    return this.clients.size
  }

  /** Whether a window that shows host requests is attached with the token (#1405, `hello.shows`) */
  showsHostRequests(): boolean {
    return this.showing.size > 0
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

  /**
   * Closes a socket that is not in: the close frame goes out (the peer sees why), and a peer that does not
   * answer it is cut after the grace. `ws.close()` alone waits up to 30 s for the answer, with the socket
   * still open and still read, and the slot it holds would stay taken that long.
   */
  private refuse(ws: WebSocket, code: number, reason: string): void {
    ws.close(code, reason)
    setTimeout(() => ws.terminate(), this.limits.closeGraceMs).unref()
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    let authed = false
    /** The session whose bridge credential this socket said hello with; null for the front door's token */
    let bridgeOf: string | null = null
    /** Whether this socket said hello with the limited credential, not the token (#1405) */
    let limited = false
    /** What the program called itself in its hello (#1405), for a card its call raises; cut, never checked */
    let label: string | null = null
    /** Fires when this socket goes: a host request its call raised is withdrawn (#1405) */
    const leaving = new AbortController()
    /** Whether this socket already asked for the host's proof (`prove`, #838): once, before hello */
    let proved = false
    const client = ++this.lastClient
    // A socket that never says hello is closed, not kept forever (#82). Its slot is given back when it is gone ('close' below), not before
    this.handshakeTimers.set(
      ws,
      setTimeout(() => {
        if (!authed) this.refuse(ws, CLOSE_AUTH, 'auth timeout')
      }, this.limits.handshakeTimeoutMs),
    )
    /*
     * Until hello, what the socket sends is counted as it is read, and a socket past the bound is cut.
     * The message handler below only sees a frame once all of it has arrived, which is too late for a
     * peer that announces a frame of tens of megabytes and keeps sending it.
     */
    let preHelloBytes = 0
    const countPreHello = (chunk: Buffer) => {
      preHelloBytes += chunk.length
      if (preHelloBytes > TRANSPORT_LIMITS.maxHelloFrameBytes + PRE_HELLO_SLACK_BYTES) req.socket.destroy()
    }
    req.socket.on('data', countPreHello)

    ws.on('message', async (raw) => {
      /*
       * Until hello is accepted a socket is allowed one small frame, and it has to be a hello. Anything
       * else (a frame that is too big, not JSON, not a frame of the protocol, an RPC) closes it, so it
       * does not keep a slot while it tries other things. The size is checked before JSON.parse, which
       * would otherwise build the whole value first.
       */
      if (!authed && rawBytes(raw) > TRANSPORT_LIMITS.maxHelloFrameBytes) return this.refuse(ws, CLOSE_AUTH, 'not a hello')
      let parsedJson: unknown
      try {
        parsedJson = JSON.parse(String(raw))
      } catch {
        if (!authed) return this.refuse(ws, CLOSE_AUTH, 'not a hello')
        return this.sendError(ws, null, { code: 'internal', message: 'Malformed JSON', retryable: false })
      }
      const frame = parseClientFrame(parsedJson)
      if (!frame.success) {
        if (!authed) return this.refuse(ws, CLOSE_AUTH, 'not a hello')
        // An answer to one of this host's calls that does not read still ends that call (#550), as the link client's does
        const f = parsedJson as { kind?: unknown; id?: unknown } | null
        const call = f?.kind === 'res' && typeof f.id === 'string' && bridgeOf === null && !limited ? this.calls.get(ws)?.get(f.id) : undefined
        if (call) return call.reject(rpcError('The other side answered in a form this host does not read'))
        return this.sendError(ws, null, { code: 'internal', message: 'Unknown frame', retryable: false })
      }

      if (frame.data.kind === 'prove') {
        /*
         * The hub asks this host to show it holds the token before it sends it (#838): the forward to a linked
         * machine listens on a loopback port another account can take first. Once per socket, before hello, and it
         * lets nothing in: the answer reveals the token to no one, and a hello must still follow.
         */
        if (authed) return
        if (proved) return this.refuse(ws, CLOSE_AUTH, 'not a hello')
        proved = true
        this.sendTo(ws, JSON.stringify({ kind: 'proof', nonce: frame.data.nonce, mac: hostProof(this.opts.token, frame.data.nonce) }))
        return
      }

      if (frame.data.kind === 'hello') {
        /*
         * A second hello on a socket that is already in is ignored (#82). Answering it replayed
         * the window again on the same socket — measured on main: two hellos with afterSeq 1
         * delivered seq 2 twice — and the client has no way to tell a repeat from new work.
         */
        if (authed) return
        if (!sameSecret(frame.data.token, this.opts.token)) {
          // Every process of this user but the window holds the limited credential (#1405, limited-token.ts)
          limited = isLimitedToken(this.opts.token, frame.data.token)
          // A Codex bridge holds a credential for its own session's calls only (bridge-token.ts)
          if (!limited) bridgeOf = bridgeSessionOf(this.opts.token, frame.data.token)
          if (!limited && bridgeOf === null) {
            this.refuse(ws, CLOSE_AUTH, 'bad token')
            return
          }
        }
        if (frame.data.protocolVersion !== PROTOCOL_VERSION) {
          this.sendError(ws, null, {
            code: 'version_mismatch',
            message: versionMismatchMessage(PROTOCOL_VERSION, frame.data.protocolVersion, this.opts.build?.version),
            retryable: false,
            /*
             * The same facts for a program to read (#82): a hub linking to this host shows the
             * version prompt from them (docs/plans/remote-hub.md §4) instead of parsing the sentence.
             */
            data: { protocolVersion: PROTOCOL_VERSION, ...(this.opts.build?.version ? { version: this.opts.build.version } : {}) },
          })
          this.refuse(ws, 4002, 'version mismatch')
          return
        }
        authed = true
        req.socket.off('data', countPreHello)
        clearTimeout(this.handshakeTimers.get(ws))
        this.handshakeTimers.delete(ws)
        /*
         * A bridge is not a client: it reads nothing but answers to its own calls, so it is never
         * added to the broadcast set and gets no replay. Every session's conversation, terminal
         * output and approval would otherwise reach whoever read the bridge's credential.
         */
        if (bridgeOf !== null) {
          this.sendTo(ws, this.helloOk(false))
          return
        }
        this.clients.add(ws)
        this.byClient.set(client, ws)
        label = frame.data.client?.trim().slice(0, 60) || null
        if (!limited && frame.data.shows?.includes(SHOWS_HOST_REQUESTS)) {
          this.showing.add(ws)
          this.opts.onShowing?.(this.showing.size)
        }
        this.greet(ws, frame.data.afterSeq ?? 0, frame.data.streamEpoch)
        return
      }

      if (!authed) {
        this.refuse(ws, CLOSE_AUTH, 'not authed')
        return
      }

      // The answer to a call this host sent a hub on this socket (#550); one it never sent is nobody's. A hub holds the token
      if (frame.data.kind === 'res') {
        if (bridgeOf === null && !limited) this.answered(ws, frame.data)
        return
      }

      // RPC
      const { method, params, id } = frame.data
      if (bridgeOf !== null) {
        const refusal = bridgeRefusal(bridgeOf, method, params)
        if (refusal !== null) return this.sendError(ws, id, { code: 'internal', message: refusal, retryable: false })
      }
      /*
       * The limited credential calls the everyday methods only (#1405, method-rights.ts). Checked here, before the
       * router, so a call naming a linked machine's session is judged on this host, where it started, and never relayed.
       */
      if (limited) {
        const refusal = limitedRefusal(method, params)
        // What cannot be undone waits for the person instead (host-requests.ts), and the call answers when they did
        if (refusal?.rights === 'asks' && this.opts.onAsk) {
          try {
            const result = await this.opts.onAsk(method, params, { client: label }, leaving.signal)
            this.sendTo(ws, JSON.stringify({ kind: 'res', id, ok: true, result }))
          } catch (err) {
            // A refusal says why in `data` (host-requests.ts): kept for a program to read
            const data: unknown = err !== null && typeof err === 'object' && 'data' in err ? err.data : undefined
            // An allowed call a swap refused or cut says "send it again", as any call does
            this.sendError(ws, id, { code: 'internal', message: errorMessage(err), retryable: err instanceof DrainCut, ...(data !== undefined ? { data } : {}) })
          }
          return
        }
        if (refusal !== null) {
          console.error(`[agent-host] refused ${JSON.stringify(method)} to a connection holding the limited credential (${refusal.rights})`)
          /*
           * `internal` with the reason in `data`, not a new error code: a reader from before #1405 parses the code
           * against its own list, and the refusal is a fact for a program to read, as `version_mismatch`'s data is
           */
          return this.sendError(ws, id, { code: 'internal', message: refusal.message, retryable: false, data: { refused: 'rights', rights: refusal.rights } })
        }
      }
      try {
        const run = () => this.opts.onRpc(method, params, { client, rights: limited ? 'limited' : 'full', label })
        const result = await (this.opts.drain ? this.opts.drain.track(`rpc ${method}`, run) : run())
        this.sendTo(ws, JSON.stringify({ kind: 'res', id, ok: true, result }))
      } catch (err) {
        const e = err as Error & { code?: unknown; retryable?: unknown; data?: unknown }
        this.sendError(ws, id, {
          code: errorCode(e.code),
          message: e.message ?? 'Unknown error',
          /*
           * A swap's refusal or cut says "send it again": the next host will take it (#280). So does
           * a call the hub could not pass to a linked machine because it is away (#82, links/router.ts),
           * which says which machine in `data`.
           */
          retryable: err instanceof DrainCut || e.retryable === true,
          ...(e.data !== undefined ? { data: e.data } : {}),
        })
      }
    })

    let gone = false
    const forget = () => {
      clearTimeout(this.handshakeTimers.get(ws))
      this.handshakeTimers.delete(ws)
      this.clients.delete(ws)
      if (this.showing.delete(ws)) this.opts.onShowing?.(this.showing.size)
      leaving.abort()
      if (this.byClient.get(client) === ws) this.byClient.delete(client)
      this.failCalls(ws, 'The connection ended before it answered')
      // 'error' is followed by 'close': said once
      if (!authed || gone) return
      gone = true
      this.opts.onClientGone?.(client)
    }
    ws.on('close', forget)
    ws.on('error', forget)
  }

  /**
   * Calls a client: a hub linked to this host that said it answers the reverse direction (#550, `host.hubOffer`,
   * docs/plans/remote-hub.md §12.7). The client is the `RpcContext.client` its offer came in on, so the call goes back
   * over the socket the hub opened, and nowhere else. Fails at once when that connection is gone; withdrawn with
   * `call.cancel` when `signal` fires, and when `timeoutMs` runs out (a call nobody answers is not held for good, and its
   * work on the other side, a card standing there, is not left waiting for nobody: #550 review).
   */
  call(client: number, method: string, params: unknown, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<unknown> {
    const ws = this.byClient.get(client)
    if (!ws || ws.readyState !== ws.OPEN) return Promise.reject(rpcError('That connection is not open', 'internal', { retryable: true }))
    if (opts.signal?.aborted) return Promise.reject(rpcError('The call was cancelled', 'internal'))
    const id = `h${++this.lastCall}`
    let pending = this.calls.get(ws)
    if (!pending) this.calls.set(ws, (pending = new Map()))
    const calls = pending
    return new Promise((resolve, reject) => {
      const done = () => {
        calls.delete(id)
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', onAbort)
      }
      // Withdrawn on the other side too: a call given up here must not leave its work there waiting for nobody
      const withdraw = () => this.sendTo(ws, JSON.stringify({ kind: 'rpc', id: `h${++this.lastCall}`, method: CANCEL_CALL_METHOD, params: { id } }))
      const onAbort = () => {
        if (!calls.has(id)) return
        done()
        withdraw()
        reject(rpcError('The call was cancelled', 'internal'))
      }
      const timer = setTimeout(() => {
        if (!calls.has(id)) return
        done()
        withdraw()
        reject(rpcError(`The other side did not answer ${method} in time`, 'internal', { retryable: true }))
      }, opts.timeoutMs ?? REVERSE_CALL_TIMEOUT_MS)
      calls.set(id, {
        resolve: (v) => {
          done()
          resolve(v)
        },
        reject: (e) => {
          done()
          reject(e)
        },
      })
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      if (!this.sendTo(ws, JSON.stringify({ kind: 'rpc', id, method, params }))) {
        done()
        reject(rpcError('That connection is not open', 'internal', { retryable: true }))
      }
    })
  }

  /** A client's answer to one of this host's calls (#550) */
  private answered(ws: WebSocket, a: RpcAnswer): void {
    const call = this.calls.get(ws)?.get(a.id)
    if (!call) return
    if (a.ok) return call.resolve(a.result)
    const e = a.error
    call.reject(rpcError(e?.message ?? 'The other side refused the call', e?.code ?? 'internal', { retryable: e?.retryable === true, ...(e?.data !== undefined ? { data: e.data } : {}) }))
  }

  /** Every call still waiting on a socket that is gone gets its answer: its outcome there is unknown */
  private failCalls(ws: WebSocket, why: string): void {
    const pending = this.calls.get(ws)
    if (!pending) return
    this.calls.delete(ws)
    for (const call of [...pending.values()]) call.reject(rpcError(why, 'internal', { retryable: false }))
  }

  private helloOk(resyncRequired: boolean): string {
    return JSON.stringify({
      kind: 'hello_ok',
      protocolVersion: PROTOCOL_VERSION,
      resyncRequired,
      currentSeq: this.log.currentSeq,
      streamEpoch: this.log.streamEpoch,
      ...(this.opts.build ? { build: this.opts.build } : {}),
      ...elevatedField(this.opts.elevated?.()),
      ...(this.opts.logon?.() ? { logon: this.opts.logon() } : {}),
      ...(this.opts.handover?.() ? { handover: this.opts.handover() } : {}),
    })
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
    const window = this.log.since(afterSeq, streamEpoch)
    const frames = window.events.map((e) => JSON.stringify({ kind: 'event', seq: e.seq, event: e.event }))
    let bytes = ws.bufferedAmount + wireBytes(this.helloOk(window.resyncRequired))
    for (const f of frames) bytes += wireBytes(f)
    if (bytes > this.limits.replayBudgetBytes) {
      this.sendTo(ws, this.helloOk(true))
      return
    }
    this.sendTo(ws, this.helloOk(window.resyncRequired))
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

/**
 * What to do about a taken port. Under `centralu serve` (#482) the developer's advice (`lsof`, `pnpm
 * host`) means nothing, and on a Windows laptop the holder is often WSL2's relay for a host inside
 * a distro: say so, and how to pick another port
 */
export function portInUseMessage(port: number, servedBy?: 'serve'): string {
  if (servedBy === 'serve') {
    return (
      `Port ${port} is already in use.\n` +
      `  · Another program listens on 127.0.0.1:${port}; on Windows this is often WSL (wslrelay.exe) relaying a Centralu inside a distro\n` +
      `  · To use another port: centralu serve --port <n> (it is kept for the next start)`
    )
  }
  return (
    `Port ${port} is already in use.\n` +
    `  · If a host is already running, just use it (start only the UI)\n` +
    `  · To clean up a leftover process: lsof -ti:${port} | xargs kill\n` +
    `  · To use another port: pnpm host --port ${port + 1}`
  )
}
