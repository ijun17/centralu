import type { NormalizedEvent, SessionActivity } from '@cc/protocol'

/**
 * The `retrying` activity while a tool retries a failed request on its own (#168, #304): Claude Code's
 * `system/api_retry`, Codex's `error {willRetry}`. Neither sends a "recovered" message — the next output is the sign
 * that it flows again, so that is where the activity showing before the retry is put back. The two adapters kept the
 * same rule twice.
 */
export class RetryActivity {
  private retrying = false
  private before: SessionActivity | null = null

  constructor(private readonly sessionId: string) {}

  /**
   * An activity event the tool sent: whether it goes out. Each attempt sends its own `retrying`, and one indication is
   * enough. Any other activity says what is happening now by itself, which ends the retry indication too.
   */
  admit(activity: SessionActivity | null): boolean {
    if (activity === 'retrying') {
      if (this.retrying) return false
      this.retrying = true
      return true
    }
    this.before = activity
    this.retrying = false
    return true
  }

  /** Output flows again: what was showing before the retry, once */
  resumed(): NormalizedEvent | null {
    if (!this.retrying) return null
    this.retrying = false
    return { type: 'activity', sessionId: this.sessionId, activity: this.before }
  }

  /** A finished turn takes its activity with it (the state machine clears it on leaving working) */
  ended(): void {
    this.retrying = false
    this.before = null
  }
}
