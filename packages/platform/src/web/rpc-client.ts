import {
  PROTOCOL_VERSION,
  parseRpcResult,
  parseServerFrame,
  type NormalizedEvent,
  type ProtocolError,
  type RpcMethodName,
  type RpcParams,
  type RpcResult,
} from '@cc/protocol'
import type { ConnectionState, Unsubscribe } from '../ports/index.js'

/**
 * The WS RPC client — reconnect + backoff + afterSeq restore (tech-stack.md: hand-rolled,
 * ~50 lines). This file is the one place that lets ui not know WebSocket directly.
 */
export type RpcClientOptions = {
  url: string
  token: string
  /** For injecting in tests */
  WebSocketImpl?: typeof WebSocket
  maxBackoffMs?: number
  /** The response timeout for one RPC call. A last-resort safety net for when the host never responds */
  callTimeoutMs?: number
  /** How long an open socket may go without `hello_ok` before it is dropped and retried (#82) */
  handshakeTimeoutMs?: number
  /** The most calls that may wait for the host at once, sent or not (#82) */
  maxPendingCalls?: number
  /** The most bytes of not-yet-sent frames that may wait for a connection (#82) */
  maxQueuedBytes?: number
}

/**
 * One call waiting for the host.
 *
 * `frame` is the unsent frame, or null once it went out over an authenticated socket. On
 * disconnect, **only what went out** is rejected — what is still unsent is sent after
 * reconnecting, per the existing contract.
 */
type Pending = {
  /** Which method was called — its result schema is what the answer is read through */
  method: RpcMethodName
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout>
  frame: string | null
  bytes: number
}

/**
 * Client-side bounds (#82). Measured on main: 100,000 calls made while disconnected were all
 * accepted and queued, each holding its frame and a timer.
 *
 * 512 is far above any burst the UI makes — the largest is a resync, which reads one history page
 * per session holding a conversation, plus a handful of list calls. 64 MiB of unsent frames
 * leaves room for the largest single call, a pasted attachment (base64 inflates a 20 MiB file to
 * about 27 MiB), queued while the host is away.
 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 10_000
const DEFAULT_MAX_PENDING_CALLS = 512
const DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024

const rpcError = (message: string, code: string, retryable: boolean) => Object.assign(new Error(message), { code, retryable })

/** The default RPC response timeout. Session creation and git operations also finish within this (measured at a few seconds) */
const DEFAULT_CALL_TIMEOUT_MS = 30_000

/**
 * Calls that **can revive a session** get a different budget (dogfooding: a "resource upload"
 * session — codex's thread/resume rereads its whole rollout file, and a 550MB thread took
 * 13.5 seconds, with larger threads going over 25. Under the 30-second default, a large thread
 * becomes a session that can never wake up). Since the file only ever grows, the cap has to be
 * a value that can scale with size — 180 seconds covers up to the 7GB class at the measured
 * ratio (550MB ≈ 13.5s). The manager's own stage limit (150 seconds) sits inside this, so even
 * when time runs out, a named reason reaches the screen.
 */
const LONG_CALL_TIMEOUT_MS = 180_000
const LONG_CALLS = new Set<string>([
  'agents.resumeSession', // An explicit wake-up
  'agents.send', // If the session is asleep, revives it first, then sends — pays the same cost
  'agents.createSession', // When picking up a previous conversation via resumeExternalId
  'agents.restartSession', // Swaps out the process and revives it again
  'agents.exportHandoffRecord', // Can scan a rollout hundreds of MB in size (#78)
  /*
   * Calls that end in a revival (#164) — while these were missing here, the host would apply
   * and restart on a large conversation, but the screen showed "RPC timed out" (reading what
   * succeeded as a failure). Add a new RPC that ends in a revival here too.
   */
  'agents.updateSettings', // Swaps out the process if a resting session's settings change (restartSession)
  'agents.forkConversation', // Revives as a forked copy
  'agents.resolveMcpProposal', // Restarts the orchestrator on approval
  'agents.resolveSkillProposal', // Same
  'agents.deleteOrchestratorSkill', // Same
])

/**
 * The budget for an app tool a screen calls (`apps.invoke`) (M4 D-4). That call can wait on a
 * person — the first time an app tries to use a capability, the host asks that app's pinned
 * screen and waits up to 5 minutes for an answer (the runtime's capabilityQuestionMs). After
 * that, the agent may run for a few more minutes. With the 30-second default, the screen's
 * call would cut off first while the person is still reading and answering, so even clicking
 * the answer would find the screen already holding a failure. 15 minutes is the question's cap
 * (5 minutes) plus the host-to-app call's cap (10 minutes, reset by progress notifications).
 * The waiting on the screen's side is kept alive by AppFrame's progress notifications.
 */
const APP_CALL_TIMEOUT_MS = 15 * 60_000

export class RpcClient {
  private ws: WebSocket | null = null
  /** Every call waiting for the host, in the order they were made (the order unsent frames go out in) */
  private pending = new Map<string, Pending>()
  /** Bytes of the frames in `pending` that have not been sent yet */
  private queuedBytes = 0
  private eventHandlers = new Set<(e: NormalizedEvent) => void>()
  private termHandlers = new Set<(e: { terminalId: string; data: string }) => void>()
  private termExitHandlers = new Set<(e: { terminalId: string; exitCode: number | null }) => void>()
  private connHandlers = new Set<(s: ConnectionState) => void>()
  private nextId = 1
  /**
   * The last event seq handed on. Every event at or below it is a repeat and is dropped (#82):
   * measured on main, the same seq delivered twice was dispatched twice, and a streaming delta
   * applied twice doubles text for good.
   *
   * It also carries #173's first-contact rule. A hello with no cursor is a first meeting with this
   * host, and the host replays its whole buffer — all of it finished before the screen attached.
   * Passing that through would put up a "done" card for every finished turn, play a sound and
   * build a conversation from old fragments on every fresh page load. So a first contact takes
   * `hello_ok.currentSeq` as its starting point, and the replay up to it is dropped as a repeat;
   * the list and the store (the snapshot) are the starting point instead.
   */
  private lastSeq = 0
  /**
   * The host lifetime `lastSeq` belongs to (#82), from `hello_ok.streamEpoch`. A reconnect sends
   * both, and the host replays only when the lifetime matches; a host that restarted at the same
   * address answers with a resync instead of another lifetime's events. Undefined until the first
   * `hello_ok`, and again after moving to a new endpoint.
   */
  private hostEpoch: string | undefined
  /** Whether `lastSeq` is a cursor into the current host — false means the next hello is a first contact */
  private cursorValid = false
  /** Whether a handshake with a host has ever completed — a first meeting after that (a new host) means the screen has to re-read what it is holding */
  private greeted = false
  /**
   * The socket answered `hello_ok` (#82). Only then are calls sent and is the connection reported
   * as connected. Measured on main: with a wrong token the client reported `connected` the moment
   * the socket opened, flushed its queue into a socket the host was about to close, and then
   * reported the never-run call as `connection_lost` — "it may have reached the host".
   */
  private ready = false
  private attempt = 0
  private closed = false
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private handshakeTimer: ReturnType<typeof setTimeout> | undefined
  private readonly WS: typeof WebSocket

  /**
   * If the host comes back up, the port and token change (the supervisor claims a fresh empty
   * port). Retrying the old address forever would leave the app stuck at 'disconnected' — a
   * defect confirmed by measurement.
   */
  updateEndpoint(url: string, token: string): void {
    if (this.opts.url === url && this.opts.token === token) return
    this.opts = { ...this.opts, url, token }
    this.attempt = 0
    // A new host numbers events from the start — the next hello is a first contact
    this.lastSeq = 0
    this.hostEpoch = undefined
    this.cursorValid = false
    this.ready = false
    this.clearTimers()
    /*
     * **Detaches the old socket's handlers first.** close() is asynchronous, so onclose fires
     * later, and if left as is, that onclose would clear the reference to the new socket
     * (this.ws) just created and open yet another reconnect — two sockets receiving the same
     * events, applying a streaming delta twice (measured).
     */
    this.detach(this.ws)
    this.ws = null
    // The response to an RPC sent to the old host will never arrive — if this does not reject
    // it, optimistic UI waits forever for confirmation, stuck at 'working' (the onclose handler was just detached)
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
    this.WS = opts.WebSocketImpl ?? WebSocket
  }

  get connectionState(): ConnectionState {
    if (this.closed) return 'disconnected'
    return this.ready ? 'connected' : 'connecting'
  }

  connect(): void {
    if (this.closed) return
    // Does not create one if a socket already exists — if the backoff timer and updateEndpoint overlap, this could end up with two
    if (this.ws) return
    this.clearTimers()
    this.ready = false
    this.emitConn('connecting')
    const ws = new this.WS(this.opts.url)
    this.ws = ws
    /*
     * A host that accepts the socket but never answers hello (wedged, or not ours) would otherwise
     * hold the client in 'connecting' forever, with calls queued behind it (#82).
     */
    this.handshakeTimer = setTimeout(() => this.lost(ws), this.opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS)

    ws.onopen = () => {
      if (this.ws !== ws) return
      ws.send(
        JSON.stringify({
          kind: 'hello',
          token: this.opts.token,
          protocolVersion: PROTOCOL_VERSION,
          // A cursor travels with the lifetime that issued it (#82)
          ...(this.cursorValid ? { afterSeq: this.lastSeq, ...(this.hostEpoch ? { streamEpoch: this.hostEpoch } : {}) } : {}),
        }),
      )
      // Nothing else goes out until hello_ok (#82)
    }

    ws.onmessage = (e: MessageEvent) => {
      if (this.ws !== ws) return // Ignores a leftover frame from a socket that has been replaced
      this.onFrame(String(e.data))
    }

    ws.onclose = () => this.lost(ws)

    ws.onerror = () => {
      /* Does nothing here, since onclose follows */
    }
  }

  /** The socket is gone (closed, or it never finished the handshake): reject what is unknowable and retry */
  private lost(ws: WebSocket): void {
    if (this.ws !== ws) return // If it has already been replaced, leaves the new socket alone
    this.detach(ws)
    this.ws = null
    this.ready = false
    this.clearTimers()
    if (this.closed) return
    /*
     * **An RPC that was sent but got no answer is rejected right here.** Leaving it alone
     * would let optimistic UI wait for confirmation forever (a session stuck at 'working')
     * and pending would grow without bound — that response will never arrive even after
     * reconnecting (the host either never received the request or has already discarded it).
     * A call still only in the queue (never sent) is left as is — sending it after
     * reconnecting is the existing contract.
     */
    this.failInFlight('Connection lost')
    this.emitConn('disconnected')
    const delay = Math.min(this.opts.maxBackoffMs ?? 5000, 200 * 2 ** this.attempt++)
    this.reconnectTimer = setTimeout(() => this.connect(), delay)
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
      const hadCursor = this.cursorValid
      /*
       * Still the lifetime our cursor came from? The host already answers `resyncRequired` for a
       * cursor from another lifetime (#82); the client checks too, so a host that does not say so
       * cannot hand it a stranger's numbers. `currentSeq < lastSeq` is #173's check, kept for a
       * host that sends no epoch: the host came back up on the same address and is behind us.
       */
      const sameLifetime =
        hadCursor &&
        (frame.streamEpoch === undefined || this.hostEpoch === undefined || frame.streamEpoch === this.hostEpoch) &&
        frame.currentSeq >= this.lastSeq
      const greeted = this.greeted
      this.greeted = true
      this.hostEpoch = frame.streamEpoch
      this.cursorValid = true
      this.ready = true
      this.attempt = 0
      let resync: boolean
      if (!hadCursor) {
        // A first-met host's replay is not a new event — only its number is caught up to. If the screen was already
        // holding something (it switched to a new host), that has to be re-read
        this.lastSeq = frame.currentSeq
        resync = greeted
      } else if (frame.resyncRequired || !sameLifetime) {
        /*
         * The gap cannot be replayed: the cursor fell out of the buffer, the replay would not fit
         * the host's budget, or this is another host lifetime. Start from the host's current
         * number (holding the old one would make the duplicate filter drop a new lifetime's
         * events) and read what was missed from the snapshot.
         */
        this.lastSeq = frame.currentSeq
        resync = true
      } else {
        resync = false
      }
      // Calls made while connecting go out first, in order, then the rest of the app hears about it
      this.flush()
      this.emitConn('connected')
      if (resync) this.emitConn('resync_required')
      return
    }
    // Nothing but hello_ok counts before the handshake (#82)
    if (!this.ready) return
    if (frame.kind === 'event') {
      if (frame.seq <= this.lastSeq) return // A repeat (#82), or a first-met host's old news (#173)
      this.lastSeq = frame.seq
      for (const h of this.eventHandlers) h(frame.event)
      return
    }
    // Terminal output carries no seq (it does not ride the resend buffer — see envelope)
    if (frame.kind === 'term') {
      for (const h of this.termHandlers) h({ terminalId: frame.terminalId, data: frame.data })
      return
    }
    if (frame.kind === 'term_exit') {
      for (const h of this.termExitHandlers) h({ terminalId: frame.terminalId, exitCode: frame.exitCode })
      return
    }
    if (frame.kind === 'res') {
      const p = this.take(frame.id)
      if (!p) return
      /*
       * The answer goes through the method's result schema here, once (protocol.md §4). Events
       * already did, inside `parseServerFrame`; results were declared `unknown` in the envelope and
       * reached the screen as sent. Then a window attached to an older host (#280) read a session
       * list without `backgroundTasks` (#305) and crashed on `undefined.filter`: the field's
       * `.default([])` was never applied, because nothing parsed the payload.
       */
      if (frame.ok) p.resolve(parseRpcResult(p.method, frame.result))
      else p.reject(toError(frame.error))
    }
  }

  /**
   * If an unreadable frame is the **response being waited for**, this still ends the call
   * (dogfooding, 2026-09-10).
   *
   * The rule of ignoring an unknown frame is for forward compatibility, and that much is
   * right. But that net once caught one of the host's own **failure responses**: an envelope
   * arrived carrying an error code not in the protocol (`ENOENT`), failed validation, and the
   * frame was silently dropped. From the caller's side, it looked not like a failure arriving
   * but like **nothing arriving at all**, so that screen sat at 'loading' all the way to the
   * 30-second timeout (why a file link turned into a blank screen).
   *
   * The host now sends only codes it knows about. This net is kept anyway — **an unreadable
   * response will still arrive someday**, from a version-mismatched host, or an envelope a
   * proxy touched. When it does, saying "could not read it" right away is always better than
   * letting the screen hang.
   *
   * A successful response is not salvaged this way — passing a value that failed validation
   * through as if it were a real result would let that lie blow up somewhere else on screen in
   * a different shape. This ends the call, but ends it truthfully.
   */
  private salvage(json: unknown): void {
    if (!this.ready) return
    const f = json as { kind?: unknown; id?: unknown; error?: { message?: unknown } }
    if (f?.kind !== 'res' || typeof f.id !== 'string') return
    const p = this.take(f.id)
    if (!p) return
    const message = typeof f.error?.message === 'string' ? f.error.message : 'Malformed response from the host'
    p.reject(Object.assign(new Error(message), { code: 'internal', retryable: false }))
  }

  /** Takes one out of pending — "taking out" includes clearing its timer and its queued bytes (otherwise a ghost timer stays behind) */
  private take(id: string): Pending | undefined {
    const p = this.pending.get(id)
    if (!p) return undefined
    this.pending.delete(id)
    clearTimeout(p.timer)
    if (p.frame !== null) this.queuedBytes -= p.bytes
    return p
  }

  /** Sends every unsent call, oldest first — only over a socket that answered hello_ok (#82) */
  private flush(): void {
    const ws = this.ws
    if (!this.ready || !ws) return
    for (const p of this.pending.values()) {
      if (p.frame === null) continue
      const frame = p.frame
      // From here on this is a call that is 'sent and waiting for an answer' — a candidate for rejection at the next disconnect
      p.frame = null
      this.queuedBytes -= p.bytes
      ws.send(frame)
    }
  }

  /**
   * Rejects every call that was sent but got no answer.
   *
   * **Its outcome is unknown, and it is never sent again (#82, #173).** The host may have run it
   * before the line dropped — a rename, a send, a commit — and repeating it could do it twice.
   * So the error says exactly that, and it is not marked retryable: retrying is a decision for
   * whoever can check the host's state first (the store does this for `agents.send`).
   */
  private failInFlight(reason: string): void {
    for (const [id, p] of [...this.pending]) {
      if (p.frame !== null) continue
      this.take(id)
      p.reject(rpcError(`${reason} before an answer came — the host may or may not have done this; check before trying again`, 'connection_lost', false))
    }
  }

  /**
   * One RPC call. **The method name, the parameters and the result all come from
   * `RpcMethods`.**
   *
   * The old signature was `call<T>(method: string, params: unknown)`. That means none of the
   * three are checked: a typo in the name still compiles, and the result type is an
   * **assertion**, not validation, so TypeScript believes the lie even when the host gives
   * something else.
   *
   * Two real bugs leaked through that gap — an RPC that swallowed effort, and a Codex model
   * shape read wrong. Both were "the schema says A, but the hand-written channel says B." As
   * long as the channel is written by hand, the next one leaks the same way.
   *
   * Now, fixing `commands.ts` **makes the compiler point at every place that has to follow.**
   */
  call<M extends RpcMethodName>(method: M, params: RpcParams<M>): Promise<RpcResult<M>> {
    // A closed client never sends again — failing now beats waiting out the timeout for nothing (#82)
    if (this.closed) return Promise.reject(rpcError('Connection closed', 'connection_closed', false))
    const id = String(this.nextId++)
    const frame = JSON.stringify({ kind: 'rpc', id, method, params })
    /*
     * Admission (#82). A call over a bound is refused **before** it is queued or sent, so its
     * outcome is certain — nothing happened — and it is safe to try again later.
     */
    const maxPending = this.opts.maxPendingCalls ?? DEFAULT_MAX_PENDING_CALLS
    if (this.pending.size >= maxPending) {
      return Promise.reject(rpcError(`Too many requests are waiting for the host (${maxPending}); this one was not sent`, 'overloaded', true))
    }
    const bytes = this.ready ? 0 : new TextEncoder().encode(frame).byteLength
    const maxQueued = this.opts.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES
    if (this.queuedBytes + bytes > maxQueued) {
      return Promise.reject(rpcError('Too much is waiting for the host to reconnect; this request was not sent', 'overloaded', true))
    }
    return new Promise<RpcResult<M>>((resolve, reject) => {
      /*
       * The timeout safety net. onclose catches a disconnect, but if the socket is fine and
       * the host swallows the response (a handler bug, a hang), nobody rejects it — pending
       * grows without bound and that call's UI waits forever. A call that never left the queue
       * is also cleaned up here.
       */
      const timer = setTimeout(() => {
        if (!this.take(id)) return
        reject(Object.assign(new Error(`RPC timed out: ${method}`), { code: 'timeout', retryable: true }))
      }, this.opts.callTimeoutMs ?? (method === 'apps.invoke' ? APP_CALL_TIMEOUT_MS : LONG_CALLS.has(method) ? LONG_CALL_TIMEOUT_MS : DEFAULT_CALL_TIMEOUT_MS))
      // Sent now if the host is ready, otherwise after the next hello_ok
      const ws = this.ready ? this.ws : null
      this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject, timer, frame: ws ? null : frame, bytes })
      this.queuedBytes += bytes
      ws?.send(frame)
    })
  }

  onEvent(handler: (e: NormalizedEvent) => void): Unsubscribe {
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
    for (const h of this.connHandlers) h(s)
  }

  /**
   * Shuts the client down for good (#82): no reconnect timer, handshake timer or call timer is
   * left behind, every waiting call is rejected now, and later calls fail at once. A pending
   * reconnect timer used to survive close() (it found `closed` and did nothing, but held the
   * process open until it fired), and a call made after close() sat for its full timeout.
   */
  close(): void {
    this.closed = true
    this.ready = false
    this.clearTimers()
    this.detach(this.ws)
    this.ws = null
    for (const [id] of [...this.pending]) {
      // take() clears the timer — if it is not cleared, a closed client keeps the process alive
      this.take(id)?.reject(rpcError('Connection closed', 'connection_closed', false))
    }
  }
}

function toError(e: ProtocolError): Error {
  return Object.assign(new Error(e.message), { code: e.code, retryable: e.retryable })
}
