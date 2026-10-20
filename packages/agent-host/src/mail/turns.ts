import type { NormalizedEvent } from '@cc/protocol'
import type { MailRecords } from '../dev-services/store/mail.js'

export type TurnGuardOptions = {
  now?: () => number
  /** Mail-started turns of one thread an hour, with no word from the person, before its mail is held (20) */
  turnsPerHour?: number
  /** Input tokens an hour that a session's mail-started turns may use before its mail stops waking it (200,000) */
  tokensPerHour?: number
  /** Mail-started turns in a row that ended doing nothing before the same (3) */
  emptyInARow?: number
}

const HOUR = 60 * 60_000

/** What is known of a turn mail started while it runs */
type Open = { seq: number; acted: boolean; tokens: number }

/**
 * The guards against mail that feeds on itself (docs/plans/mailbox.md §7.9). Two agents answering each other, or a session that
 * is woken for nothing again and again, cannot spend usage unseen:
 *
 * - **Loop guard**: a thread whose mail started more than 20 turns in an hour with no word from the person holds its mail (`loop`).
 *   The count is in the store (`mail_turns`), so a restart does not reset it.
 * - **Token guard**: past 200,000 new input tokens an hour (not what is read again from the cache), or 3 mail-started turns in a row that ended doing nothing, a session's mail
 *   stops waking it (`budget`). The tokens and the run of empty turns are kept in memory: a restart starts them again, which is
 *   the safe way to be wrong for a budget (it never holds mail it should not).
 *
 * "Doing nothing" is a turn with no tool call: a post, a state change or a read of the mailbox is a call of the `mail` tool, and
 * so is everything else a session does besides speak. The person's words and Centralu's are never held by either.
 */
export class MailTurns {
  private readonly now: () => number
  private readonly o: Required<Omit<TurnGuardOptions, 'now'>>
  private readonly open = new Map<string, Open>()
  private readonly tokens = new Map<string, { at: number; tokens: number }[]>()
  private readonly empty = new Map<string, number>()
  /** Since when the turns of a thread are counted anew: the person pressed Resume */
  private readonly loopFrom = new Map<string, number>()

  constructor(
    private readonly records: MailRecords,
    opts: TurnGuardOptions = {},
  ) {
    this.now = opts.now ?? Date.now
    this.o = { turnsPerHour: opts.turnsPerHour ?? 20, tokensPerHour: opts.tokensPerHour ?? 200_000, emptyInARow: opts.emptyInARow ?? 3 }
  }

  /** Turns the previous host left open can never end: they are closed, so a thread does not look busy for ever */
  closeStale(): void {
    this.records.closeOpenTurns(this.now(), 'lost')
  }

  /** Mail is about to start a turn of the session (`threadId`: the thread whose mail it is, the first when it is several); the turn's number */
  begin(sessionId: string, threadId: string | null): number {
    this.end(sessionId, 'lost')
    const seq = this.records.nextTurnSeq(sessionId)
    this.records.startTurn({ sessionId, turnSeq: seq, threadId, startedBy: 'mail', startedAt: this.now() })
    this.open.set(sessionId, { seq, acted: false, tokens: 0 })
    return seq
  }

  /**
   * The delivery that was to start the turn `seq` failed: no turn. A failure told late finds the session's turn may be another one by
   * then, which is left alone
   */
  cancel(sessionId: string, seq: number): void {
    const turn = this.open.get(sessionId)
    if (!turn || turn.seq !== seq) return
    this.open.delete(sessionId)
    this.records.endTurn(sessionId, turn.seq, this.now(), 'canceled')
  }

  /** What the session's tool says, as it comes: a call is doing something, a request is input read */
  observe(e: NormalizedEvent, endedTurn: boolean): void {
    if (!e.sessionId) return
    const turn = this.open.get(e.sessionId)
    if (!turn) return
    if (e.type === 'tool_call') turn.acted = true
    if (e.type === 'usage_update' && e.request) // The input that was new to the model: what it read from its cache again each request is not usage this guard is for (a long
      // conversation reads its whole context from cache on every request)
      turn.tokens += e.request.inputTokens + (e.request.cacheCreationTokens ?? 0)
    if (endedTurn) this.end(e.sessionId, turn.acted ? 'acted' : 'empty')
  }

  private end(sessionId: string, outcome: string): void {
    const turn = this.open.get(sessionId)
    if (!turn) return
    this.open.delete(sessionId)
    const now = this.now()
    this.records.endTurn(sessionId, turn.seq, now, outcome)
    if (turn.tokens > 0) this.tokens.set(sessionId, [...this.recent(sessionId), { at: now, tokens: turn.tokens }])
    if (outcome === 'empty') this.empty.set(sessionId, (this.empty.get(sessionId) ?? 0) + 1)
    else if (outcome === 'acted') this.empty.delete(sessionId)
  }

  private recent(sessionId: string): { at: number; tokens: number }[] {
    const since = this.now() - HOUR
    return (this.tokens.get(sessionId) ?? []).filter((t) => t.at > since)
  }

  /** Tokens the session's mail-started turns read in the last hour, the open one included */
  tokensInAnHour(sessionId: string): number {
    return this.recent(sessionId).reduce((sum, t) => sum + t.tokens, 0) + (this.open.get(sessionId)?.tokens ?? 0)
  }

  /** Whether the session's mail has used up what it may: it is told of what comes, and not woken for it */
  budgetSpent(sessionId: string): boolean {
    return this.tokensInAnHour(sessionId) > this.o.tokensPerHour || (this.empty.get(sessionId) ?? 0) >= this.o.emptyInARow
  }

  /** The person pressed Resume on a session whose mail was paused: the tokens and the run of empty turns are counted anew */
  resumeBudget(sessionId: string): void {
    this.tokens.delete(sessionId)
    this.empty.delete(sessionId)
  }

  /** Whether the thread's mail has started more turns in the last hour than it may without a word from the person */
  loopSpent(threadId: string): boolean {
    const now = this.now()
    const lastWord = this.records.lastBy(threadId, 'person')?.createdAt ?? 0
    const since = Math.max(now - HOUR, lastWord, this.loopFrom.get(threadId) ?? 0)
    return this.records.mailTurnsSince(threadId, since) > this.o.turnsPerHour
  }

  /** The person pressed Resume on a thread that was paused: its turns are counted from now */
  resumeLoop(threadId: string): void {
    this.loopFrom.set(threadId, this.now())
  }
}
