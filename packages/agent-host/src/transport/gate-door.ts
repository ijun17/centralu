import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { GATE_DECISION_FIELDS, isSessionId, RpcMethods } from '@cc/protocol'
import { GATE_ENV, GateRequests, type GateAnswer, type GateChannel, type GateHandler, type GateInbound } from '../adapters/core/gate.js'
import { sameSecret } from './http.js'
import { METHOD_RIGHTS, type Rights } from './method-rights.js'

/**
 * The gate's inbound path (#1654, the decision on session-core.md §8.1): a route on the host's front door under a
 * **gate-only key of the session's own**, for a tool whose approvals arrive through a hook process (`agy`'s
 * `PreToolUse` hook, `adapters/agy/gate-answer.mjs`). Not the bridge credential, and no new listener.
 *
 * **The key.** Random per session (32 bytes), held in this object's memory only, never derived from the host's token
 * and never written down. Closing the session's channel revokes it, and a host that starts (a restart, a swap) has none:
 * a hook still holding an old key gets the front door's 404, and denies. Why not the bridge credential: that one is an
 * HMAC of the host's token, so it outlives the session and every swap, and it opens the session's orchestrator and app
 * tools; in the tool's environment it would let the agent's own shell call them directly, around what the tool asks
 * before an MCP call. Why not the HTTP door's secret (`http.ts`): the same, and it opens the app views.
 *
 * **One method.** The key raises `gate.ask` for its session and nothing else: its rights class is `gate`
 * (`method-rights.ts`), which the limited credential, a bridge and the WebSocket are all refused (`gateRefusal` reads the
 * same table). The key is never a hello on the WebSocket (`server.ts` knows no such credential), and the HTTP door's
 * routes still want their own secret.
 *
 * **It asks and never answers.** A request is the tool's hook input, refused when it carries a decision field
 * (`DECISION_FIELDS`); the decision is the session's `GateHandler.decide` (the preset, the always-allow rules, the
 * person's card). The person's answers stay `window` in the rights table. So the agent's shell, which inherits the key
 * with the tool's environment, can raise a card (noise the person sees and can deny) and nothing more.
 *
 * **The answer.** Headers at once, then a space every `heartbeatMs` while the card is open: Node's `fetch` in the hook
 * gives up on an answer whose headers or next body chunk take over 300 s (measured, antigravity-adapter.md §5.1), and
 * JSON reads leading spaces as nothing. Then one JSON object, `{decision}` or `{decision: 'deny', reason}`. A reason never
 * carries the key or another credential (`scrub`).
 */

/** The route's path: `/gate/<sessionId>` on the front door's port, outside the HTTP door's secret segment */
export const GATE_PATH = /^\/gate\/([^/]+)$/

/** The method a gate key raises, the one row of `METHOD_RIGHTS` in the `gate` class */
export const GATE_METHOD = 'gate.ask'

/**
 * Top-level fields a request may not carry (the protocol's `gate.ask` schema): the channel asks and never answers, so a
 * body that looks like an answer is refused outright rather than ignored
 */
export const DECISION_FIELDS: readonly string[] = GATE_DECISION_FIELDS

/** What the door holds to (`FrontDoorGates`'s options) */
export const GATE_LIMITS = {
  /** A space this often while a card is open: well inside `fetch`'s 300 s */
  heartbeatMs: 30_000,
  /** The largest hook input read: a call writing a file carries the file */
  maxBodyBytes: 8 * 1024 * 1024,
  /** Requests one session may have open at once; past it a request is refused (429), so a loop in a shell cannot grow memory */
  maxOpenPerSession: 32,
  /** The longest reason passed on to the tool */
  maxReasonChars: 2000,
} as const

const KEY_PREFIX = 'ccg1'

/** What a credential of this host looks like in a sentence (`ccb1:` bridge, `ccl1:` limited, `ccg1:` gate), for `scrub` */
const CREDENTIAL_SHAPE = /\bcc[a-z]\d:[A-Za-z0-9_:-]+/g

/** The parameters `gate.ask` is judged on: the session the URL names and the hook's input */
export type GateAskParams = { sessionId: string; request: Readonly<Record<string, unknown>> }

/**
 * Why a caller holding the gate key of `boundSession` may not make this call, or null if it may: the method must be in
 * the `gate` class of `METHOD_RIGHTS` (one table says who may call what), name the bound session, and carry no decision.
 */
export function gateRefusal(boundSession: string, method: string, params: unknown): string | null {
  const judged = gateAsk(boundSession, method, params)
  return judged.ok ? null : judged.refusal
}

/** `gateRefusal`, with the parameters as parsed when the call may be made */
function gateAsk(boundSession: string, method: string, params: unknown): { ok: true; params: GateAskParams } | { ok: false; refusal: string } {
  const table: Readonly<Record<string, Rights>> = METHOD_RIGHTS
  if (!Object.prototype.hasOwnProperty.call(table, method) || table[method] !== 'gate') return { ok: false, refusal: `A gate key cannot call ${method}` }
  const named = params !== null && typeof params === 'object' && 'sessionId' in params ? params.sessionId : undefined
  if (named !== boundSession) return { ok: false, refusal: 'This gate key is for another session' }
  // The method's own schema: a session id, a JSON object, no decision field, nothing else
  const parsed = RpcMethods['gate.ask'].params.safeParse(params)
  return parsed.success ? { ok: true, params: parsed.data } : { ok: false, refusal: parsed.error.issues[0]?.message ?? 'Not a gate request' }
}

type Open = {
  key: string
  gate: GateHandler
  /** This channel's requests still waiting, by a number of its own (a hook's id may repeat): a close denies them all */
  waiting: GateRequests
  serial: number
}

export type FrontDoorGatesOptions = {
  /** The address a session's hook posts to: the front door's, so it outlives a swap of the host behind it */
  url: (sessionId: string) => string | null
  /** Values no reason may carry besides the keys (the host's token, the HTTP door's secret) */
  redact?: () => readonly string[]
  heartbeatMs?: number
  maxBodyBytes?: number
  maxOpenPerSession?: number
}

/** The front door's gate route and the keys it accepts (`GateInbound`); one per host, in memory */
export class FrontDoorGates implements GateInbound {
  private readonly open_ = new Map<string, Open>()
  private readonly heartbeatMs: number
  private readonly maxBodyBytes: number
  private readonly maxOpen: number

  constructor(private readonly opts: FrontDoorGatesOptions) {
    this.heartbeatMs = opts.heartbeatMs ?? GATE_LIMITS.heartbeatMs
    this.maxBodyBytes = opts.maxBodyBytes ?? GATE_LIMITS.maxBodyBytes
    this.maxOpen = opts.maxOpenPerSession ?? GATE_LIMITS.maxOpenPerSession
  }

  /**
   * A new key for `sessionId`. A channel still open for it is closed first (its key revoked, its requests denied), so a
   * session has one key at a time. Fails when the host has no address yet (before it listens)
   */
  open(sessionId: string, gate: GateHandler): Promise<GateChannel> {
    if (!isSessionId(sessionId)) return Promise.reject(new Error('Not a session id'))
    const url = this.opts.url(sessionId)
    if (!url) return Promise.reject(new Error('The host has no address for a gate yet'))
    this.revoke(sessionId, 'The session’s gate was opened again.')
    const entry: Open = { key: `${KEY_PREFIX}:${randomBytes(32).toString('base64url')}`, gate, waiting: new GateRequests(), serial: 0 }
    this.open_.set(sessionId, entry)
    const env = Object.freeze({ [GATE_ENV.url]: url, [GATE_ENV.token]: entry.key })
    return Promise.resolve({
      env,
      close: () => {
        // Only this channel's own key: a later open for the same session is not closed by an earlier channel
        if (this.open_.get(sessionId) === entry) this.revoke(sessionId, 'The session is closing.')
        else entry.waiting.close('The session is closing.')
        return Promise.resolve()
      },
    })
  }

  /** The host is going: every key is revoked and every open request denied, before its connections are cut */
  closeAll(reason: string): void {
    for (const sessionId of [...this.open_.keys()]) this.revoke(sessionId, reason)
  }

  /** How many sessions hold a key (for tests and the log) */
  get size(): number {
    return this.open_.size
  }

  private revoke(sessionId: string, reason: string): void {
    const entry = this.open_.get(sessionId)
    if (!entry) return
    this.open_.delete(sessionId)
    entry.waiting.close(reason)
  }

  /**
   * Takes the request when it is a gate request with a key this host holds for the session its path names, and returns
   * true; otherwise false and nothing is read or written, so the front door answers it with the same 404 as any path it
   * does not serve (a wrong key, another session's key, a revoked one and no route at all look the same).
   */
  take(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.method !== 'POST') return false
    let path: string
    try {
      path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    } catch {
      return false
    }
    const sessionId = GATE_PATH.exec(path)?.[1]
    if (!sessionId) return false
    const entry = this.open_.get(sessionId)
    const given = bearer(req.headers.authorization)
    // Compared even when no session matches, so the answer takes as long either way
    const matches = sameSecret(given ?? '', entry?.key ?? '')
    if (!entry || given === null || !matches) return false
    this.serve(sessionId, entry, req, res).catch((e: unknown) => {
      // Only the message's class of fault goes to the log: never the request, which carries the tool's input
      console.error(`[agent-host] gate route failed: ${e instanceof Error ? e.name : 'error'}`)
      plain(res, 500, 'internal error')
    })
    return true
  }

  private async serve(sessionId: string, entry: Open, req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: string
    try {
      body = await readBody(req, this.maxBodyBytes)
    } catch {
      return plain(res, 413, 'too large')
    }
    let request: unknown
    try {
      request = JSON.parse(body)
    } catch {
      return plain(res, 400, 'not json')
    }
    const judged = gateAsk(sessionId, GATE_METHOD, { sessionId, request })
    if (!judged.ok) return plain(res, 400, 'not a gate request')
    const params = judged.params
    // Closed while the body was read: its key is gone, and so is the gate
    if (this.open_.get(sessionId) !== entry) return plain(res, 404, 'not found')
    if (entry.waiting.size >= this.maxOpen) return plain(res, 429, 'too many open requests')
    let read
    try {
      read = entry.gate.read(params.request)
    } catch {
      read = null
    }
    if (!read) return plain(res, 400, 'not a call this gate reads')

    const id = String(++entry.serial)
    const answer = entry.waiting.wait(id)
    // A decide that throws at once is a deny like one that rejects
    Promise.resolve(read).then((r) => entry.gate.decide(r)).then(
      (a) => entry.waiting.answer(id, a),
      () => entry.waiting.answer(id, { decision: 'deny', reason: 'Centralu could not decide on this call, so it was not run.' }),
    )

    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
    res.flushHeaders()
    const beat = setInterval(() => {
      if (!res.writableEnded && !res.destroyed) res.write(' ')
    }, this.heartbeatMs)
    res.once('close', () => clearInterval(beat))
    const decided = await answer
    clearInterval(beat)
    if (res.writableEnded || res.destroyed) return
    res.end(JSON.stringify(this.outward(decided, entry.key)))
  }

  /** The answer as the hook gets it: only the two fields, and a reason with no credential in it */
  private outward(answer: GateAnswer, key: string): GateAnswer {
    if (answer.decision === 'allow') return { decision: 'allow' }
    return { decision: 'deny', reason: scrub(String(answer.reason ?? ''), [key, ...(this.opts.redact?.() ?? [])]) || 'Centralu did not allow this call.' }
  }
}

/** `reason` without any of `secrets` or anything shaped like this host's credentials, and not past the length bound */
export function scrub(reason: string, secrets: readonly string[]): string {
  let out = reason
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join('[redacted]')
  out = out.replace(CREDENTIAL_SHAPE, '[redacted]')
  return out.length > GATE_LIMITS.maxReasonChars ? `${out.slice(0, GATE_LIMITS.maxReasonChars)}…` : out
}

function bearer(header: string | undefined): string | null {
  return /^Bearer (\S+)$/.exec(header ?? '')?.[1] ?? null
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > limit) {
        reject(new Error('too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function plain(res: ServerResponse, status: number, body: string): void {
  if (res.writableEnded || res.destroyed) return
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(body)
}
