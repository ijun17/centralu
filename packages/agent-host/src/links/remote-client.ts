import WebSocket from 'ws'
import { CANCEL_CALL_METHOD, HostBuild, PROTOCOL_VERSION, ProtocolError, ProtocolErrorCode, parseServerFrame, type HostHandover, type HostLogon } from '@cc/protocol'
import { proofNonce, provesToken } from '../transport/host-proof.js'
import { rpcError } from '../rpc-error.js'

/**
 * The hub's connection to one linked machine's host (docs/plans/remote-hub.md §2, §5).
 *
 * **A port of `packages/platform/src/web/rpc-client.ts`, not a shared copy.** The layer rules
 * (docs/architecture.md §2) let agent-host depend on `@cc/protocol` alone, and the protocol package
 * is the schemas, without IO; moving the UI's client there would put a socket in the one package
 * everything depends on. What is ported are the rules that took measuring to get right, and they
 * keep their reasons here:
 *
 *   - nothing is sent before `hello_ok` (#82);
 *   - a cursor travels with the host lifetime that issued it (`streamEpoch`), and the host replays
 *     only when the lifetime matches (#82);
 *   - an event at or below the cursor is a repeat and is dropped (#82);
 *   - a first contact takes `currentSeq` as its starting point and drops the replay up to it:
 *     those events are older than the snapshot the hub reads next (#173).
 *
 * What differs, because the hub is not a screen:
 *
 *   - **A call fails at once while the link is down**, instead of waiting in a queue for the
 *     reconnect. The UI waiting on it would otherwise sit for the call's whole timeout behind a
 *     machine that may be gone for hours; "not reachable" is an answer it can show.
 *   - **A refusal is reported, not retried**: a wrong token (4001) or another protocol (4002)
 *     gets the same answer every time. The link (links.ts) asks the remote for its connection line
 *     again, or reports the versions for the person to align (§4).
 *   - **`hello_ok` is reported with the remote's build**, for the version check (§4).
 *   - **It stops redialling after `redials` tries** (#1143): the same forward can stay up while the host behind it is
 *     gone, and redialling it then never ends. The link reads the connection line again, which is what starts a host.
 *   - **It answers a request only through `RemoteClientEvents.call`** (#550, plan §12.7). A host's call to its
 *     client (the reverse direction) is dropped, never dispatched, unless the link gave that handler; the link
 *     gives one that serves an allowlist and refuses everything else, and a compromised remote must not reach the
 *     hub through the link the hub opened any other way. At most `MAX_INCOMING_CALLS` run at once; a call is
 *     aborted when the host withdraws it (`call.cancel`) or the socket goes.
 */

export type RemoteHello = {
  /** True when what the hub holds about this machine has to be read again from its snapshot */
  resync: boolean
  /** The first answer from this host lifetime (a new remote process, or the hub's first contact) */
  newLifetime: boolean
  protocolVersion: number
  build?: HostBuild
  /** The remote host runs with administrator rights (#702); absent when it did not say */
  elevated?: boolean
  /** Which Windows logon the remote host runs in (#1224); absent when it did not say */
  logon?: HostLogon
  /** A sign-in's serve waiting to take over from the remote host, or one that gave up (#1224); absent when none */
  handover?: HostHandover
}

/** `proving`: refused the `prove` itself (#838), as a host from before the proof, still running, does */
export type RemoteRefusal = { code: 4001 | 4002; reason: string; error?: ProtocolError; proving?: boolean }

export type RemoteClientOptions = {
  url: string
  token: string
  /** For tests */
  WebSocketImpl?: typeof WebSocket
  /** How long an open socket may go without `hello_ok` before it is dropped and retried */
  handshakeTimeoutMs?: number
  /** One call's bound. Generous: a forwarded resume can take minutes (the UI's own budget is 180 s) */
  callTimeoutMs?: number
  maxBackoffMs?: number
  /**
   * How many times in a row it dials the same address again without reaching the host's hello, before it stops and
   * reports `gaveUp`. Absent: without end. The link sets it (linked-machine-connection.ts): past these few, whether a
   * host still runs there is the machine's to say, through its connection line, and only the link can ask that
   */
  redials?: number
  /** The protocol number sent in hello. Only tests set it */
  protocolVersion?: number
  /**
   * The host must prove it holds the token before the token is sent (#838): its connection line says it can
   * (`ConnectionLine.proof`). Whatever listens on the forward's local port and cannot prove it never sees the token.
   */
  proveHost?: boolean
}

export type RemoteClientEvents = {
  hello?: (h: RemoteHello) => void
  event?: (event: unknown) => void
  terminal?: (frame: { terminalId: string; data?: string; exitCode?: number | null }) => void
  down?: (reason: string) => void
  /** Dialled again `redials` times in a row and no host answered: it dials no more (the owner closes it) */
  gaveUp?: (reason: string) => void
  refused?: (r: RemoteRefusal) => void
  /**
   * Answers a call the remote host makes to the hub (#550, the reverse direction). Absent: every such call is dropped,
   * as before the reverse direction existed. `signal` fires when the host withdraws the call or the socket goes
   */
  call?: (method: string, params: unknown, signal: AbortSignal) => Promise<unknown>
}

/** How many calls from the remote may run on the hub at once (#550): one past it is refused, not queued */
export const MAX_INCOMING_CALLS = 16

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000

/** A frame's JSON, or null when it is not JSON */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}
const DEFAULT_CALL_TIMEOUT_MS = 200_000

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }

const linkError = (message: string, retryable: boolean) => rpcError(message, 'internal', { retryable })

export class RemoteClient {
  private ws: WebSocket | null = null
  private pending = new Map<string, Pending>()
  private nextId = 1
  private lastSeq = 0
  private epoch: string | undefined
  private cursorValid = false
  private ready = false
  private closed = false
  private attempt = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined
  /** The refusal that came before the close, if one did: it names why the host closes */
  private refusal: ProtocolError | undefined
  private readonly WS: typeof WebSocket

  constructor(
    private opts: RemoteClientOptions,
    private readonly on: RemoteClientEvents = {},
  ) {
    this.WS = opts.WebSocketImpl ?? WebSocket
  }

  get connected(): boolean {
    return this.ready
  }

  /** Whether it asks the host to prove it holds the token (`RemoteClientOptions.proveHost`) */
  get provesHost(): boolean {
    return this.opts.proveHost === true
  }

  connect(): void {
    if (this.closed || this.ws) return
    this.clearTimers()
    this.ready = false
    this.refusal = undefined
    this.proving = null
    const ws = new this.WS(this.opts.url)
    this.ws = ws
    this.handshakeTimer = setTimeout(() => this.lost(ws, 'no answer to hello'), this.opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS)
    ws.on('open', () => {
      if (this.ws !== ws) return
      if (this.opts.proveHost) {
        this.proving = proofNonce()
        ws.send(JSON.stringify({ kind: 'prove', nonce: this.proving }))
        return
      }
      this.sendHello(ws)
    })
    ws.on('message', (data) => {
      if (this.ws !== ws) return
      if (this.proving !== null) return this.onProof(ws, String(data))
      this.onFrame(String(data))
    })
    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return
      if (this.proving !== null) {
        this.proving = null
        /*
         * Refused the `prove` (4001 "not a hello", or 4002): a host that cannot prove, such as a machine rolled back to a
         * build from before #838 whose line still said it could. Reported as a refusal, so the link reads the connection
         * line again rather than retrying the same prove for as long as the hub runs.
         */
        if (code === 4001 || code === 4002) return this.onClose(ws, code, Buffer.from("the host did not answer a proof of its token"), true)
        // Closed otherwise before it proved anything: not this machine's host, or one that went away
        return this.lost(ws, `the forward's port closed before the host proved it holds the token (${code})`)
      }
      this.onClose(ws, code, reason)
    })
    ws.on('error', () => {
      /* 'close' follows */
    })
  }

  /** The nonce of the `prove` this socket sent, until the host's proof arrives (#838) */
  private proving: string | null = null

  /** The remote's calls the hub is running (#550), by the remote's id, each with what aborts it */
  private incoming = new Map<string, AbortController>()

  /** The host's answer to `prove`: the token goes out only once it is proven; anything else drops the socket */
  private onProof(ws: WebSocket, raw: string): void {
    const nonce = this.proving!
    this.proving = null
    const f = parseJson(raw) as { kind?: unknown; nonce?: unknown; mac?: unknown } | null
    if (f?.kind === 'proof' && f.nonce === nonce && provesToken(this.opts.token, nonce, f.mac)) return this.sendHello(ws)
    // Something else holds the port (another account's program, #838): it never gets the token
    this.lost(ws, "the forward's port answered without proving it is the machine's host")
  }

  private sendHello(ws: WebSocket): void {
    ws.send(
      JSON.stringify({
        kind: 'hello',
        token: this.opts.token,
        protocolVersion: this.opts.protocolVersion ?? PROTOCOL_VERSION,
        ...(this.cursorValid ? { afterSeq: this.lastSeq, ...(this.epoch ? { streamEpoch: this.epoch } : {}) } : {}),
      }),
    )
  }

  private onClose(ws: WebSocket, code: number, reason: Buffer, proving = false): void {
    if (code === 4001 || code === 4002) {
      this.detach(ws)
      this.ws = null
      this.ready = false
      this.clearTimers()
      this.failAll(`The host refused the link: ${this.refusal?.message ?? String(reason)}`)
      // Not retried: the same hello gets the same answer (the link decides what to do next)
      this.on.refused?.({ code, reason: String(reason), ...(this.refusal ? { error: this.refusal } : {}), ...(proving ? { proving } : {}) })
      return
    }
    this.lost(ws, `closed (${code})`)
  }

  /** Points the client at another address or token (the tunnel came back on another port, or the token rotated) */
  updateEndpoint(url: string, token: string): void {
    const sameHost = this.opts.url === url
    this.opts = { ...this.opts, url, token }
    if (!sameHost) {
      // Another address may be another host: its numbers mean nothing to our cursor
      this.cursorValid = false
      this.epoch = undefined
      this.lastSeq = 0
    }
    this.attempt = 0
    if (this.ws) {
      const old = this.ws
      this.ws = null
      this.detach(old)
      this.ready = false
      this.failAll('The link moved to another address')
    }
    this.clearTimers()
    this.connect()
  }

  call(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(linkError('The link is closed', false))
    // Fails now rather than waiting for a machine that may not come back (see the header)
    if (!this.ready || !this.ws) return Promise.reject(linkError('The machine is not reachable right now', true))
    const ws = this.ws
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) reject(rpcError(`The machine did not answer ${method} in time`, 'internal', { retryable: true }))
      }, this.opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ kind: 'rpc', id, method, params }))
    })
  }

  close(): void {
    this.closed = true
    this.clearTimers()
    const ws = this.ws
    this.ws = null
    this.ready = false
    this.detach(ws)
    this.failAll('The link is closed')
  }

  private onFrame(raw: string): void {
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      return
    }
    const parsed = parseServerFrame(json)
    if (!parsed.success) {
      // A failure answer the schema could not read still ends its call (the UI client's `salvage`, 2026-09-10)
      const f = json as { kind?: unknown; id?: unknown; ok?: unknown; error?: { message?: unknown } }
      if (f?.kind === 'res' && f.ok === false && typeof f.id === 'string') {
        const p = this.take(f.id)
        p?.reject(linkError(typeof f.error?.message === 'string' ? f.error.message : 'Malformed answer from the machine', false))
      }
      // Anything else is dropped
      return
    }
    const frame = parsed.data
    if (frame.kind === 'rpc') {
      if (this.ready) this.onCall(frame.id, frame.method, frame.params)
      return
    }
    if (frame.kind === 'hello_ok') {
      if (this.ready) return
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = undefined
      const hadCursor = this.cursorValid
      const sameLifetime =
        hadCursor &&
        (frame.streamEpoch === undefined || this.epoch === undefined || frame.streamEpoch === this.epoch) &&
        frame.currentSeq >= this.lastSeq
      const resync = !hadCursor || frame.resyncRequired || !sameLifetime
      if (resync) this.lastSeq = frame.currentSeq
      this.epoch = frame.streamEpoch
      this.cursorValid = true
      this.ready = true
      this.attempt = 0
      this.on.hello?.({ resync, newLifetime: !sameLifetime, protocolVersion: frame.protocolVersion, ...(frame.build ? { build: frame.build } : {}), ...(typeof frame.elevated === 'boolean' ? { elevated: frame.elevated } : {}), ...(frame.logon ? { logon: frame.logon } : {}), ...(frame.handover ? { handover: frame.handover } : {}) })
      return
    }
    if (frame.kind === 'res') {
      if (!this.ready && !frame.ok && frame.error.code === 'version_mismatch') {
        // The refusal before a 4002 close: kept, so the close can say why
        this.refusal = frame.error
        return
      }
      const p = this.take(frame.id)
      if (!p) return
      if (frame.ok) p.resolve(frame.result)
      else p.reject(Object.assign(new Error(frame.error.message), { code: frame.error.code, retryable: frame.error.retryable, ...(frame.error.data !== undefined ? { data: frame.error.data } : {}) }))
      return
    }
    if (!this.ready) return
    if (frame.kind === 'event') {
      if (frame.seq <= this.lastSeq) return
      this.lastSeq = frame.seq
      this.on.event?.(frame.event)
      return
    }
    if (frame.kind === 'term') {
      this.on.terminal?.({ terminalId: frame.terminalId, data: frame.data })
      return
    }
    if (frame.kind === 'term_exit') this.on.terminal?.({ terminalId: frame.terminalId, exitCode: frame.exitCode })
  }

  /**
   * A call from the remote host (#550): answered only through the handler the link gave, on the socket it came in on.
   * Without a handler it is dropped, as every build before the reverse direction did.
   */
  private onCall(id: string, method: string, params: unknown): void {
    const handle = this.on.call
    if (!handle) return
    const ws = this.ws
    if (method === CANCEL_CALL_METHOD) {
      const target = (params as { id?: unknown } | null)?.id
      if (typeof target === 'string') this.incoming.get(target)?.abort()
      return
    }
    const answer = (frame: Record<string, unknown>) => {
      if (ws && this.ws === ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify({ kind: 'res', id, ...frame }))
    }
    const refuse = (message: string, code: string = 'internal', retryable = false) =>
      answer({ ok: false, error: { code: ProtocolErrorCode.safeParse(code).success ? code : 'internal', message, retryable } })
    if (this.incoming.has(id)) return refuse('A call with this id is already running')
    if (this.incoming.size >= MAX_INCOMING_CALLS) return refuse('Too many calls at once; try again shortly', 'internal', true)
    const ctl = new AbortController()
    this.incoming.set(id, ctl)
    void handle(method, params, ctl.signal)
      .then(
        (result) => answer({ ok: true, result: result ?? null }),
        (err: unknown) => {
          const e = err as { message?: unknown; code?: unknown; retryable?: unknown }
          refuse(typeof e?.message === 'string' ? e.message : 'The hub could not answer', typeof e?.code === 'string' ? e.code : 'internal', e?.retryable === true)
        },
      )
      .finally(() => {
        if (this.incoming.get(id) === ctl) this.incoming.delete(id)
      })
  }

  /** The remote's calls still running are withdrawn: their socket is gone, and no answer can reach them */
  private abortIncoming(): void {
    for (const ctl of this.incoming.values()) ctl.abort()
    this.incoming.clear()
  }

  private take(id: string): Pending | undefined {
    const p = this.pending.get(id)
    if (!p) return undefined
    this.pending.delete(id)
    clearTimeout(p.timer)
    return p
  }

  /** Every call in flight gets an answer: its outcome on the remote is unknown, and it is not sent again (#82, #173) */
  private failAll(reason: string): void {
    for (const [id, p] of [...this.pending]) {
      this.take(id)
      p.reject(linkError(`${reason} before the machine answered; it may or may not have done this`, false))
    }
  }

  private lost(ws: WebSocket, reason: string): void {
    if (this.ws !== ws) return
    this.detach(ws)
    this.ws = null
    const wasReady = this.ready
    this.ready = false
    this.clearTimers()
    this.failAll('The link dropped')
    if (this.closed) return
    if (wasReady) this.on.down?.(reason)
    // `attempt` counts the dials since the last hello
    if (this.opts.redials !== undefined && this.attempt >= this.opts.redials) {
      this.on.gaveUp?.(reason)
      return
    }
    const delay = Math.min(this.opts.maxBackoffMs ?? 5000, 200 * 2 ** this.attempt++)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
  }

  private detach(ws: WebSocket | null): void {
    if (!ws) return
    this.abortIncoming()
    ws.removeAllListeners()
    // A late error after the listeners are gone must not become an unhandled 'error' event
    ws.on('error', () => {})
    try {
      ws.terminate()
    } catch {
      // Already gone
    }
  }

  private clearTimers(): void {
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.handshakeTimer)
    this.reconnectTimer = undefined
    this.handshakeTimer = undefined
  }
}
