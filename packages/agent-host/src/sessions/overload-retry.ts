import { durationText } from '../timing.js'
import type { NormalizedEvent, SessionInfo } from '@cc/protocol'
import { RETRY_NOTE } from '../adapters/input-receipts.js'
import { SERVER_OVERLOADED } from '../adapters/overloaded.js'
import { inTurn } from '../idle.js'

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
 * **What cancels it.** The person's Stop (`cancel`), a message into the session (`deliver` calls `supersede`: it carries the work
 * on itself), or any other end of the turn: the event that says so (`observe`) takes the wait away. That is honoured until the
 * note is handed to the tool: the entry stays while it is being sent, and the send is gated on it (`live`). Once handed, the
 * tool runs a turn of its own and the session is in an ordinary turn: a Stop stops that turn (`cancel` says the note was handed),
 * a message joins it as it joins any running turn (`supersede` says nothing was taken), and a host that leaves leaves it as it leaves any.
 *
 * **The host leaving.** The wait lives in this host only. The turn's end was the error, which this host swallowed and no host
 * after it is told again (a kept process does not replay it), so a leaving host ends the turn with that error now
 * (`stopAll`), as it ended before this retry: the person sends a message to go on. Nothing is stored.
 */

/** The wait before each retry, in order: how many retries there are is how many entries there are */
export const DELAYS_MS = [30_000, 120_000, 300_000, 600_000] as const

/** What the retry reaches of the host */
export type OverloadRetryHost = {
  meta: ReadonlyMap<string, SessionInfo>
  /** The host is leaving (a quit or a swap) */
  leaving(): boolean
  /** The running turn is one Centralu started to compact the conversation: that one is not retried */
  compactTurn(sessionId: string): boolean
  /** Whether the session has a process to continue the turn in */
  running(sessionId: string): boolean
  /** Continues the turn through Centralu's channel; sends nothing when the retry no longer stands by then; throws when the tool does not take it */
  send(sessionId: string, text: string, gate: RetrySend): Promise<void>
  /** An event of the session, as if its tool had said it */
  note(e: NormalizedEvent): void
}

/** What a send is given: whether the retry still stands, and the word that the tool is being handed the note (from then on the turn is the tool's) */
export type RetrySend = { live(): boolean; handed(): void }

/** Where a retry is: waiting for its time, being sent (a restart or a wake waited out first), or handed to the tool, which runs the turn */
export type RetryPhase = 'waiting' | 'sending' | 'handed'

/** A retry and the error it stands in for, to say if the turn ends without it */
type Wait = { timer: ReturnType<typeof setTimeout> | null; message: string; phase: RetryPhase }

export class OverloadRetry {
  /** Retries used by the work in each session since it was done */
  private readonly used = new Map<string, number>()
  private readonly waiting = new Map<string, Wait>()

  constructor(private readonly host: OverloadRetryHost) {}

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
    // One still to be sent already stands for this turn's end. Once the note is sent, an error is the retried turn's own: retried in its turn, the count kept
    if (!m || !inTurn(m.state) || this.host.leaving() || this.host.compactTurn(id) || this.waiting.get(id)?.phase === 'waiting') return e
    const tries = this.used.get(id) ?? 0
    if (tries >= DELAYS_MS.length) {
      this.used.delete(id)
      this.waiting.delete(id)
      return { ...e, error: { ...e.error, message: `${e.error.message}\n${spentWords(tries)}` } }
    }
    const wait = DELAYS_MS[tries] ?? 0
    this.used.set(id, tries + 1)
    const entry: Wait = { timer: null, message: e.error.message, phase: 'waiting' }
    entry.timer = setTimeout(() => void this.fire(id, entry), wait)
    entry.timer.unref?.()
    this.waiting.set(id, entry)
    return {
      type: 'notice',
      sessionId: id,
      level: 'warning',
      from: 'Centralu',
      label: 'retry',
      text: `The model's servers are at capacity, which is not your usage limit. Centralu retries this turn in ${durationText(wait)} (retry ${tries + 1} of ${DELAYS_MS.length}). Stop cancels it.`,
    }
  }

  /** Every event of a session: the ones that end the turn take a wait away, and start the count over */
  observe(e: NormalizedEvent): void {
    const id = e.sessionId
    if (!id) return
    if (e.type === 'turn_complete' || e.type === 'error' || e.type === 'limit_reached' || e.type === 'session_deleted' || (e.type === 'state_change' && e.state !== 'working')) this.cancel(id)
  }

  /** Whether a retry waits for its time: the turn the error stood in for goes on, so what hangs on that turn (a hub task's depth) is not over */
  stands(sessionId: string): boolean {
    return this.waiting.get(sessionId)?.phase === 'waiting'
  }

  /** Takes a pending retry away, for the person's Stop or an end of the turn: where it was, or null when none stood. Handed, the tool's turn is running and is the caller's to stop */
  cancel(sessionId: string): RetryPhase | null {
    this.used.delete(sessionId)
    const w = this.waiting.get(sessionId)
    if (!w) return null
    if (w.timer) clearTimeout(w.timer)
    this.waiting.delete(sessionId)
    return w.phase
  }

  /**
   * A message into the session takes the retry away (`SessionEvents.deliver`): the error it stood in for, or null when none stood.
   * Same as `cancel`, with the error handed back for the case that the message does not go in (`lost`). Not one handed to the
   * tool: its turn is running and the message joins it like any message into a running turn, with nothing owed; only the record of the note goes
   */
  supersede(sessionId: string): string | null {
    const w = this.waiting.get(sessionId)
    if (w?.phase === 'handed') {
      this.used.delete(sessionId)
      // The person's turn now: a late refusal of the note is not a failure of theirs (`fire` ignores it once the entry is gone)
      this.waiting.delete(sessionId)
      return null
    }
    this.cancel(sessionId)
    return w?.message ?? null
  }

  /** The message that took the retry away was refused: the turn is over, ended by the error the retry stood in for */
  lost(sessionId: string, message: string): void {
    if (!inTurn(this.host.meta.get(sessionId)?.state ?? 'idle')) return
    this.host.note(failure(sessionId, `${message}\nCentralu was going to retry this turn, but a message to the session came first and was not delivered. Send a message to go on.`))
  }

  /** The host is leaving: the turns that wait end with the error they stood in for, which no later host would hear again. A handed one is the tool's running turn: it leaves as any does */
  stopAll(): void {
    for (const [id, w] of [...this.waiting]) {
      this.cancel(id)
      if (w.phase === 'handed') continue
      this.host.note(failure(id, `${w.message}\nCentralu was going to retry this turn, but it restarted first. Send a message to go on.`))
    }
  }

  private async fire(id: string, w: Wait): Promise<void> {
    if (this.waiting.get(id) !== w) return
    w.phase = 'sending'
    const live = () => this.waiting.get(id) === w
    try {
      if (!this.host.running(id)) throw new Error('the session has no process left to continue it in')
      await this.host.send(id, RETRY_NOTE, { live, handed: () => { w.phase = 'handed' } })
    } catch (err) {
      // Cancelled meanwhile (a Stop, a message, another end): nothing is owed
      if (!live()) return
      this.cancel(id)
      this.host.note(failure(id, `${w.message}\nCentralu could not retry the turn: ${err instanceof Error ? err.message : String(err)}`))
      return
    }
    if (live()) this.waiting.delete(id)
  }
}

/** The turn's end, as the provider's error said it (without the marker, which would hold it again) */
function failure(sessionId: string, message: string): NormalizedEvent {
  return { type: 'error', sessionId, error: { code: 'internal', message, retryable: true } }
}

function spentWords(tries: number): string {
  return `Centralu retried this turn ${tries} ${tries === 1 ? 'time' : 'times'} and the servers stayed at capacity. This is not a usage limit: try again later or pick another model.`
}
