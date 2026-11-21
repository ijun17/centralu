import {
  HANDSHAKE_TIMEOUT_MS,
  PROTOCOL_VERSION,
  callBudgetMs,
  SHOWS_HOST_REQUESTS,
  errorMessage,
  isRecord,
  parseRpcResult,
  parseServerFrame,
  type NormalizedEvent,
  type RpcMethodName,
  type RpcParams,
  type RpcResult,
} from '@cc/protocol/client'
import { EventCursor } from '@cc/common'
import type { ConnectionState, Unsubscribe } from '../ports/index.js'
import { deliver } from '../deliver.js'

/** The WS RPC client (protocol.md §1): the one place that lets ui not know WebSocket */
export type RpcClientOptions = {
  url: string
  token: string
  WebSocketImpl?: typeof WebSocket
  maxBackoffMs?: number
  /** Overrides the method's budget, the last resort for a host that never answers */
  callTimeoutMs?: number
  /** How long an open socket may go without `hello_ok` before it is dropped and retried */
  handshakeTimeoutMs?: number
  /** The most calls that may wait for the host at once, sent or not */
  maxPendingCalls?: number
  /** The most bytes of unsent frames that may wait for a connection */
  maxQueuedBytes?: number
}

/** `frame`: null once sent over an authenticated socket; only such a call is rejected on a disconnect */
type Pending = {
  method: RpcMethodName
  viewRead: boolean
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
  frame: string | null
  bytes: number
}

/**
 * protocol.md §1. Unbounded, 100,000 calls made while disconnected are all queued, each with its frame and a timer
 * (measured). 512 is far above the largest burst, a resync (a history page per held conversation and a few lists);
 * 64 MiB fits the largest call, a pasted 20 MiB attachment (about 27 MiB as base64).
 */
const DEFAULT_MAX_PENDING_CALLS = 512
const DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024

/** Every error a call rejects with, the host's and the client's own */
const rpcError = (message: string, code: string, retryable: boolean) => Object.assign(new Error(message), { code, retryable })

/** An endpoint in the one spelling `URL` gives it, so two spellings of one address compare equal */
const endpointUrl = (url: string): string => new URL(url).toString()

export class RpcClient {
  private ws: WebSocket | null = null
  /** In the order made, which is the order unsent frames go out in */
  private pending = new Map<string, Pending>()
  /** Of the frames in `pending` not sent yet */
  private queuedBytes = 0
  private eventHandlers = new Set<(e: NormalizedEvent, id?: string) => void>()
  private termHandlers = new Set<(e: { terminalId: string; data: string }) => void>()
  private termExitHandlers = new Set<(e: { terminalId: string; exitCode: number | null }) => void>()
  private connHandlers = new Set<(s: ConnectionState) => void>()
  private nextId = 1
  /**
   * Drops repeats and a first-met host's replay, and carries the host lifetime (protocol.md §1). A repeat dispatched
   * twice (measured) doubles streamed text for good.
   */
  private readonly cursor = new EventCursor()
  /** A first meeting after a completed handshake is a new host: the screen re-reads what it holds */
  private greeted = false
  /** `hello_ok` arrived: only then are calls sent and `connected` reported (protocol.md §1) */
  private ready = false
  private attempt = 0
  private closed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly WS: typeof WebSocket

  /** A revived host has a new port and token (docs/runtime-lessons/front-door-and-store.md SW1) */
  updateEndpoint(next: string, token: string): void {
    // The same address is no change: in keeper mode the shell repeats `ready` whenever the keeper's view changes, and
    // each would drop the socket, reject the calls in flight and force a resync
    const url = endpointUrl(next)
    if (this.opts.url === url && this.opts.token === token) return
    this.opts = { ...this.opts, url, token }
    this.attempt = 0
    // A new host numbers events from the start: the next hello is a first contact
    this.cursor.forget()
    this.ready = false
    this.clearTimers()
    // Detached first: close() is asynchronous, and the old onclose would clear the new socket and open another
    // reconnect, two sockets applying each streaming delta twice (measured)
    this.detach(this.ws)
    this.ws = null
    // Their answers never come, and the onclose that would reject them was just detached
    this.failInFlight('Host restarted')
    this.connect()
  }

  /** Takes a socket out of service: no handler of it runs again (see updateEndpoint), and it is closed */
  private detach(ws: WebSocket | null): void {
    if (!ws) return
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    ws.onerror = null
    ws.close()
  }

  private clearTimers(): void {
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.handshakeTimer)
    this.reconnectTimer = undefined
    this.handshakeTimer = undefined
  }

  constructor(private opts: RpcClientOptions) {
    this.opts = { ...opts, url: endpointUrl(opts.url) }
    this.WS = opts.WebSocketImpl ?? WebSocket
  }

  get connectionState(): ConnectionState {
    if (this.closed) return 'disconnected'
    return this.ready ? 'connected' : 'connecting'
  }

  connect(): void {
    if (this.closed) return
    // The backoff timer and updateEndpoint can overlap: never two sockets
    if (this.ws) return
    this.clearTimers()
    this.ready = false
    this.emitConn('connecting')
    const ws = new this.WS(this.opts.url)
    this.ws = ws
    // A host that accepts but never answers hello (wedged, or not ours) would hold 'connecting' for good
    this.handshakeTimer = setTimeout(() => this.lost(ws), this.opts.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS)

    ws.onopen = () => {
      if (this.ws !== ws) return
      ws.send(
        JSON.stringify({
          kind: 'hello',
          token: this.opts.token,
          protocolVersion: PROTOCOL_VERSION,
          // This window shows the cards of the limited credential's calls (#1405); a host counts on it only with the token
          shows: [SHOWS_HOST_REQUESTS],
          ...this.cursor.resumeFrom(),
        }),
      )
    }

    ws.onmessage = (e: MessageEvent) => {
      if (this.ws !== ws) return
      this.onFrame(String(e.data))
    }

    ws.onclose = () => this.lost(ws)

    ws.onerror = () => {
      /* Does nothing here, since onclose follows */
    }
  }

  /** The socket is gone (closed, or it never finished the handshake): reject what is unknowable and retry */
  private lost(ws: WebSocket): void {
    if (this.ws !== ws) return
    this.detach(ws)
    this.ws = null
    this.ready = false
    this.clearTimers()
    if (this.closed) return
    // Its answer never comes, even after a reconnect; left alone, a session would sit at 'working' for good
    this.failInFlight('Connection lost')
    // The retry is armed before anyone hears about the drop: what a listener does can never cost the reconnect
    const delay = Math.min(this.opts.maxBackoffMs ?? 5000, 200 * 2 ** this.attempt++)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
    this.emitConn('disconnected')
  }

  private onFrame(raw: string): void {
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      return
    }
    const parsed = parseServerFrame(json)
    if (!parsed.success) return this.salvage(json) // Ignores an unknown frame (forward compatibility)
    const frame = parsed.data

    if ('kind' in frame && frame.kind === 'hello_ok') {
      if (this.ready) return // A repeat changes nothing
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = undefined
      const greeted = this.greeted
      this.greeted = true
      this.ready = true
      this.attempt = 0
      // protocol.md §1: a gap that cannot be replayed is read from the snapshot, and so is what the screen held when a
      // new host is met
      const c = this.cursor.greet(frame)
      const resync = c.firstContact ? greeted : c.resync
      // Calls made while connecting go out first, in order, then the rest of the app hears about it
      this.flush()
      this.emitConn('connected')
      if (resync) this.emitConn('resync_required')
      return
    }
    if (!this.ready) return
    if (frame.kind === 'event') {
      if (!this.cursor.take(frame.seq)) return // A repeat (#82), or a first-met host's old news (#173)
      deliver(this.eventHandlers, frame.event, this.cursor.eventId(frame.seq))
      return
    }
    // Terminal output carries no seq (it does not ride the resend buffer — see envelope)
    if (frame.kind === 'term') {
      deliver(this.termHandlers, { terminalId: frame.terminalId, data: frame.data })
      return
    }
    if (frame.kind === 'term_exit') {
      deliver(this.termExitHandlers, { terminalId: frame.terminalId, exitCode: frame.exitCode })
      return
    }
    if (frame.kind === 'res') {
      const p = this.take(frame.id)
      if (!p) return
      // Read through the method's result schema, once (protocol.md §4): its defaults apply only to what is parsed
      if (!frame.ok) return p.reject(rpcError(frame.error.message, frame.error.code, frame.error.retryable))
      // Already out of `pending`: a read that threw would leave its caller waiting for good
      let result: unknown
      try {
        result = parseRpcResult(p.method, frame.result)
      } catch (e) {
        return p.reject(rpcError(`Could not read the host's answer to ${p.method}: ${errorMessage(e)}`, 'internal', false))
      }
      p.resolve(result)
    }
  }

  /**
   * Ends an awaited call whose failure frame is unreadable (a code this build lacks, `ENOENT` measured; a host of
   * another version; a proxy) rather than leave its screen loading to the 30 s timeout (protocol.md §5). An unreadable
   * success is not passed on as a result: a value that failed validation would break elsewhere on screen.
   */
  private salvage(json: unknown): void {
    if (!this.ready) return
    if (!isRecord(json) || json.kind !== 'res' || typeof json.id !== 'string') return
    const p = this.take(json.id)
    if (!p) return
    const error = json.error
    const message = isRecord(error) && typeof error.message === 'string' ? error.message : 'Malformed response from the host'
    p.reject(rpcError(message, 'internal', false))
  }

  /** Clears its timer and its queued bytes too */
  private take(id: string): Pending | undefined {
    const p = this.pending.get(id)
    if (!p) return undefined
    this.pending.delete(id)
    clearTimeout(p.timer)
    if (p.frame !== null) this.queuedBytes -= p.bytes
    return p
  }

  /** Every unsent call, oldest first */
  private flush(): void {
    const ws = this.ws
    if (!this.ready || !ws) return
    for (const p of this.pending.values()) {
      if (p.frame === null) continue
      const frame = p.frame
      p.frame = null
      this.queuedBytes -= p.bytes
      ws.send(frame)
    }
  }

  /** Every sent, unanswered call: its outcome is unknown, so it is never resent or retryable (protocol.md §1) */
  private failInFlight(reason: string): void {
    for (const [id, p] of [...this.pending]) {
      if (p.frame !== null) continue
      this.take(id)
      p.reject(rpcError(p.viewRead ? `${reason} while opening this app screen` : `${reason} before an answer came — the host may or may not have done this; check before trying again`, 'connection_lost', false))
    }
  }

  /**
   * The name, params and result all come from `RpcMethods`: a `call<T>(method: string)` would check none of them, and
   * a change in `commands.ts` makes the compiler point at every caller.
   */
  call<M extends RpcMethodName>(method: M, params: RpcParams<M>): Promise<RpcResult<M>>
  // What resolves a call went through `parseRpcResult` for its method (see `onFrame`), which is what the signature above says
  call(method: RpcMethodName, params: object): Promise<unknown> {
    if (this.closed) return Promise.reject(rpcError('Connection closed', 'connection_closed', false))
    const id = String(this.nextId++)
    const frame = JSON.stringify({ kind: 'rpc', id, method, params })
    // Refused before it is queued, so nothing happened and it may be tried again
    const maxPending = this.opts.maxPendingCalls ?? DEFAULT_MAX_PENDING_CALLS
    if (this.pending.size >= maxPending) {
      return Promise.reject(rpcError(`Too many requests are waiting for the host (${maxPending}); this one was not sent`, 'overloaded', true))
    }
    const bytes = this.ready ? 0 : new TextEncoder().encode(frame).byteLength
    const maxQueued = this.opts.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES
    if (this.queuedBytes + bytes > maxQueued) {
      return Promise.reject(rpcError('Too much is waiting for the host to reconnect; this request was not sent', 'overloaded', true))
    }
    return new Promise<unknown>((resolve, reject) => {
      // For a host that swallows an answer on a live socket (a handler bug, a hang), and a call never sent
      const timer = setTimeout(() => {
        if (!this.take(id)) return
        reject(rpcError(`RPC timed out: ${method}`, 'timeout', true))
      }, this.opts.callTimeoutMs ?? callBudgetMs(method))
      const ws = this.ready ? this.ws : null
      const viewRead = ['apps.viewFrame', 'apps.recoverView', 'apps.inlineReopen', 'apps.inlineViews', 'apps.holdViews'].includes(method) ||
        (method === 'apps.openView' && 'openKey' in params && typeof params.openKey === 'string')
      this.pending.set(id, { method, viewRead, resolve, reject, timer, frame: ws ? null : frame, bytes })
      this.queuedBytes += bytes
      ws?.send(frame)
    })
  }

  onEvent(handler: (e: NormalizedEvent, id?: string) => void): Unsubscribe {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  onTerminalOutput(handler: (e: { terminalId: string; data: string }) => void): Unsubscribe {
    this.termHandlers.add(handler)
    return () => this.termHandlers.delete(handler)
  }

  onTerminalExit(handler: (e: { terminalId: string; exitCode: number | null }) => void): Unsubscribe {
    this.termExitHandlers.add(handler)
    return () => this.termExitHandlers.delete(handler)
  }

  onConnectionChange(handler: (s: ConnectionState) => void): Unsubscribe {
    this.connHandlers.add(handler)
    return () => this.connHandlers.delete(handler)
  }

  private emitConn(s: ConnectionState): void {
    deliver(this.connHandlers, s)
  }

  /** For good (protocol.md §1): a timer left behind would hold the process open until it fires */
  close(): void {
    this.closed = true
    this.ready = false
    this.clearTimers()
    this.detach(this.ws)
    this.ws = null
    for (const [id] of [...this.pending]) {
      this.take(id)?.reject(rpcError('Connection closed', 'connection_closed', false))
    }
  }
}
