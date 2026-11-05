import type { NormalizedEvent, SessionInfo } from '@cc/protocol'
import { SERVER_OVERLOADED } from '../adapters/overloaded.js'
import { inTurn } from '../idle.js'
import { asObj } from '../json-value.js'

/**
 * The turn a provider ends because its servers are at capacity is retried by the host (#1693, owner decision 2026-10-28:
 * this error only, never a usage limit or any other).
 *
 * **What is retried.** Codex ends the turn with `serverOverloaded` (`adapters/overloaded.ts`) after its own attempts: it gave
 * up on the first error, with no `Reconnecting…` notification in between (the rollouts of the issue). Claude Code retries a
 * 529 itself, ten times with a growing delay (`system/api_retry`, shown as the `retrying` activity), and ends the turn only
 * when those are spent, so a retry here would stack on that and is not made: the Claude turn that ends with
 * "API Error: 529" ended after the CLI's own retries.
 *
 * **How it goes.** The error does not end the turn. The session stays `working`, so nobody who gave it the turn is told it
 * failed, and a notice line says when the next try is. After the delay the host continues the turn through Centralu's own
 * channel (a note, no message of the person's), as it does for a turn an update cut. The wait grows (`DELAYS_MS`): the
 * turns that ended this way had run 14 to 44 minutes, so a tight loop would only repeat the same refusal. Once the work
 * is done (it finishes, or the person takes over) the count starts over; output in between does not, so a turn that says a
 * word and fails again cannot loop. When the tries are spent the error ends the turn as it does today, saying how often it was retried.
 *
 * **What cancels it.** The person's Stop (`cancel`), a message into the session (`deliver` calls `cancel`: it carries the work
 * on itself), or any other end of the turn: the event that says so (`observe`) takes the wait away.
 *
 * **A host swap.** The wait is stored (`overload_retry:<session>`, an app setting that an older build never reads) with
 * when it is due. A leaving host drops its timer and keeps the record; the host that starts finds the session still
 * `working`, takes the record and arms a timer for what is left (`restore`). Whichever host's timer fires first takes the
 * record in one transaction (`takeAppSetting`), so it is never sent twice. A host that took it and found itself leaving puts it back.
 */

/** The wait before each retry, in order: how many retries there are is how many entries there are */
export const DELAYS_MS = [30_000, 120_000, 300_000, 600_000] as const

/** What the agent is told when the turn is continued */
export const RETRY_NOTE = "[Centralu] The model provider's servers were at capacity, which ended your last turn. Nothing you did caused it. Continue where you left off."

const KEY = 'overload_retry:'

/** How long after its time a stored retry is still sent: a start later than this finds the person gone and does not continue their turn */
const LATE_MS = 10 * 60_000

/** What is stored for a wait that has not fired */
type Waiting = { attempt: number; dueAt: number; message: string }

/** What the retry reaches of the host */
export type OverloadRetryHost = {
  settings: { appSetting(key: string): string | null; setAppSetting(key: string, value: string): void; takeAppSetting(key: string): string | null; deleteAppSetting(key: string): void }
  meta: ReadonlyMap<string, SessionInfo>
  /** The host is leaving (a quit or a swap): nothing is sent from it */
  leaving(): boolean
  /** The running turn is one Centralu started to compact the conversation: that one is not retried */
  compactTurn(sessionId: string): boolean
  /** Continues the turn through Centralu's channel; throws when the tool does not take it */
  send(sessionId: string, text: string): Promise<void>
  /** An event of the session, as if its tool had said it */
  note(e: NormalizedEvent): void
  now?: () => number
  delays?: readonly number[]
}

export function waitWords(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} min` : `${Math.round(ms / 1000)} s`
}

export class OverloadRetry {
  /** Retries used by the work in each session since it last flowed */
  private readonly used = new Map<string, number>()
  private readonly waiting = new Map<string, { timer: ReturnType<typeof setTimeout>; record: Waiting }>()

  constructor(private readonly host: OverloadRetryHost) {}

  private get delays(): readonly number[] {
    return this.host.delays ?? DELAYS_MS
  }
  private now(): number {
    return this.host.now?.() ?? Date.now()
  }

  /**
   * An error the tool sent, and the event that goes through the host in its place. Not an overloaded one, or one that ends
   * nothing it could continue (the session is not in a turn, the host is leaving, a compaction): as it is. Otherwise the
   * notice of the retry, and the turn goes on waiting; once the tries are spent, the error, saying so.
   */
  hold(e: Extract<NormalizedEvent, { type: 'error' }>): NormalizedEvent {
    const id = e.sessionId
    const data = e.error.data
    if (!id || typeof data !== 'object' || data === null || (data as { reason?: unknown }).reason !== SERVER_OVERLOADED) return e
    const m = this.host.meta.get(id)
    if (!m || !inTurn(m.state) || this.host.leaving() || this.host.compactTurn(id) || this.waiting.has(id)) return e
    const tries = this.used.get(id) ?? 0
    if (tries >= this.delays.length) {
      this.used.delete(id)
      return { ...e, error: { ...e.error, message: `${e.error.message}\n${spentWords(tries)}` } }
    }
    const wait = this.delays[tries] ?? 0
    this.used.set(id, tries + 1)
    this.arm(id, { attempt: tries + 1, dueAt: this.now() + wait, message: e.error.message })
    return {
      type: 'notice',
      sessionId: id,
      level: 'warning',
      from: 'Centralu',
      label: 'retry',
      text: `The model's servers are at capacity, which is not your usage limit. Centralu retries this turn in ${waitWords(wait)} (retry ${tries + 1} of ${this.delays.length}). Stop cancels it.`,
    }
  }

  /** Every event of a session: the ones that end the turn take a wait away, and start the count over */
  observe(e: NormalizedEvent): void {
    const id = e.sessionId
    if (!id) return
    // The turn is done, ended some other way, or the person took over: nothing is left to continue, and the next failure counts from none
    if (e.type === 'turn_complete' || e.type === 'error' || e.type === 'limit_reached' || e.type === 'session_deleted' || (e.type === 'state_change' && e.state !== 'working')) this.cancel(id)
  }

  /** Takes a pending retry away, for the person's Stop or an end of the turn: whether one was waiting */
  cancel(sessionId: string): boolean {
    this.used.delete(sessionId)
    const w = this.waiting.get(sessionId)
    if (!w) return false
    clearTimeout(w.timer)
    this.waiting.delete(sessionId)
    this.host.settings.deleteAppSetting(KEY + sessionId)
    return true
  }

  /**
   * Whether a retry is stored for the session and still worth waiting for (a start asks, to leave the turn it was waiting in as
   * it is). One that fell due long before (Centralu stayed closed past its time) is dropped: the person left, and the turn is
   * one a quit cut, with the line and the Continue that has
   */
  pending(sessionId: string): boolean {
    const raw = this.host.settings.appSetting(KEY + sessionId)
    if (raw === null) return false
    const record = parse(raw)
    if (record && this.now() - record.dueAt <= LATE_MS) return true
    this.host.settings.deleteAppSetting(KEY + sessionId)
    return false
  }

  /**
   * The start of a host that found the session in the turn the last host left waiting: the wait goes on for what is left of it.
   * A record of a session that is not in a turn is stale and goes
   */
  restore(sessionId: string): void {
    const raw = this.host.settings.appSetting(KEY + sessionId)
    if (raw === null) return
    const record = parse(raw)
    const m = this.host.meta.get(sessionId)
    if (!record || !m || !inTurn(m.state)) {
      this.host.settings.deleteAppSetting(KEY + sessionId)
      return
    }
    this.used.set(sessionId, record.attempt)
    this.arm(sessionId, record, false)
  }

  /** The host is leaving: no timer of it fires, and the records stay for the host that starts next */
  stopAll(): void {
    for (const w of this.waiting.values()) clearTimeout(w.timer)
    this.waiting.clear()
  }

  private arm(id: string, record: Waiting, persist = true): void {
    if (persist) this.host.settings.setAppSetting(KEY + id, JSON.stringify(record))
    const timer = setTimeout(() => void this.fire(id), Math.max(0, record.dueAt - this.now()))
    timer.unref?.()
    this.waiting.set(id, { timer, record })
  }

  private async fire(id: string): Promise<void> {
    const w = this.waiting.get(id)
    if (!w) return
    this.waiting.delete(id)
    // Taken in one step: the host that gets here first sends it, the other (a swap's two hosts) finds nothing
    if (this.host.settings.takeAppSetting(KEY + id) === null) return
    const m = this.host.meta.get(id)
    if (!m || !inTurn(m.state)) return
    try {
      await this.host.send(id, RETRY_NOTE)
    } catch (err) {
      const now = this.host.meta.get(id)
      if (!now || !inTurn(now.state)) return
      if (this.host.leaving()) {
        // Not sent, and the host is going: the one after it tries again
        this.host.settings.setAppSetting(KEY + id, JSON.stringify(w.record))
        return
      }
      this.used.delete(id)
      const why = err instanceof Error ? err.message : String(err)
      this.host.note({
        type: 'error',
        sessionId: id,
        error: { code: 'internal', message: `${w.record.message}\nCentralu could not retry the turn: ${why}`, retryable: true },
      })
    }
  }
}

function spentWords(tries: number): string {
  return `Centralu retried this turn ${tries} ${tries === 1 ? 'time' : 'times'} and the servers stayed at capacity. This is not a usage limit: try again later or pick another model.`
}

function parse(raw: string): Waiting | null {
  try {
    const v = asObj(JSON.parse(raw))
    if (typeof v.attempt === 'number' && typeof v.dueAt === 'number' && typeof v.message === 'string') return { attempt: v.attempt, dueAt: v.dueAt, message: v.message }
  } catch {
    // A record that does not read is stale
  }
  return null
}
