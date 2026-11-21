import { WebSocketServer, type RawData, type WebSocket } from 'ws'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import {
  CALL_HOLD_MAX_MS,
  CANCEL_CALL_METHOD,
  HOLD_CALL_METHOD,
  HoldCallParams,
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
import { conditionalRight, limitedRefusal, type RightsHost } from './method-rights.js'
import { sessionOfToken } from './session-token.js'
import { credentialProof, hostProof } from './host-proof.js'
import { isFullCredential, isHandoverCredential, type CredentialsRead, type FullCredential, type KeyCredential } from '../lifecycle/serve-credentials.js'
import { LINK_AUTH_MARKER } from './link-keys.js'
import { answerKeyProve, HostSigningKey, linkAddressOf, verifyKeyHello, type KeyProve } from './link-proof.js'
import { DrainCut, type Drain } from '../drain.js'
import { peerAnswer, rpcError } from '../rpc-error.js'
import { durationText } from '../timing.js'

/** The WS server (docs/protocol.md §1), identical in dev and prod; loopback binding plus a token handshake generated at startup */
/**
 * Which connection a call came in on. `client` is a number the server gives each socket once its hello is accepted, never
 * reused in one host's life; what a window holds while it stays (a leased app view, #392) is tied to it and let go when
 * `onClientGone` names it
 */
export type RpcContext = {
  client: number
  /**
   * What the socket said hello with (#1405): `full`, the host's token (a window, or a hub linked to this host), or `limited`, the
   * limited credential (`limited-token.ts`) every other process of this user holds. A limited call reaches the handler only when
   * `method-rights.ts` lets it; a bridge's calls carry `full`, as what it may call is already narrowed to its session's tool
   * channel (`bridgeRefusal`)
   */
  rights: 'full' | 'limited'
  /**
   * What the program called itself in its hello (#1405), cut and never checked; null when it said nothing. A header or screen
   * takes it through `scriptLabel`
   */
  label?: string | null
  /**
   * A limited call that ran with no card because a conditional right let it through (#1508, method-rights.ts `{ asks, when }`),
   * judged once in the transport; never set on a call the person allowed on a card nor on a full one
   */
  covered?: boolean
  /**
   * The session whose credential the socket said hello with (#1405, session-token.ts): attribution for a card, never a right;
   * absent for the token and the plain limited credential
   */
  session?: string
  /**
   * The person's own window made the call (#1143): a socket in with a full credential that shows the person's cards
   * (`SHOWS_HOST_REQUESTS`). A hub, a bridge or the limited credential never does
   */
  window?: true
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
 * `CC_HOST_ALLOWED_ORIGINS` (comma-separated) overrides allowedOrigins: the default list is only the dev ports and Tauri
 * WebView, and a connection from elsewhere (vite on another port, a reverse proxy) is blocked with nothing on screen but
 * `Disconnected`. An empty value is "not configured", not an override: passed through it would make an empty allow list and no
 * one could connect, over one typo. Whitespace-only entries are dropped too, as an empty string means "no Origin header" to
 * `originAllowed` and must never be in the list
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
  /**
   * The host's token: what a full hello says and the key everything handed out derives from (the limited credential, a bridge's,
   * the proof). With `fullCredentials` (a `centralu serve` host, #1405) it is only the key: a hello with it is not full, and the
   * full ones are those the callback names
   */
  token: string
  /**
   * The full credentials of a `centralu serve` host (#1405, lifecycle/serve-credentials.ts): their verifiers, asked at each hello
   * and each `prove` naming one, so a pairing or revocation applies at once. A whole read (`readCredentialFile`) also says what a
   * socket already in may keep while the file cannot be read, and that it cannot
   */
  fullCredentials?: () => readonly FullCredential[] | CredentialsRead
  /**
   * How often the full credentials are read again while a socket holds one (#1405): a socket whose credential is no longer listed
   * is closed then, so a revocation ends an open connection, not only the next hello. 1 s when absent
   */
  credentialSweepMs?: number
  /**
   * A hello with one of the full credentials `fullCredentials` names, or under one of its key entries (#1711), is about to be let
   * in (`UsedCredentials`; #1712). Called before the socket has rights, once the hello is whole (a refused one is not reported),
   * and never waited on beyond the call: it writes down what it keeps and tells the hubs without waiting (`tellHubs`). A throw is
   * said and the hello goes on
   */
  onFullHello?: (credential: FullCredential | KeyCredential) => void
  /**
   * The front door's address when a keeper runs this host (`CC_FRONT_DOOR`, #1711): what a key `prove` signs, as the socket then
   * comes from the door's relay on the inner port. Absent: the socket's own local address
   */
  frontDoor?: string
  onRpc: RpcHandler
  allowedOrigins?: readonly string[]
  /**
   * The HTTP door on the same port; every route sits behind a secret path fresh for the run (http.ts). Without one every HTTP
   * request is a 404; WebSocket upgrades follow their own rule
   */
  http?: HttpGate
  /**
   * How long a socket may stay connected without a valid hello (#82); until then it holds a socket, a timer and a slot in the
   * http server's connection list for nothing
   */
  handshakeTimeoutMs?: number
  /**
   * How many sockets may wait for their hello at once; a new upgrade past this is refused with a 503, so silent connections
   * cannot each hold a slot for the whole handshake deadline
   */
  maxPendingHandshakes?: number
  /** The largest frame a socket may send once it has said hello, as bytes of payload. Defaults to `TRANSPORT_LIMITS.maxFrameBytes` */
  maxFrameBytes?: number
  /** The undrained backlog a peer may leave on one socket before it is cut (#82); `sendTo` says why the rule is "already over the bound" */
  maxBufferedBytes?: number
  /**
   * The largest replay one hello may start, as bytes on the wire with WebSocket framing (#82); a bigger one is answered with a
   * resync. Clamped to `maxBufferedBytes` so a replay cannot trip the outbound bound by itself
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
  /** The turns this host continues because an update cut them, taken up at its start, read at every `hello_ok` (#1618) */
  updateContinued?: () => { sessionId: string; at: number }[]
  /** A connection that passed hello has ended (its `RpcContext.client`) */
  onClientGone?: (client: number) => void
  /**
   * A call made with the limited credential that asks the person (#1405, `asks` in method-rights.ts): what answers it after the
   * person did (host-requests.ts). `from.client` is what the program called itself, `signal` fires when its socket goes. Without
   * it such a call is refused
   */
  onAsk?: (method: string, params: unknown, from: { client: string | null; session?: string }, signal: AbortSignal) => Promise<unknown>
  /** The host's state a conditional right reads (method-rights.ts `RightsHost`); without it every such call asks */
  rightsHost?: RightsHost
  /**
   * Whether a session id is one of this host's (#1405): a session credential naming an unknown one is refused at hello; without
   * it any well-formed one is taken
   */
  knowsSession?: (sessionId: string) => boolean
  /** How many windows that show host requests are attached, each time it changes (#1405, `HostRequests.showingChanged`) */
  onShowing?: (count: number) => void
  /**
   * Tracks every RPC for a stop that drains first (`host.stop {ifIdle}`, drain.ts): once the drain begins new RPCs are refused
   * and running ones get its bound; refused and cut calls are `retryable: true`, as the same call reaches the next host
   */
  drain?: Drain
}

/**
 * Transport bounds (#82): what one socket can make the host hold, not a process-wide quota. Outbound 64 MiB: the host sends
 * single frames in the tens of megabytes (a diff up to the 32 MiB output buffer of its VCS calls, an image event up to 8 MiB of
 * base64), and a backlog above it is a peer that stopped reading (a suspended WebView, a hung client), which grew without limit
 * (99.5 MB after 1,000 broadcasts of 100 kB to a paused peer). Replay budget 16 MiB: above it a snapshot reload is cheaper and
 * as correct, and it keeps a reconnect burst well under the outbound bound
 */
export const TRANSPORT_LIMITS = {
  handshakeTimeoutMs: 10_000,
  maxPendingHandshakes: 16,
  /**
   * The largest frame after hello: the library's default (100 MiB) set so it is a decision; a call carries a file as one base64
   * string and bigger files have always worked. Before hello a socket gets much less (`maxHelloFrameBytes`)
   */
  maxFrameBytes: 100 * 1024 * 1024,
  /**
   * What a socket may send before hello (a token and two numbers), counted as bytes read from the socket (`onConnection`) so a
   * frame cannot be buffered whole first, and as the size of the one frame allowed
   */
  maxHelloFrameBytes: 64 * 1024,
  maxBufferedBytes: 64 * 1024 * 1024,
  replayBudgetBytes: 16 * 1024 * 1024,
  closeGraceMs: 250,
} as const

/** What the pre-hello byte count allows beyond the one frame: its WebSocket header, and the bytes of a close it may answer */
const PRE_HELLO_SLACK_BYTES = 1024

type ReverseCall = { resolve: (v: unknown) => void; reject: (e: Error) => void; hold: (held: boolean) => void }

export const REVERSE_CALL_TIMEOUT_MS = 30 * 60_000

const CLOSE_GOING_AWAY = 1001
const CLOSE_AUTH = 4001
/**
 * Why a full hello is refused, or a socket in with a full credential closed, while `serve.json` cannot be read (#1405): not
 * "withdrawn", which a hub takes for its credential gone, and not "bad token"
 */
export const CREDENTIAL_FILE_UNREADABLE = 'credential file unreadable'

function elevatedField(elevated: boolean | null | undefined): { elevated?: boolean } {
  return typeof elevated === 'boolean' ? { elevated } : {}
}

function rawBytes(raw: RawData): number {
  if (Array.isArray(raw)) return raw.reduce((n, b) => n + b.length, 0)
  return raw.byteLength
}

/** Bytes a server-to-client frame adds around its payload (RFC 6455 §5.2, unmasked): a client's carry 4 more, so this undercounts incoming bytes */
function frameOverhead(payloadBytes: number): number {
  return payloadBytes < 126 ? 2 : payloadBytes < 65_536 ? 4 : 10
}

function wireBytes(frame: string): number {
  const n = Buffer.byteLength(frame)
  return n + frameOverhead(n)
}

export class HostServer {
  readonly log: EventLog
  private wss: WebSocketServer
  private http: Server
  private clients = new Set<WebSocket>()
  private showing = new Set<WebSocket>()
  private lastClient = 0
  private handshakeTimers = new Map<WebSocket, ReturnType<typeof setTimeout>>()
  /**
   * The sockets in with one of a `centralu serve` host's full credentials, by its id (#1405); closed once it is no longer listed
   * (`sweepWithdrawn`)
   */
  private fullBy = new Map<WebSocket, { id: string; publicKey?: string }>()
  private hubLinks = new Set<WebSocket>()
  private readonly signing: HostSigningKey
  private sweepTimer: ReturnType<typeof setInterval> | undefined
  private byClient = new Map<number, WebSocket>()
  private calls = new Map<WebSocket, Map<string, ReverseCall>>()
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
   * Rejected origins already logged, so a message does not repeat every 5 seconds (see `verifyClient`). Capped: its keys are the
   * Origin header, chosen from outside, and unbounded they would let anyone on loopback grow the host's memory with a new Origin
   * each time, no token needed. Past 64 distinct origins (never in normal use) the set is cleared, which costs one extra log line
   */
  private readonly loggedRejections = new Set<string>()
  private static readonly MAX_LOGGED_REJECTIONS = 64

  constructor(private opts: HostServerOptions) {
    /*
     * A whitespace-only token is not a credential, as the browser treats it: apps/web/src/bootstrap.ts trims VITE_HOST_TOKEN and
     * throws MissingHostTokenError when empty. With no trim here, `CC_HOST_TOKEN=" "` split the two sides (reproduced): the host
     * listened with " " as the secret, which a few guesses would have opened, while the UI sent '' and never connected
     */
    if (!opts.token.trim()) throw rpcError('Host token must not be empty')
    this.signing = new HostSigningKey(opts.token)
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
    if (opts.fullCredentials) {
      this.sweepTimer = setInterval(() => {
        const read = this.credentialRead()
        if (this.fullBy.size > 0 && read) this.sweepWithdrawn(read)
      }, opts.credentialSweepMs ?? 1000)
      this.sweepTimer.unref?.()
    }
    this.log = new EventLog(2000, this.limits.replayBudgetBytes)
    this.http = createServer(createHttpHandler(opts.http))
    this.wss = new WebSocketServer({
      server: this.http,
      // A frame over this closes the socket with 1009 before it is handed to us
      maxPayload: this.limits.maxFrameBytes,
      verifyClient: (info, done) => {
        if (this.handshakeTimers.size >= this.limits.maxPendingHandshakes) return done(false, 503, 'too many connections waiting for hello')
        const origin = info.req.headers.origin
        const ok = this.originAllowed(origin)
        /*
         * The rejection is logged, once per origin: the browser never hands the upgrade's 403 to the page, so the screen shows
         * `Disconnected` and keeps retrying, like a host that is off, and the logged origin tells the person what to put in
         * CC_HOST_ALLOWED_ORIGINS. rpc-client's backoff caps at 5 s (web/rpc-client.ts), so every line would repeat 700 times an hour
         * in the host.log people attach to bug reports
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
    // ws re-emits http server errors on its own instance: unhandled here, the process dies
    this.wss.on('error', (err) => this.listenError?.(err))
  }

  /**
   * The origin boundary (docs/security-boundaries/local-data-and-transport.md "Local transport"). A missing or empty Origin is
   * let through on purpose: a browser always sends Origin on a cross-origin request, so none means a native client (a non-Tauri
   * path, a test's ws client, curl), which origin cannot block and loopback binding plus the token handshake already do;
   * rejecting it would block only our own tests and sidecars. The string `'null'` is a present Origin (a sandbox iframe or
   * file:// page sends it), so it is blocked explicitly. server.test.ts pokes at 10 kinds of origin: the 7 allowed, none,
   * `http://evil.example` and `'null'`
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
   * Closing. Iterates `wss.clients`, not `this.clients`, which holds only sockets that passed hello: a socket that finished the
   * upgrade without authenticating is still a live connection to the http server, and unclosed it never lets `http.close()` call
   * back (measured: one silent socket and close() waited past 5 s, `wss.clients` finished in 2 ms; in tests disabling the origin
   * check left two sockets open and `afterEach` took 10 s each, a file from 644 ms to 20.54 s). Every connection gets a deadline
   * (#82), as two more hangs were measured at 3 s and more: a peer that never answers the close frame (a suspended WebView; `ws`
   * waits 30 s, past the desktop supervisor's 3 s budget, after which the host is SIGKILLed mid-cleanup) and a raw HTTP
   * connection holding a half-sent request (`http.close()` drops only idle ones). So the close frame goes out, a peer gets
   * `closeGraceMs` to answer, then the socket is cut, and plain HTTP connections are dropped. A second close() returns the same
   * promise
   */
  close(): Promise<void> {
    this.closing ??= this.shutdown()
    return this.closing
  }

  private async shutdown(): Promise<void> {
    clearInterval(this.sweepTimer)
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

  broadcast(event: NormalizedEvent): void {
    const body = JSON.stringify(event)
    const entry = this.log.append(event, body.length)
    const frame = `{"kind":"event","seq":${entry.seq},"event":${body}}`
    for (const ws of this.clients) this.sendTo(ws, frame)
  }

  /**
   * Tells the hubs linked to this host (sockets in with a full credential labelled `hub:`) of an event and no one else (#1712).
   * It is kept with the others, so a hub that comes back asking for what it missed finds it in the replay (to a hub's link alone,
   * `greet`). Never waits: a frame is queued on each socket and a peer that stopped reading is cut (`sendTo`) as for any event
   */
  tellHubs(event: NormalizedEvent): void {
    const body = JSON.stringify(event)
    const entry = this.log.append(event, body.length)
    const frame = `{"kind":"event","seq":${entry.seq},"event":${body}}`
    for (const ws of this.hubLinks) this.sendTo(ws, frame)
  }

  /** The connections that receive events: windows and a hub linked to this host (the token), and the limited credential's (#1405); never a bridge */
  get clientCount(): number {
    return this.clients.size
  }

  showsHostRequests(): boolean {
    return this.showing.size > 0
  }

  get streamEpoch(): string {
    return this.log.streamEpoch
  }

  /**
   * Pushes terminal output outside the event log: its volume is orders of magnitude above conversation events, and anything
   * missed arrives whole from the host's scrollback on reconnect
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
   * The one way a frame leaves this server (#82). A peer whose backlog is already above `maxBufferedBytes` has stopped reading
   * and is cut (terminate: a close frame would queue behind the backlog); it reconnects and gets a replay or resync, and the
   * host's agents never wait on it. "Already above" rather than "this frame would cross it", as the host sends single frames in
   * the tens of megabytes (`TRANSPORT_LIMITS`) and refusing one would cut a healthy reader: what is bounded is the backlog plus
   * one frame
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
   * Closes a socket that is not in: the close frame goes out so the peer sees why, and a peer that does not answer is cut after
   * the grace; `ws.close()` alone waits up to 30 s with the slot taken
   */
  /**
   * Closes every socket in with a full credential `full` no longer names (#1405): a revocation (`serve --revoke`, a replacing
   * pairing, `--rotate-token`, the file moved aside) ends open connections too. The peer sees 4001 "credential withdrawn", and a
   * hub reads its connection line again and pairs anew
   */
  private sweepWithdrawn(read: CredentialsRead): void {
    for (const [ws, held] of this.fullBy) {
      /*
       * A socket in under a key entry stays while an entry with its id and its public key is listed (#1711, §4.4): an entry reusing
       * the id under another key does not keep it full
       */
      const still = held.publicKey === undefined
        ? read.open.some((c) => c.id === held.id)
        : (read.openKeys ?? []).some((k) => k.id === held.id && k.publicKey === held.publicKey)
      if (still) continue
      this.fullBy.delete(ws)
      this.hubLinks.delete(ws)
      /*
       * A file that cannot be read withdrew nothing (#1405): said as that, so a hub does not take its own credential for taken over,
       * and its row can say why
       */
      this.refuse(ws, CLOSE_AUTH, read.unreadable ? CREDENTIAL_FILE_UNREADABLE : 'credential withdrawn')
    }
  }

  private credentialRead(): CredentialsRead | null {
    const r = this.opts.fullCredentials?.()
    if (!r) return null
    if ('unreadable' in r) return r
    return { full: [...r], open: [...r], unreadable: null, keys: [], openKeys: [] }
  }

  private refuse(ws: WebSocket, code: number, reason: string): void {
    ws.close(code, reason)
    setTimeout(() => ws.terminate(), this.limits.closeGraceMs).unref()
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    let authed = false
    let bridgeOf: string | null = null
    let limited = false
    let session: string | undefined
    let label: string | null = null
    const leaving = new AbortController()
    let proved = false
    let keyProve: KeyProve | null = null
    const client = ++this.lastClient
    // Its slot is given back when it is gone ('close' below), not before
    this.handshakeTimers.set(
      ws,
      setTimeout(() => {
        if (!authed) this.refuse(ws, CLOSE_AUTH, 'auth timeout')
      }, this.limits.handshakeTimeoutMs),
    )
    /*
     * Until hello, what the socket sends is counted as it is read and a socket past the bound is cut: the message handler sees a
     * frame only once whole, too late for a peer announcing and sending tens of megabytes
     */
    let preHelloBytes = 0
    const countPreHello = (chunk: Buffer) => {
      preHelloBytes += chunk.length
      if (preHelloBytes > TRANSPORT_LIMITS.maxHelloFrameBytes + PRE_HELLO_SLACK_BYTES) req.socket.destroy()
    }
    req.socket.on('data', countPreHello)

    ws.on('message', async (raw) => {
      /*
       * Until hello is accepted a socket is allowed one small frame, and it must be a hello; anything else (too big, not JSON, not a
       * protocol frame, an RPC) closes it so it holds no slot while it tries other things. The size is checked before JSON.parse,
       * which would build the whole value first
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
        const f = parsedJson as { kind?: unknown; id?: unknown } | null
        const call = f?.kind === 'res' && typeof f.id === 'string' && bridgeOf === null && !limited ? this.calls.get(ws)?.get(f.id) : undefined
        if (call) return call.reject(rpcError('The other side answered in a form this host does not read'))
        return this.sendError(ws, null, { code: 'internal', message: 'Unknown frame', retryable: false })
      }

      if (frame.data.kind === 'prove') {
        /*
         * The hub asks this host to show it holds the token before sending it (#838): the forward to a linked machine listens on a
         * loopback port another account can take first. Once per socket, before hello, and it lets nothing in: the answer reveals the
         * token to no one, and a hello must still follow
         */
        if (authed) return
        if (proved) return this.refuse(ws, CLOSE_AUTH, 'not a hello')
        proved = true
        const ask = frame.data
        const read = this.credentialRead()
        /*
         * A hub that paired by key names its key entry (#1711, docs/plans/key-pairing.md §4.3): this host signs the transcript with a
         * nonce of its own for this socket. A serve host only: another holds no key entries and answers as an older host does
         */
        if (ask.key !== undefined && read) {
          const answer = answerKeyProve({
            signing: this.signing,
            nonce: ask.nonce,
            keyId: ask.key,
            entry: (read.openKeys ?? []).find((k) => k.id === ask.key),
            address: linkAddressOf(this.opts.frontDoor, req.socket.localAddress, req.socket.localPort),
          })
          // Malformed: no answer at all, never the proof under the key (§9). No entry: as for a verifier entry gone, the hub pairs anew
          if ('refused' in answer) return this.refuse(ws, CLOSE_AUTH, answer.refused === 'withdrawn' ? 'credential withdrawn' : 'not a hello')
          keyProve = answer.pending
          this.sendTo(ws, JSON.stringify({ kind: 'proof', nonce: ask.nonce, mac: hostProof(this.opts.token, ask.nonce), ...answer.fields }))
          return
        }
        // From `open`, not `full`: while serve.json cannot be read `full` is empty and `open` keeps the last list, so a paired hub still
        // gets a correct proof and its hello is refused as "credential file unreadable", not taken for an impostor. A proof lets nothing in
        const named = ask.credential ? read?.open.find((c) => c.id === ask.credential) : undefined
        const mac = named ? credentialProof(named.verifier, ask.nonce) : hostProof(this.opts.token, ask.nonce)
        this.sendTo(ws, JSON.stringify({ kind: 'proof', nonce: ask.nonce, mac }))
        return
      }

      if (frame.data.kind === 'hello') {
        /*
         * A second hello on a socket already in is ignored (#82): answering replayed the window on the same socket (measured: two
         * hellos with afterSeq 1 delivered seq 2 twice), and the client cannot tell a repeat from new work
         */
        if (authed) return
        // What a key `prove` left is used by this hello or by none (#1711, §9 item 4): a failed hello is not followed by another on the same nonces
        const proven = keyProve
        keyProve = null
        const listed = this.credentialRead()
        /*
         * A key hello (#1711, §4.3): the token is the fixed marker, and it is full only under the key entry its `prove` named, with the
         * hub's signature over the transcript that `prove` began. The marker with anything less is refused, neither full nor limited.
         * An `auth` beside any other token is ignored: it never upgrades a limited or a verifier hello (§9 item 3)
         */
        const byKey = frame.data.token === LINK_AUTH_MARKER
        const keyMatch = byKey && listed ? verifyKeyHello({ signing: this.signing, pending: proven, auth: frame.data.auth, keys: listed.keys ?? [] }) : null
        const match = listed && !byKey ? isFullCredential(listed.full, frame.data.token) : null
        const full = byKey ? keyMatch !== null : listed ? match !== null : sameSecret(frame.data.token, this.opts.token)
        if (listed) this.sweepWithdrawn(listed)
        if (byKey && !full) return this.refuse(ws, CLOSE_AUTH, listed?.unreadable ? CREDENTIAL_FILE_UNREADABLE : 'bad token')
        if (!full) {
          limited = isLimitedToken(this.opts.token, frame.data.token)
          /*
           * An older launcher's one-call hand-over credential is limited too (#1711, §4.4): `host.handover` is everyday now, and such a
           * credential went to whatever answered the proof under the key
           */
          if (!limited && listed) limited = isHandoverCredential(listed.full, frame.data.token) !== null
          if (!limited) {
            const of = sessionOfToken(this.opts.token, frame.data.token)
            if (of !== null && (this.opts.knowsSession?.(of) ?? true)) {
              limited = true
              session = of
            }
          }
          if (!limited) bridgeOf = bridgeSessionOf(this.opts.token, frame.data.token)
          if (!limited && bridgeOf === null) {
            this.refuse(ws, CLOSE_AUTH, listed?.unreadable ? CREDENTIAL_FILE_UNREADABLE : 'bad token')
            return
          }
        }
        if (frame.data.protocolVersion !== PROTOCOL_VERSION) {
          this.sendError(ws, null, {
            code: 'version_mismatch',
            message: versionMismatchMessage(PROTOCOL_VERSION, frame.data.protocolVersion, this.opts.build?.version),
            retryable: false,
            /*
             * The same facts for a program to read (#82): a hub linking to this host shows the version prompt from them
             * (docs/plans/remote-hub.md §4) instead of parsing the sentence
             */
            data: { protocolVersion: PROTOCOL_VERSION, ...(this.opts.build?.version ? { version: this.opts.build.version } : {}) },
          })
          this.refuse(ws, 4002, 'version mismatch')
          return
        }
        /*
         * A full credential is written down before the socket gets its rights (#1712): once `authed` is set nothing of this hello can
         * be undone by a stop of the host
         */
        const entered = match ?? keyMatch
        if (entered) {
          try {
            this.opts.onFullHello?.(entered)
          } catch (e) {
            console.error(`[agent-host] a full hello could not be recorded: ${e instanceof Error ? e.message : String(e)}`)
          }
        }
        authed = true
        req.socket.off('data', countPreHello)
        clearTimeout(this.handshakeTimers.get(ws))
        this.handshakeTimers.delete(ws)
        /*
         * A bridge is not a client: it reads nothing but answers its own calls, so it is never in the broadcast set and gets no replay,
         * which would give every session's conversation, terminal output and approvals to whoever read the bridge's credential
         */
        if (bridgeOf !== null) {
          this.sendTo(ws, this.helloOk(false))
          return
        }
        this.clients.add(ws)
        this.byClient.set(client, ws)
        if (match) {
          this.fullBy.set(ws, { id: match.id })
          if (match.label.startsWith('hub:')) this.hubLinks.add(ws)
        }
        if (keyMatch) {
          this.fullBy.set(ws, { id: keyMatch.id, publicKey: keyMatch.publicKey })
          if (keyMatch.label.startsWith('hub:')) this.hubLinks.add(ws)
        }
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

      if (frame.data.method === HOLD_CALL_METHOD) {
        const hold = HoldCallParams.safeParse(frame.data.params)
        if (hold.success && bridgeOf === null && !limited) this.calls.get(ws)?.get(hold.data.id)?.hold(hold.data.held)
        this.sendTo(ws, JSON.stringify({ kind: 'res', id: frame.data.id, ok: true, result: { ok: true } }))
        return
      }

      const { method, params, id } = frame.data
      if (bridgeOf !== null) {
        const refusal = bridgeRefusal(bridgeOf, method, params)
        if (refusal !== null) return this.sendError(ws, id, { code: 'internal', message: refusal, retryable: false })
      }
      /*
       * The limited credential calls the everyday methods only (#1405, method-rights.ts), checked before the router so a call naming
       * a linked machine's session is judged on this host, where it started, and never relayed
       */
      if (limited) {
        const refusal = limitedRefusal(method, params, this.opts.rightsHost ?? null)
        if (refusal?.rights === 'asks' && this.opts.onAsk) {
          try {
            const result = await this.opts.onAsk(method, params, { client: label, ...(session ? { session } : {}) }, leaving.signal)
            this.sendTo(ws, JSON.stringify({ kind: 'res', id, ok: true, result }))
          } catch (err) {
            const data: unknown = err !== null && typeof err === 'object' && 'data' in err ? err.data : undefined
            this.sendError(ws, id, { code: 'internal', message: errorMessage(err), retryable: err instanceof DrainCut, ...(data !== undefined ? { data } : {}) })
          }
          return
        }
        if (refusal !== null) {
          console.error(`[agent-host] refused ${JSON.stringify(method)} to a connection holding the limited credential (${refusal.rights})${method === 'host.systemEnding' ? ': a launcher older than this host sends the system-ending notice with it, so that end is not noted until the launcher is updated (#1970)' : ''}`)
          /*
           * `internal` with the reason in `data`, not a new code: a reader from before #1405 parses the code against its own list, and
           * the refusal is a fact for a program to read, as `version_mismatch`'s data is
           */
          return this.sendError(ws, id, { code: 'internal', message: refusal.message, retryable: false, data: { refused: 'rights', rights: refusal.rights } })
        }
      }
      try {
        const covered = limited && conditionalRight(method)
        const run = () => this.opts.onRpc(method, params, { client, rights: limited ? 'limited' : 'full', label, ...(covered ? { covered: true } : {}), ...(session ? { session } : {}), ...(this.showing.has(ws) ? { window: true as const } : {}) })
        const result = await (this.opts.drain ? this.opts.drain.track(`rpc ${method}`, run) : run())
        this.sendTo(ws, JSON.stringify({ kind: 'res', id, ok: true, result }))
      } catch (err) {
        const e = err as Error & { code?: unknown; retryable?: unknown; data?: unknown }
        this.sendError(ws, id, {
          code: errorCode(e.code),
          message: e.message ?? 'Unknown error',
          /*
           * A swap's refusal or cut says "send it again", as the next host takes it (#280); so does a call a hub could not pass to a
           * linked machine that is away (#82, links/router.ts), naming the machine in `data`
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
      this.fullBy.delete(ws)
      this.hubLinks.delete(ws)
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
   * docs/plans/remote-hub.md §12.7). The client is the `RpcContext.client` its offer came in on, so the call goes back over the
   * socket the hub opened. Fails at once when that connection is gone; withdrawn with `call.cancel` when `signal` fires or
   * `timeoutMs` runs out, so a card standing on the other side is not left waiting for nobody. The hub may hold the limit while
   * what the call waits on is out of the person's sight (`call.hold`, #2271): time stops while held and resumes with what was
   * left; held `holdMaxMs` in all (`CALL_HOLD_MAX_MS`) it is withdrawn as out of time. A held call still ends when its socket
   * goes or `signal` fires
   */
  call(client: number, method: string, params: unknown, opts: { timeoutMs?: number; signal?: AbortSignal; holdMaxMs?: number } = {}): Promise<unknown> {
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
      const withdraw = () => this.sendTo(ws, JSON.stringify({ kind: 'rpc', id: `h${++this.lastCall}`, method: CANCEL_CALL_METHOD, params: { id } }))
      const onAbort = () => {
        if (!calls.has(id)) return
        done()
        withdraw()
        reject(rpcError('The call was cancelled', 'internal'))
      }
      const expire = (why: string) => () => {
        if (!calls.has(id)) return
        done()
        withdraw()
        reject(rpcError(why, 'internal', { retryable: true }))
      }
      const late = expire(`The other side did not answer ${method} in time`)
      let left = opts.timeoutMs ?? REVERSE_CALL_TIMEOUT_MS
      let heldFor = 0
      let held = false
      let since = Date.now()
      let timer = setTimeout(late, left)
      const hold = (h: boolean) => {
        if (h === held || !calls.has(id)) return
        const now = Date.now()
        clearTimeout(timer)
        if (h) left -= now - since
        else heldFor += now - since
        held = h
        since = now
        const holdMax = opts.holdMaxMs ?? CALL_HOLD_MAX_MS
        timer = h
          ? setTimeout(expire(`The other side held ${method} longer than ${durationText(holdMax)}`), Math.max(0, holdMax - heldFor))
          : setTimeout(late, Math.max(0, left))
      }
      calls.set(id, {
        resolve: (v) => {
          done()
          resolve(v)
        },
        reject: (e) => {
          done()
          reject(e)
        },
        hold,
      })
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      if (!this.sendTo(ws, JSON.stringify({ kind: 'rpc', id, method, params }))) {
        done()
        reject(rpcError('That connection is not open', 'internal', { retryable: true }))
      }
    })
  }

  private answered(ws: WebSocket, a: RpcAnswer): void {
    const call = this.calls.get(ws)?.get(a.id)
    if (!call) return
    if (a.ok) return call.resolve(a.result)
    const e = a.error
    call.reject(peerAnswer(rpcError(e?.message ?? 'The other side refused the call', e?.code ?? 'internal', { retryable: e?.retryable === true, ...(e?.data !== undefined ? { data: e.data } : {}) })))
  }

  /** Every call still waiting on a socket that is gone is answered, not retryable: its outcome there is unknown, and a retry could run it twice */
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
      ...(this.opts.updateContinued ? { updateContinued: this.opts.updateContinued() } : {}),
    })
  }

  /**
   * `hello_ok` and the replay of what was missed (docs/protocol.md §1), sent in one go so no broadcast slips in between. The
   * whole replay is priced before any is sent (#82): one that would not fit the budget is not started, and the client gets
   * `resyncRequired` with the current seq and reloads its snapshot. Starting it and cutting the socket halfway would leave the
   * cursor where it was, and the next reconnect would ask for the same oversized window, a loop that never converges (the
   * livelock the review of #91 found; measured: a 2,000 x 50 kB history replayed to a stalled peer left 99.6 MB buffered)
   */
  private greet(ws: WebSocket, afterSeq: number, streamEpoch: string | undefined): void {
    const window = this.log.since(afterSeq, streamEpoch)
    const hub = this.hubLinks.has(ws)
    const frames = window.events.filter((e) => hub || e.event.type !== 'host_credential_used').map((e) => JSON.stringify({ kind: 'event', seq: e.seq, event: e.event }))
    let bytes = ws.bufferedAmount + wireBytes(this.helloOk(window.resyncRequired))
    for (const f of frames) bytes += wireBytes(f)
    if (bytes > this.limits.replayBudgetBytes) {
      this.sendTo(ws, this.helloOk(true))
      return
    }
    this.sendTo(ws, this.helloOk(window.resyncRequired))
    for (const f of frames) this.sendTo(ws, f)
  }

  private sendError(ws: WebSocket, id: string | null, error: ProtocolError): void {
    this.sendTo(ws, JSON.stringify({ kind: 'res', id: id ?? '0', ok: false, error }))
  }
}


/**
 * The refusal a client of another protocol gets (#82), worded for the person who must act: with a host on another machine
 * (`centralu serve`) the two update separately, so it says which is behind. The client shows it as is, and `centralu serve
 * --connection` reads the host's number back from either wording (`mismatchServerVersion` in
 * packaging/npm/centralu/bin/serve.mjs), so "host speaks protocol N" stays
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
 * Only a code the protocol knows goes out (dogfooding, 2026-09-10). Most failures here are Node's own (`fs.stat` with `code:
 * 'ENOENT'`, `spawn` `'EACCES'`); in the envelope as is, that string is not in the protocol enum and the client drops the whole
 * frame, so the view waiting on the call sat on "loading" until the 30-second timeout (a file link showed a blank screen). An
 * unrecognized code becomes `internal`, and the message still carries the explanation
 */
function errorCode(raw: unknown): ProtocolError['code'] {
  const known = ProtocolErrorCode.safeParse(raw)
  return known.success ? known.data : 'internal'
}

/**
 * What to do about a taken port: under `centralu serve` (#482) the developer's advice (`lsof`, `pnpm host`) means nothing, and
 * on a Windows laptop the holder is often WSL2's relay for a host inside a distro; say so, and how to pick another port
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
