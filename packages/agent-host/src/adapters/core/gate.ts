/**
 * The approval gate's open requests, for a tool that asks through a process of its own rather than on its wire: a Stop
 * or a close answers every open request `deny` at once, before the process hears of it (`SessionProcess`). The hook-path
 * transport that once fed it (a front-door route under a per-session key, for `agy -p`) is retired (#59).
 */

/** What the gate prints for the tool. Never "ask": print mode cannot ask (measured) */
export type GateAnswer = { decision: 'allow' } | { decision: 'deny'; reason: string }

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
