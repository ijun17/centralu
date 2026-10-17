import type { EventSink } from '../contract.js'
import type { ClaudeInput } from './sdk-query.js'

/**
 * Claude Code's words when a process lost the race to refresh the sign-in (#353). Read in the CLI
 * (2.1.289): the error is an API error message the CLI writes itself (`error: "server_error"`), in
 * one of two wordings — the first in a headless session like ours, the second in the terminal:
 *
 *   Failed to refresh OAuth token: another Claude Code process is refreshing it or exited mid-refresh. …
 *   Could not refresh your login because another Claude Code process is refreshing it (or exited mid-refresh) · …
 *
 * The turn then ends with an error result carrying the same text.
 */
const REFRESH_RACE = /another Claude Code process is refreshing/i

export type RaceMsg = { type?: string; subtype?: unknown; is_error?: unknown; result?: unknown; errors?: unknown; message?: { content?: unknown } }

/** The text of a result or an assistant message, if it is the refresh race */
function refreshRaceText(m: RaceMsg): string | null {
  const texts: string[] = []
  if (typeof m.result === 'string') texts.push(m.result)
  if (Array.isArray(m.errors)) texts.push(...m.errors.filter((x): x is string => typeof x === 'string'))
  if (m.type === 'assistant' && Array.isArray(m.message?.content)) {
    for (const b of m.message.content as { type?: string; text?: unknown }[]) if (b?.type === 'text' && typeof b.text === 'string') texts.push(b.text)
  }
  return texts.find((t) => REFRESH_RACE.test(t)) ?? null
}

/** What the retry uses of the session it belongs to */
export type RaceRetryHost = {
  readonly sessionId: string
  emit: EventSink
  closed(): boolean
  /** How long to wait before resending a turn that lost the sign-in refresh race (`ClaudeLaunch.retryDelay`) */
  retryDelay(): number
  /** Puts the messages back in front of the CLI, as an open turn */
  resend(texts: ClaudeInput[]): void
}

/** A turn that lost the race to refresh the sign-in, sent again once (#353, see `afterResult`) */
export class ClaudeRaceRetry {
  /** The messages the CLI has read since its last result: what a retried turn sends again (#353) */
  private inTurn: ClaudeInput[] = []
  /** This turn already went again once after losing the sign-in refresh race */
  private raceRetried = false
  /** An assistant message in the current turn carried the refresh-race error */
  private raceSeen: string | null = null
  /** A resend waiting out its delay, and what it will send */
  private retry: { timer: ReturnType<typeof setTimeout>; texts: ClaudeInput[] } | null = null

  constructor(private readonly host: RaceRetryHost) {}

  /** The CLI read this message */
  read(input: ClaudeInput): void {
    this.inTurn.push(input)
  }

  /** An assistant message of the current turn, which may carry the race's error */
  seen(msg: RaceMsg): void {
    this.raceSeen ??= refreshRaceText(msg)
  }

  /** What a resend still waiting out its delay will send */
  get held(): readonly ClaudeInput[] {
    return this.retry?.texts ?? []
  }

  /**
   * A turn that lost the race to refresh the sign-in goes again once, after a few seconds (#353).
   *
   * Claude Code lets one process at a time refresh an expired sign-in; another process that needs it
   * at that moment ends its turn with "another Claude Code process is refreshing it", which the CLI
   * itself calls transient. By the time the delay is over the other process has written the new
   * token, and the resent turn reads it. The person sees why in the conversation: the CLI's own words
   * and a notice that the message goes again, instead of a failed turn. A second loss in a row is
   * reported as the failure it is.
   *
   * What goes again is what the CLI read since its last result. The CLI has already recorded those
   * messages in its conversation, so the model reads them twice, next to each other — the cost of
   * not losing what the person sent.
   *
   * @returns whether the turn goes again (its error is then not reported)
   */
  afterResult(result: RaceMsg): boolean {
    const sent = this.inTurn.splice(0)
    const seen = this.raceSeen
    this.raceSeen = null
    const failed = result.is_error === true || result.subtype !== 'success'
    const race = failed ? (refreshRaceText(result) ?? seen) : null
    if (!race) {
      this.raceRetried = false
      return false
    }
    if (this.raceRetried || sent.length === 0 || this.host.closed()) {
      this.raceRetried = false
      return false
    }
    this.raceRetried = true
    const delay = Math.max(0, this.host.retryDelay())
    this.host.emit({
      type: 'notice',
      sessionId: this.host.sessionId,
      level: 'warning',
      from: 'Claude Code',
      label: 'sign-in',
      audience: 'centralu',
      text: race,
      summary: `Claude Code could not refresh its sign-in because another Claude Code process was refreshing it at the same moment. Centralu sends the message again in ${Math.max(1, Math.round(delay / 1000))} s.`,
    })
    const timer = setTimeout(() => {
      this.retry = null
      if (this.host.closed()) return
      this.host.resend(sent)
    }, delay)
    this.retry = { timer, texts: sent }
    return true
  }

  /** A resend still waiting out its delay is called off; returns how many messages it would have sent */
  cancel(): number {
    if (!this.retry) return 0
    clearTimeout(this.retry.timer)
    const n = this.retry.texts.length
    this.retry = null
    return n
  }

  /** Takes the parent notes out of a resend still waiting; one left with nothing to send is called off */
  dropNotes(): void {
    if (!this.retry) return
    // The retry timer captured this array; remove notes in place so it cannot requeue cancelled input.
    const texts = this.retry.texts
    texts.splice(0, texts.length, ...texts.filter((input) => !input.parentNote))
    if (!texts.length) this.cancel()
  }
}
