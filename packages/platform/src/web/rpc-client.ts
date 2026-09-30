import {
  PROTOCOL_VERSION,
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
}

/**
 * `sent`: whether the frame actually went out over the socket.
 * On disconnect, rejects **only what went out** — what is still in the queue is sent after
 * reconnecting, per the existing contract.
 */
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout>; sent: boolean }

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
  private pending = new Map<string, Pending>()
  private eventHandlers = new Set<(e: NormalizedEvent) => void>()
  private termHandlers = new Set<(e: { terminalId: string; data: string }) => void>()
  private termExitHandlers = new Set<(e: { terminalId: string; exitCode: number | null }) => void>()
  private connHandlers = new Set<(s: ConnectionState) => void>()
  private nextId = 1
  private lastSeq = 0
  /**
   * This hello did not carry `afterSeq` — this is a first meeting with this host (#173). For a
   * hello like that, the host replays its whole buffer, and that is all stuff that already
   * finished before the screen was attached. Passing it through as received would mean, on
   * every fresh page load, a "done" card standing for every finished turn, a sound playing, and
   * old fragments building a conversation. On a first meeting with a host, the list and the
   * store (the snapshot) are the starting point instead.
   */
  private firstContact = false
  /** The end number of old events replayed by a first-met host — up to here, nothing is passed through as a new event */
  private replayedUpTo = 0
  /** Whether a handshake with a host has ever completed — a first meeting after that (a new host) means the screen has to re-read what it is holding */
  private greeted = false
  private attempt = 0
  private closed = false
  private queue: { id: string; frame: string }[] = []
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
    this.lastSeq = 0 // A new host numbers events from the start
    /*
     * **Detaches the old socket's handlers first.** close() is asynchronous, so onclose fires
     * later, and if left as is, that onclose would clear the reference to the new socket
     * (this.ws) just created and open yet another reconnect — two sockets receiving the same
     * events, applying a streaming delta twice (measured).
     */
    const old = this.ws
    if (old) {
      old.onopen = null
      old.onmessage = null
      old.onclose = null
      old.onerror = null
      old.close()
    }
    this.ws = null
    // The response to an RPC sent to the old host will never arrive — if this does not reject
    // it, optimistic UI waits forever for confirmation, stuck at 'working' (the onclose handler was just detached)
    this.failInFlight('Host restarted')
    this.connect()
  }

  constructor(private opts: RpcClientOptions) {
    this.WS = opts.WebSocketImpl ?? WebSocket
  }

  get connectionState(): ConnectionState {
    if (this.closed) return 'disconnected'
    return this.ws?.readyState === 1 ? 'connected' : 'connecting'
  }

  connect(): void {
    if (this.closed) return
    // Does not create one if a socket already exists — if the backoff timer and updateEndpoint overlap, this could end up with two
    if (this.ws) return
    this.emitConn('connecting')
    const ws = new this.WS(this.opts.url)
    this.ws = ws

    ws.onopen = () => {
      this.attempt = 0
      this.firstContact = this.lastSeq === 0
      ws.send(
        JSON.stringify({
          kind: 'hello',
          token: this.opts.token,
          protocolVersion: PROTOCOL_VERSION,
          ...(this.lastSeq > 0 ? { afterSeq: this.lastSeq } : {}),
        }),
      )
      for (const q of this.queue.splice(0)) {
        ws.send(q.frame)
        // From here on this is a call that is 'sent and waiting for an answer' — a candidate for rejection at the next disconnect
        const p = this.pending.get(q.id)
        if (p) p.sent = true
      }
      this.emitConn('connected')
    }

    ws.onmessage = (e: MessageEvent) => {
      if (this.ws !== ws) return // Ignores a leftover frame from a socket that has been replaced
      this.onFrame(String(e.data))
    }

    ws.onclose = () => {
      if (this.ws !== ws) return // If it has already been replaced, leaves the new socket alone
      this.ws = null
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
      setTimeout(() => this.connect(), delay)
    }

    ws.onerror = () => {
      /* Does nothing here, since onclose follows */
    }
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
      const greeted = this.greeted
      this.greeted = true
      if (this.firstContact) {
        // A first-met host's replay is not a new event — only its number is caught up to. If the screen was already
        // holding something (it switched to a new host), that has to be re-read
        this.replayedUpTo = frame.currentSeq
        this.lastSeq = frame.currentSeq
        if (greeted) this.emitConn('resync_required')
        return
      }
      this.replayedUpTo = 0
      /*
       * The host's number is smaller than what we already received — the host came back up on
       * the same address (#173). Holding onto the old number would keep the value from going
       * down because of `Math.max`, so nothing would ever be replayed on any disconnect until
       * the new host's number passed the old value. Instead, this drops down to the new host's
       * number, and reads whatever was missed back from the snapshot.
       */
      if (frame.currentSeq < this.lastSeq) {
        this.lastSeq = frame.currentSeq
        this.emitConn('resync_required')
        return
      }
      if (frame.resyncRequired) this.emitConn('resync_required')
      return
    }
    if (frame.kind === 'event') {
      this.lastSeq = Math.max(this.lastSeq, frame.seq)
      if (frame.seq <= this.replayedUpTo) return
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
      if (frame.ok) p.resolve(frame.result)
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
    const f = json as { kind?: unknown; id?: unknown; error?: { message?: unknown } }
    if (f?.kind !== 'res' || typeof f.id !== 'string') return
    const p = this.take(f.id)
    if (!p) return
    const message = typeof f.error?.message === 'string' ? f.error.message : 'Malformed response from the host'
    p.reject(Object.assign(new Error(message), { code: 'internal', retryable: false }))
  }

  /** Takes one out of pending — "taking out" includes clearing its timer and the queue (otherwise a ghost timer stays behind) */
  private take(id: string): Pending | undefined {
    const p = this.pending.get(id)
    if (!p) return undefined
    this.pending.delete(id)
    clearTimeout(p.timer)
    this.queue = this.queue.filter((q) => q.id !== id)
    return p
  }

  /** Rejects every call that was sent but got no answer (marked retryable) */
  private failInFlight(reason: string): void {
    for (const [id, p] of [...this.pending]) {
      if (!p.sent) continue
      this.take(id)
      p.reject(Object.assign(new Error(reason), { code: 'connection_lost', retryable: true }))
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
    const id = String(this.nextId++)
    const frame = JSON.stringify({ kind: 'rpc', id, method, params })
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
      const sent = this.ws?.readyState === 1
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, sent })
      if (sent) this.ws!.send(frame)
      else this.queue.push({ id, frame }) // Sent after reconnecting
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

  close(): void {
    this.closed = true
    this.ws?.close()
    this.ws = null
    for (const [, p] of this.pending) {
      clearTimeout(p.timer) // If the timer is not cleared, a closed client keeps the process alive
      p.reject(new Error('Connection closed'))
    }
    this.pending.clear()
    this.queue = []
  }
}

function toError(e: ProtocolError): Error {
  return Object.assign(new Error(e.message), { code: e.code, retryable: e.retryable })
}
