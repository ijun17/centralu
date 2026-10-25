import type { NormalizedEvent } from '@cc/protocol'
import type { MailRecords } from '../dev-services/store/mail.js'

export type TurnGuardOptions = {
  now?: () => number
  /** Mail-started turns of one thread an hour, with no word from the person, before its mail is held (20) */
  turnsPerHour?: number
  /**
   * Whether the session's turn is still going under the keeper, which this host took over from the last one: its open row stays open and
   * is read back, and its end is recorded here. Without it every open row is closed `lost`
   */
  keepOpen?: (sessionId: string) => boolean
  /** Input tokens an hour that a session's mail-started turns may use before its mail stops waking it (200,000) */
  tokensPerHour?: number
  /** Mail-started turns in a row that ended doing nothing before the same (3) */
  emptyInARow?: number
  /**
   * The session whose request a thread is (`MailService.requestedBy`, §9.7). Read once when a turn of the thread begins, and kept on the turn: who
   * asked for a turn does not change while it runs, whatever becomes of the session or of the thread's owner
   */
  askerOf?: (threadId: string) => string | undefined
}

const HOUR = 60 * 60_000

const STARTED_BY: readonly TurnStartedBy[] = ['mail', 'person', 'caller', 'cli', 'report', 'app']
/** The starter a stored row names; a word this build does not know is read as a caller's, which no guard counts */
const turnStartedBy = (stored: string): TurnStartedBy => STARTED_BY.find((s) => s === stored) ?? 'caller'

/**
 * A turn that started, as the mailbox hears of it (docs/plans/mailbox.md §6): whose it is, whether the CLI ran it on its own, and
 * the caller it is the work of, when there is one
 */
export type TurnStart = { by: 'person' | 'work'; added: boolean; cli: boolean; source: TurnSource; ownerId?: string }

/** What a message of the work that starts a turn is: a caller's own, a report or notice about another session (Centralu's), or an app's */
export type TurnSource = 'caller' | 'report' | 'app'

/** Who started a turn (§6): the mailbox's delivery, the person, a caller's message, or the CLI on its own */
export type TurnStartedBy = 'mail' | 'person' | 'caller' | 'cli' | 'report' | 'app'

/** What is known of a turn while it runs. The guards count only the turns mail started */
type Open = {
  seq: number
  startedAt: number
  acted: boolean
  tokens: number
  by: TurnStartedBy
  threadId: string | null
  /** The caller whose work the turn is, when it is */
  owner?: string
  /** The session whose request the turn is (§9.7), fixed when the turn began */
  askedBy?: string
}

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
  private readonly o: Required<Omit<TurnGuardOptions, 'now' | 'keepOpen' | 'askerOf'>>
  private readonly keepOpen: ((sessionId: string) => boolean) | undefined
  private readonly askerOf: TurnGuardOptions['askerOf']
  private readonly open = new Map<string, Open>()
  private readonly tokens = new Map<string, { at: number; tokens: number }[]>()
  private readonly empty = new Map<string, number>()
  /** The thread of each session's last turn that ended; replaced when the next turn begins */
  private readonly lastEnded = new Map<string, string | null>()
  /** Since when the turns of a thread are counted anew: the person pressed Resume */
  private readonly loopFrom = new Map<string, number>()

  constructor(
    private readonly records: MailRecords,
    opts: TurnGuardOptions = {},
  ) {
    this.now = opts.now ?? Date.now
    this.keepOpen = opts.keepOpen
    this.askerOf = opts.askerOf
    this.o = { turnsPerHour: opts.turnsPerHour ?? 20, tokensPerHour: opts.tokensPerHour ?? 200_000, emptyInARow: opts.emptyInARow ?? 3 }
  }

  /**
   * Turns the previous host left open: the ones of sessions the keeper handed over that are still in their turn go on, and are read back so
   * their end is recorded (and the thread still looks busy for as long as it is); the rest can never end and are closed `lost`
   */
  closeStale(): void {
    for (const row of this.records.openTurns()) {
      if (this.keepOpen?.(row.sessionId) && !this.open.has(row.sessionId)) {
        this.open.set(row.sessionId, { seq: row.turnSeq, startedAt: row.startedAt, acted: false, tokens: 0, by: turnStartedBy(row.startedBy), threadId: row.threadId, ...this.asked(row.startedBy, row.threadId) })
      } else {
        this.records.endTurn(row.sessionId, row.turnSeq, this.now(), 'lost')
      }
    }
  }

  /** Mail is about to start a turn of the session (`threadId`: the thread whose mail it is, the first when it is several); the turn's number */
  begin(sessionId: string, threadId: string | null): number {
    this.end(sessionId, 'lost')
    const seq = this.records.nextTurnSeq(sessionId)
    this.records.startTurn({ sessionId, turnSeq: seq, threadId, startedBy: 'mail', startedAt: this.now() })
    this.open.set(sessionId, { seq, startedAt: this.now(), acted: false, tokens: 0, by: 'mail', threadId, ...this.asked('mail', threadId) })
    return seq
  }

  /** The asker of a turn that mail started, when its thread is a session's request: a turn of any other kind is nobody's request */
  private asked(startedBy: string, threadId: string | null): { askedBy: string } | Record<string, never> {
    const asker = startedBy === 'mail' && threadId !== null ? this.askerOf?.(threadId) : undefined
    return asker === undefined ? {} : { askedBy: asker }
  }

  /**
   * A turn the mailbox did not start begins (§6): the person typed, a caller's message came, or the CLI ran on after its background
   * work. Its thread is the one it belongs to, if any, so its end can be reported as that thread's. When a turn mail started is going, this
   * is that turn (the wake is its first input), and nothing is added. The guards do not count it
   */
  beginOther(sessionId: string, by: Exclude<TurnStartedBy, 'mail'>, threadId: string | null, owner?: string): void {
    if (this.open.get(sessionId)?.by === 'mail') return
    this.end(sessionId, 'lost')
    const seq = this.records.nextTurnSeq(sessionId)
    this.records.startTurn({ sessionId, turnSeq: seq, threadId, startedBy: by, startedAt: this.now() })
    this.open.set(sessionId, { seq, startedAt: this.now(), acted: false, tokens: 0, by, threadId, ...(owner ? { owner } : {}) })
  }

  /**
   * The thread of a turn a caller's message started is known only once the delegation is written down, which the host does after the
   * task went in and the turn began: the running turn of that kind belongs to it from here
   */
  attach(sessionId: string, threadId: string, owner: string): void {
    const turn = this.open.get(sessionId)
    // Only the turn that is the work of this caller: another caller's, or a turn that has nothing to do with the delegation, is not bound to it
    if (!turn || turn.threadId !== null || (turn.by !== 'caller' && turn.by !== 'cli') || turn.owner !== owner) return
    turn.threadId = threadId
    this.records.setTurnThread(sessionId, turn.seq, threadId)
  }

  /** When the turn that is going in the session began; none when no turn is recorded */
  startedAt(sessionId: string): number | undefined {
    return this.open.get(sessionId)?.startedAt
  }

  /** The turn that is going in the session, by whom it was started and the thread it belongs to; none when no turn is recorded */
  current(sessionId: string): { by: TurnStartedBy; threadId: string | null; askedBy?: string } | undefined {
    const turn = this.open.get(sessionId)
    return turn && { by: turn.by, threadId: turn.threadId, ...(turn.askedBy ? { askedBy: turn.askedBy } : {}) }
  }

  /** The number of the turn that is going in the session (it grows with every turn, so it tells one turn of a thread from the next); none when no turn is recorded */
  numberOf(sessionId: string): number | undefined {
    return this.open.get(sessionId)?.seq
  }

  /**
   * The thread of the session's turn that is going, or else of the one that ended last: the end of a turn is reported once it ends, and the
   * report belongs to that turn's thread whichever of the two the report is made in
   */
  threadOf(sessionId: string): string | null {
    const turn = this.open.get(sessionId)
    return turn ? turn.threadId : (this.lastEnded.get(sessionId) ?? null)
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
    if (e.type === 'usage_update' && e.request && turn.by === 'mail') // The input that was new to the model: what it read from its cache again each request is not usage this guard is for (a long
      // conversation reads its whole context from cache on every request)
      turn.tokens += e.request.inputTokens + (e.request.cacheCreationTokens ?? 0)
    if (endedTurn) this.end(e.sessionId, turn.acted ? 'acted' : 'empty')
  }

  private end(sessionId: string, outcome: string): void {
    const turn = this.open.get(sessionId)
    if (!turn) return
    this.open.delete(sessionId)
    this.lastEnded.set(sessionId, turn.threadId)
    const now = this.now()
    this.records.endTurn(sessionId, turn.seq, now, outcome)
    // The budget is mail's: a turn the person or a caller started is theirs to spend
    if (turn.by !== 'mail') return
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
