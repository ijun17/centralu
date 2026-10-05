/**
 * Lets Claude processes start one at a time, a fixed gap apart (#353).
 *
 * On Windows Claude Code keeps its sign-in in a file and lets one process at a time refresh it,
 * behind a lock. When the access token has expired, every Claude process that starts refreshes it,
 * and one that finds another process mid-refresh ends its turn with "Failed to refresh OAuth token:
 * another Claude Code process is refreshing it". A terminal starts one process; Centralu can start
 * several in the same second (the orchestrator waking its sessions, a grid, app builders). Spacing
 * the starts lets the first refresh finish before the next process looks.
 *
 * Each call reserves the next free slot at once, so callers start in the order they asked; the
 * first caller after a quiet spell starts immediately.
 */
export class StartGate {
  /** The earliest moment the next start may happen */
  private next = 0

  constructor(
    private readonly gapMs: number,
    private readonly now: () => number = Date.now,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async turn(): Promise<void> {
    if (this.gapMs <= 0) return
    const t = this.now()
    const at = Math.max(t, this.next)
    this.next = at + this.gapMs
    if (at > t) await this.sleep(at - t)
  }
}
