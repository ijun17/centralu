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
 * The hook's way back to this host: **an interface only** until the transport is decided (PR 3's decision: a loopback
 * listener with a per-session token, or a route on the host's front door under the bridge credential). Whichever it is,
 * it is opened per session before the tool starts, its `env` goes into the tool's environment (the hook inherits it,
 * measured), it fails closed (an unreachable host is a `deny`), and closing it denies what is still open.
 */
export interface GateInbound {
  open(sessionId: string, decide: (request: GateRequest) => Promise<GateAnswer>): Promise<GateChannel>
}

export type GateChannel = {
  /** What the hook needs to find this host and prove the session (names and values per transport); no file holds it */
  readonly env: Readonly<Record<string, string>>
  close(): Promise<void>
}

/** The gate requests of one session still waiting for an answer, so a Stop or a close can deny them all at once */
export class GateRequests {
  private readonly open = new Map<string, (answer: GateAnswer) => void>()

  /** Waits for the answer to one request: given by `answer`, or `deny` by `denyAll`. A second wait for the same id denies the first */
  wait(requestId: string): Promise<GateAnswer> {
    this.answer(requestId, { decision: 'deny', reason: 'The request was asked again.' })
    return new Promise((resolve) => this.open.set(requestId, resolve))
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
