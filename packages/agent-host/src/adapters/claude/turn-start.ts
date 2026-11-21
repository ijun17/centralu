import { receiptsInputs } from './tracked-input.js'

/**
 * How long Claude Code may take to show it read input given it while no turn runs. Measured on CLI 2.1.288, 2.1.289, 2.1.296 and 2.1.316
 * (SDK 0.3.263): it says `command_lifecycle` "queued" for the input 0.26–0.84 s after it, before anything else, also while the turn's
 * `init` waits 90 s on a slow MCP server. So far past that, and under the mailbox's wait for a wake (`MAIL_ACCEPT_MS`), so a wake given
 * back by this fails and the mailbox sends it again
 */
export const TURN_START_MS = 60_000

/** What the wait reads of the CLI's messages: its init, and its delivery receipt (`command_lifecycle`, which the SDK's types leave out) */
type CliMessage = { type?: string; subtype?: string; command_uuid?: unknown; claude_code_version?: unknown; capabilities?: unknown }

/**
 * The wait for Claude Code to show it read input given it at rest. A CLI drops an input whose id it has already read without a word (measured
 * on 2.1.296: no receipt, no turn, no result): past `TURN_START_MS` with no receipt for an input written since the wait began, `lapsed`
 * gives the input back, so the session does not read as working on a turn the CLI never opened.
 *
 * Only a CLI known to send the receipt (`receiptsInputs`) is waited for: from its first input by the version the host started (`version`), and
 * by what each init says once one came, which wins. One of an older or unknown version is not: given back, an input such a CLI did read would
 * run twice. A wake it never takes is counted delivered by the mailbox after `MAIL_ACCEPT_MS`, and the session reads as working until a Stop
 */
export class TurnStartWait {
  private timer: ReturnType<typeof setTimeout> | null = null
  /** The ids input went to the CLI under since the wait began */
  private readonly written = new Set<string>()
  /** Whether the CLI is known to send the receipt */
  private receipts: boolean

  constructor(private readonly lapsed: () => void, version: string | undefined) {
    this.receipts = receiptsInputs({ claude_code_version: version })
  }

  /** Input is about to go to the CLI with no turn running. A wait already running is kept */
  expect(): void {
    if (!this.receipts || this.timer) return
    this.timer = setTimeout(() => {
      this.stop()
      this.lapsed()
    }, TURN_START_MS)
    this.timer.unref?.()
  }

  /** Input went to the CLI under this id */
  wrote(id: string): void {
    if (this.timer) this.written.add(id)
  }

  /** A message of the CLI's: the receipt for an input written since the wait began ends it */
  saw(m: CliMessage): void {
    if (m.type === 'system' && m.subtype === 'init') {
      this.receipts = receiptsInputs(m)
      // A CLI that says it sends none is not waited for: any wait running ends
      if (!this.receipts) this.stop()
    }
    if (m.type === 'command_lifecycle' && typeof m.command_uuid === 'string' && this.written.has(m.command_uuid)) this.stop()
  }

  /** Nothing is waited for any more: a receipt, a Stop, or the session closed */
  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.written.clear()
  }
}
