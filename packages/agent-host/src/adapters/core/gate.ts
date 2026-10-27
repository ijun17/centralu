/**
 * The approval gate's host side, for a tool that asks through a hook process rather than on its own wire (`agy`'s
 * PreToolUse hook, antigravity-adapter.md §5; #1654 seam gap 3). The hook is a separate process the tool starts per call:
 * it reaches this host, waits for a decision and prints it. Measured on `agy` 1.4.7: a hook that prints nothing and exits 0
 * lets the tool run (every other failure denies), so the hook must always print an answer; and SIGINT is not acted on
 * while a hook waits, so a Stop answers every open request `deny` before it signals (`SessionProcess.interrupt`).
 */

/** What the gate prints for the tool. Never "ask": print mode cannot ask (measured) */
export type GateAnswer = { decision: 'allow' } | { decision: 'deny'; reason: string }

/** One call the hook asks about, as it reads the tool's hook input */
export type GateRequest = {
  /** Unique per session while open: the hook's own id for the call */
  requestId: string
  tool: string
  input: unknown
  /** The tool's step the call belongs to (`agy`: the stream's `step_index`), so the card joins the call already drawn */
  stepIndex?: number
}

/**
 * The hook's way back to this host (#1654 comment on §8.1, session-core.md): a route on the host's front door under a
 * gate-only key of the session's own (`transport/gate-door.ts`). It is opened per session before the tool starts, its `env`
 * goes into the tool's environment (the hook inherits it, measured), it fails closed (an unreachable host is a `deny`),
 * and closing it revokes the key and denies what is still open.
 *
 * The channel **asks and never answers**: what a caller sends is a call to decide on, read by `read`; the decision is
 * `decide`'s alone (the preset, the always-allow rules or the person's card), never the caller's.
 */
export interface GateInbound {
  open(sessionId: string, gate: GateHandler): Promise<GateChannel>
}

/** What a session's gate does with what its hook posts */
export type GateHandler = {
  /**
   * The tool's hook input as the hook posted it (a JSON object, with no decision in it: the door refuses one that carries
   * one), read into a request; null when it is not a call this tool's gate reads, which the hook then denies
   */
  read(input: Readonly<Record<string, unknown>>): GateRequest | null
  /** The decision on one request. A Stop answers it `deny` (`GateRequests.denyAll`); a rejection is a `deny` too */
  decide(request: GateRequest): Promise<GateAnswer>
}

/**
 * The environment names the hook reads (`adapters/agy/gate-answer.mjs`, which imports nothing and so spells them
 * itself; `gate-door.test.ts` drives that file with a channel's `env`, so the two cannot drift apart). Tool-neutral:
 * the route is the front door's, and the next hook-gated tool uses the same names
 */
export const GATE_ENV = { url: 'CC_GATE_URL', token: 'CC_GATE_TOKEN' } as const

export type GateChannel = {
  /** What the hook needs to find this host and prove the session (`GATE_ENV`); no file holds it */
  readonly env: Readonly<Record<string, string>>
  close(): Promise<void>
}

/** The gate requests of one session still waiting for an answer, so a Stop or a close can deny them all at once */
export class GateRequests {
  private readonly open = new Map<string, (answer: GateAnswer) => void>()
  /** Set once the session has closed: a request asked after that is denied at once, never left waiting */
  private closedReason: string | null = null
  /** The reasons of the Stops under way (`hold`): while there is one, a request asked is denied at once */
  private readonly holds: string[] = []

  /**
   * Waits for the answer to one request: given by `answer`, or `deny` by `denyAll`. A second wait for the same id denies the
   * first: only ever a deny, so a request asked again (or forged with an open id) can end a wait but never allow a call
   */
  wait(requestId: string): Promise<GateAnswer> {
    const refused = this.closedReason ?? this.holds[this.holds.length - 1]
    if (refused !== undefined) return Promise.resolve({ decision: 'deny', reason: refused })
    this.answer(requestId, { decision: 'deny', reason: 'The request was asked again.' })
    return new Promise((resolve) => this.open.set(requestId, resolve))
  }

  /**
   * A Stop is under way: what is open is denied now, and so is what a dying process asks until `release` (its grace can run
   * seconds, and a request it asks then would wait for the next start). Stops overlap, each releasing only its own hold
   */
  hold(reason: string): () => void {
    this.holds.push(reason)
    this.denyAll(reason)
    let released = false
    return () => {
      if (released) return
      released = true
      this.holds.splice(this.holds.lastIndexOf(reason), 1)
    }
  }

  /** The session's end: what is open is denied, and so is what asks later */
  close(reason: string): void {
    this.closedReason = reason
    this.denyAll(reason)
  }

  /** False when the request is no longer open (answered, or denied by a Stop) */
  answer(requestId: string, answer: GateAnswer): boolean {
    const settle = this.open.get(requestId)
    if (!settle) return false
    this.open.delete(requestId)
    settle(answer)
    return true
  }

  /** Answers every open request `deny`; how many there were */
  denyAll(reason: string): number {
    const settles = [...this.open.values()]
    this.open.clear()
    for (const settle of settles) settle({ decision: 'deny', reason })
    return settles.length
  }

  get size(): number {
    return this.open.size
  }
}
