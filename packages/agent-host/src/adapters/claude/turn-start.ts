/**
 * How long Claude Code may take to show it read input given it while no turn runs. Measured on CLI 2.1.296 with SDK 0.3.263
 * (2026-11-21, Windows): it says `command_lifecycle` "queued" for the input 0.4 s after it, before anything else, and the turn's `init`
 * 0.45 s after it (1.0 s resuming a 51 MB conversation), but `init` waits for MCP servers: with one that never answers it came at 30.4 s,
 * the CLI's connect timeout. So past that, and under the mailbox's wait for a wake (`MAIL_ACCEPT_MS`), so a wake given back by this
 * fails and the mailbox sends it again
 */
export const TURN_START_MS = 60_000

/** What says the CLI read an input: its delivery receipt (`command_lifecycle`, which the SDK's types leave out), a turn's init, or the turn itself */
type CliMessage = { type?: string; subtype?: string }
const readsInput = (m: CliMessage) =>
  m.type === 'command_lifecycle' || m.type === 'assistant' || m.type === 'stream_event' || m.type === 'result' || (m.type === 'system' && m.subtype === 'init')

/**
 * The wait for Claude Code to show it read input given it at rest. A CLI drops an input whose id it has already read without a word (measured
 * on 2.1.296: no receipt, no turn, no result): past `TURN_START_MS` with no sign it read it, `lapsed` gives the input back, so the session
 * does not read as working on a turn the CLI never opened
 */
export class TurnStartWait {
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly lapsed: () => void) {}

  /** Input went to the CLI with no turn running. A wait already running is kept */
  expect(): void {
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.lapsed()
    }, TURN_START_MS)
    this.timer.unref?.()
  }

  /** A message of the CLI's: one that says it read an input ends the wait */
  saw(m: CliMessage): void {
    if (readsInput(m)) this.stop()
  }

  /** Nothing is waited for any more: a Stop, or the session closed */
  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
