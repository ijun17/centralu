/** How many ended turns `endedTurns` keeps: more than can have a `turn/start` response still in flight */
const ENDED_TURNS_KEPT = 8

/** Which of a thread's turns is running, which have ended, and which we asked Codex to interrupt (`CodexSession`) */
export class CodexTurns {
  /**
   * The id of the turn currently running — **needed in order to stop it** (dogfooding
   * 2026-09-07: stop did not work).
   *
   * `turn/interrupt` does not work with only a threadId. Measured behavior: the server rejects
   * it with `Invalid request: missing field \`turnId\``(-32600), and we were only piping that
   * rejection into an error event — the screen looked stopped but the turn ran to completion.
   * So we capture this **from both** the turn/started notification and the turn/start response:
   * if stop is pressed very quickly, the response can arrive before the notification.
   */
  turnId: string | null = null
  /**
   * Turns already reported ended (`turn/completed`/`turn/failed`), the latest few. The `turn/start` response can
   * arrive after its own turn's `turn/completed`; taking the id from that late response would bring a finished
   * turn back as the target of Stop, and the next Stop would send `turn/interrupt` for a dead turn and say
   * "Could not stop". Bounded: only a response still in flight can name one of these.
   */
  private endedTurns: string[] = []
  /**
   * Turns we asked Codex to interrupt (#698), the latest few: a Stop, a delegation withdrawn, a parent's note cancelled.
   * A `turn/completed` with `interrupted` for any other turn was not asked for here, and says so (`INTERRUPTED_BY_TOOL`).
   */
  private interruptsSent: string[] = []

  /** A turn ended (`turn/completed`/`turn/failed`): there is no running turn to stop now */
  ended(ended: string | null): void {
    this.turnId = null
    if (ended) this.endedTurns = [...this.endedTurns.slice(-(ENDED_TURNS_KEPT - 1)), ended]
  }

  hasEnded(turnId: string): boolean {
    return this.endedTurns.includes(turnId)
  }

  /** A running turn's id from a response, unless the notifications already named one or already ended it (see `CodexSession.takeStartedTurn`) */
  take(id: string | null): void {
    if (id && !this.endedTurns.includes(id)) this.turnId ??= id
  }

  noteInterruptSent(turnId: string): void {
    if (!this.interruptsSent.includes(turnId)) this.interruptsSent = [...this.interruptsSent.slice(-(ENDED_TURNS_KEPT - 1)), turnId]
  }

  /** We asked Codex to interrupt this turn (#698) */
  interruptSent(turnId: string): boolean {
    return this.interruptsSent.includes(turnId)
  }
}
