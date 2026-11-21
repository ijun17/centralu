/**
 * How long Claude Code may take to start a turn for input given it while no turn runs. Measured on CLI 2.1.296 with SDK 0.3.263
 * (2026-11-21, Windows, three runs each): the turn's `init` came 0.45 s after the input, 0.6 s with the person's settings and
 * plugins, and 1.0 s resuming a 51 MB conversation. Under the mailbox's wait for a wake (`MAIL_ACCEPT_MS`), so a wake given
 * back by this fails, and the mailbox sends it again
 */
export const TURN_START_MS = 30_000

/**
 * The wait for Claude Code to start a turn for input given it at rest. A CLI that drops an input starts no turn and answers
 * nothing (an input whose id it has recorded, measured on 2.1.296): past `TURN_START_MS` with no word of a turn, `lapsed` gives
 * the input back, so the session does not read as working on a turn the CLI never opened
 */
export class TurnStartWait {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly lapsed: () => void) {}

  /** Input went to the CLI with no turn running: a turn should begin. A wait already running is kept */
  expect(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.lapsed()
    }, TURN_START_MS)
    this.timer.unref?.()
  }

  /** The CLI said something of a turn, or the session closed */
  heard(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
