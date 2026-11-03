import type { NormalizedEvent } from '@cc/protocol'
import type { MailboxRecords } from '../dev-services/store/mailbox.js'
import { parseAddress } from './address.js'
import { HOUR_MS, PAIR_TURNS_PER_HOUR } from './rules.js'

export type TurnGuardOptions = {
  now?: () => number
  /** Mail-started turns of one session pair an hour, with no word from the person, before their mail is held (20) */
  turnsPerHour?: number
  /**
   * Whether the session's turn is still going from the host before: kept by the keeper, or cut by an update and continued (#1618). Its open row
   * stays open and is read back, its end is recorded here, and what it sends keeps the row's cause (§8.2 step 6). Without it every open row is closed `lost`
   */
  keepOpen?: (sessionId: string) => boolean
  /** Input tokens an hour that a session's mail-started turns may use before its mail stops waking it (200,000) */
  tokensPerHour?: number
  /** Mail-started turns in a row that ended doing nothing before the same (3) */
  emptyInARow?: number
  /**
   * Whose request a turn read back after a restart is: the work message's sender when the session is the orchestrator and the message one of its
   * requests (§7.6). A turn the delivery begins is told its asker
   */
  askerOf?: (sessionId: string, messageId: string) => string | undefined
}

const STARTED_BY: readonly TurnStartedBy[] = ['mail', 'person', 'caller', 'cli', 'report', 'app']
/** The starter a stored row names; a word this build does not know is read as a caller's, which no guard counts */
const turnStartedBy = (stored: string): TurnStartedBy => STARTED_BY.find((s) => s === stored) ?? 'caller'

/**
 * A turn that started, as the mailbox hears of it (docs/plans/mailbox.md §8.2): whose it is, whether the CLI ran it on its own, and
 * the caller it is the work of, when there is one
 */
/** `again`: the turn was decided at its start, and the tool's naming of its inputs decided it otherwise (#1639) */
export type TurnStart = { by: 'person' | 'work'; added: boolean; cli: boolean; source: TurnSource; ownerId?: string; again?: true }

/** What a message of the work that starts a turn is: a caller's own, a report or notice about another session (Centralu's), or an app's */
export type TurnSource = 'caller' | 'report' | 'app'

/** Who started a turn: the mailbox's delivery, the person, a caller's message, or the CLI on its own */
export type TurnStartedBy = 'mail' | 'person' | 'caller' | 'cli' | 'report' | 'app'

/** A session's turn now (§8.2 step 6), read from its row so a restart or an update's continue keeps it; `asker` is an address */
export type TurnNow = { turnSeq: number; by: TurnStartedBy; starter: string | null; messageId: string | null; asker: string | null; startedAt: number }

type LastTurn = {
  seq: number
  startedAt: number
  /** The turn's work message (a task, or the orchestrator's request) */
  messageId: string | null
}

/** What is known of a turn while it runs. The guards count only the turns mail started */
type Open = LastTurn & {
  acted: boolean
  tokens: number
  by: TurnStartedBy
  /** The message that started it: what its sends are caused by */
  starter: string | null
  /** The caller whose work the turn is, when it is */
  owner?: string
  /** The address of the session whose request the turn is (§7.6), fixed when the turn began */
  asker?: string
}

/**
 * Each session's turns as mail sees them (docs/plans/mailbox.md §7.5, §8.2): the work message and starter of the running one, and the guards against
 * mail that feeds on itself:
 *
 * - **Pair loop guard**: two sessions whose mail to each other started more than 20 turns in an hour with no word from the person hold that mail
 *   (`loop`). Counted from the store (`pairTurnsSince`), so a restart does not reset it.
 * - **Token guard**: past 200,000 new input tokens an hour, or 3 mail-started turns in a row that ended doing nothing, a session's mail stops waking
 *   it (`budget`). Kept in memory: a restart starts them again, which is the safe way to be wrong for a budget.
 * - **The host-wide cap** reads `mailStartedSince` (the delivery applies it).
 *
 * **A turn continued after a restart or an update is not mail-started** (§8.2 step 6): nothing begins it here, its row is read back (`closeStale`
 * with `keepOpen`), so `current` gives the original turn's starter and asker, and it adds no row the cap or the pair guard could count.
 */
/** What started a turn the mailbox did not: the person's own turn, or the CLI's, has no cause (D9); a caller's turn of known work was started by it */
const causeOf = (by: Exclude<TurnStartedBy, 'mail'>, messageId: string | null): string | null => (by === 'caller' ? messageId : null)

export class MailTurns {
  private readonly now: () => number
  private readonly o: { turnsPerHour: number; tokensPerHour: number; emptyInARow: number }
  private readonly open = new Map<string, Open>()
  private readonly tokens = new Map<string, { at: number; tokens: number }[]>()
  private readonly empty = new Map<string, number>()
  /** The work message and number of each session's last turn that ended; replaced when the next turn begins */
  private readonly lastEnded = new Map<string, LastTurn>()
  /** Since when a pair's turns are counted anew: the person pressed Resume */
  private readonly pairFrom = new Map<string, number>()

  constructor(
    private readonly records: MailboxRecords,
    private readonly opts: TurnGuardOptions = {},
  ) {
    this.now = opts.now ?? Date.now
    this.o = { turnsPerHour: opts.turnsPerHour ?? PAIR_TURNS_PER_HOUR, tokensPerHour: opts.tokensPerHour ?? 200_000, emptyInARow: opts.emptyInARow ?? 3 }
  }

  /**
   * Turns the previous host left open: the ones of sessions still in that turn (kept by the keeper, or continued after an update cut them) go
   * on and are read back with their work message, starter and asker; the rest can never end and are closed `lost`. Returns those closed
   */
  closeStale(): { sessionId: string; turnSeq: number }[] {
    const lost: { sessionId: string; turnSeq: number }[] = []
    for (const row of this.records.openTurns()) {
      if (this.opts.keepOpen?.(row.sessionId) && !this.open.has(row.sessionId)) {
        const by = turnStartedBy(row.startedBy)
        const asker = by === 'mail' && row.messageId !== null ? this.opts.askerOf?.(row.sessionId, row.messageId) : undefined
        this.open.set(row.sessionId, { seq: row.turnSeq, startedAt: row.startedAt, acted: false, tokens: 0, by, messageId: row.messageId, starter: row.starterId, ...(asker ? { asker } : {}) })
      } else {
        this.records.endTurn(row.sessionId, row.turnSeq, this.now(), 'lost')
        lost.push({ sessionId: row.sessionId, turnSeq: row.turnSeq })
      }
    }
    return lost
  }

  /** Mail is about to start a turn of the session: its work message (or null), the message that starts it, and for the orchestrator its asker. The turn's number */
  begin(sessionId: string, turn: { workMessage: string | null; starter: string | null; asker?: string | null }): number {
    this.end(sessionId, 'lost')
    const seq = this.records.nextTurnSeq(sessionId)
    const startedAt = this.now()
    this.records.startTurn({ sessionId, turnSeq: seq, messageId: turn.workMessage, starterId: turn.starter, startedBy: 'mail', startedAt })
    this.open.set(sessionId, { seq, startedAt, acted: false, tokens: 0, by: 'mail', messageId: turn.workMessage, starter: turn.starter, ...(turn.asker ? { asker: turn.asker } : {}) })
    return seq
  }

  /**
   * A turn the mailbox did not start begins: the person typed, a caller's message came, or the CLI ran on after its background work. `messageId`
   * is the work it belongs to, if known (its starter too, the task that started it). When a turn mail started is going, this is that turn (the
   * wake is its first input), and nothing is added. The guards do not count it
   */
  beginOther(sessionId: string, by: Exclude<TurnStartedBy, 'mail'>, messageId: string | null, owner?: string): void {
    if (this.open.get(sessionId)?.by === 'mail') return
    this.end(sessionId, 'lost')
    const seq = this.records.nextTurnSeq(sessionId)
    const startedAt = this.now()
    const starter = causeOf(by, messageId)
    this.records.startTurn({ sessionId, turnSeq: seq, messageId, starterId: starter, startedBy: by, startedAt })
    this.open.set(sessionId, { seq, startedAt, acted: false, tokens: 0, by, messageId, starter, ...(owner ? { owner } : {}) })
  }

  /**
   * The turn going, which `beginOther` recorded, was decided again when the tool named the input it opened from (#1639): the same turn, its
   * starter, work message and owner corrected in place. A turn the mailbox's delivery started is the mailbox's
   */
  restate(sessionId: string, by: Exclude<TurnStartedBy, 'mail'>, messageId: string | null, owner?: string): void {
    const turn = this.open.get(sessionId)
    if (!turn || turn.by === 'mail') return
    const starter = causeOf(by, messageId)
    turn.by = by
    turn.messageId = messageId
    turn.starter = starter
    if (owner) turn.owner = owner
    else delete turn.owner
    this.records.restateTurn(sessionId, turn.seq, { messageId, starterId: starter, startedBy: by })
  }

  /**
   * The task of a turn a caller's message started is written only after the task went in and the turn began: the running turn of that kind is
   * that task's from here, and the task is its starter (§9.1)
   */
  attach(sessionId: string, messageId: string, owner: string): void {
    const turn = this.open.get(sessionId)
    // Only the turn that is the work of this caller: another caller's, or a turn that has nothing to do with the delegation, is not bound to it
    if (!turn || turn.messageId !== null || (turn.by !== 'caller' && turn.by !== 'cli') || turn.owner !== owner) return
    turn.messageId = messageId
    turn.starter ??= messageId
    this.records.setTurnMessage(sessionId, turn.seq, messageId)
  }

  /** The turn going in the session (§8.2 step 6); none when no turn is recorded */
  current(sessionId: string): TurnNow | undefined {
    const t = this.open.get(sessionId)
    return t && { turnSeq: t.seq, by: t.by, starter: t.starter, messageId: t.messageId, asker: t.asker ?? null, startedAt: t.startedAt }
  }

  /**
   * The session's turn that is going, or else the one that ended last: the end of a turn is reported once it ends, and the report belongs to that
   * turn's work (§9.2), covers what it did since it began (§9.3), and settles the requests it carried (§7.6) whichever of the two it is made in
   */
  latest(sessionId: string): Readonly<LastTurn> | undefined {
    return this.open.get(sessionId) ?? this.lastEnded.get(sessionId)
  }

  /** The delivery that was to start the turn `seq` failed: no turn. A failure told late finds the session's turn may be another one by then, which is left alone */
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
    // The input that was new to the model: what it read from its cache again each request is not usage this guard is for
    if (e.type === 'usage_update' && e.request && turn.by === 'mail') turn.tokens += e.request.inputTokens + (e.request.cacheCreationTokens ?? 0)
    if (endedTurn) this.end(e.sessionId, turn.acted ? 'acted' : 'empty')
  }

  private end(sessionId: string, outcome: string): void {
    const turn = this.open.get(sessionId)
    if (!turn) return
    this.open.delete(sessionId)
    this.lastEnded.set(sessionId, turn)
    const now = this.now()
    this.records.endTurn(sessionId, turn.seq, now, outcome)
    // The budget is mail's: a turn the person or a caller started is theirs to spend
    if (turn.by !== 'mail') return
    if (turn.tokens > 0) this.tokens.set(sessionId, [...this.recent(sessionId), { at: now, tokens: turn.tokens }])
    if (outcome === 'empty') this.empty.set(sessionId, (this.empty.get(sessionId) ?? 0) + 1)
    else if (outcome === 'acted') this.empty.delete(sessionId)
  }

  private recent(sessionId: string): { at: number; tokens: number }[] {
    const since = this.now() - HOUR_MS
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

  /** Mail-started turns on this host since `since` (the host-wide cap, §7.5), or one session's */
  mailStartedSince(since: number, sessionId?: string): number {
    return this.records.mailStartedSince(since, sessionId)
  }

  /**
   * Whether the mail between sessions `a` and `b` (addresses) started more turns in the last hour than it may without a word from the person:
   * counted since the latest of an hour ago, the person's last word to either (a turn of theirs or a message), and the pair's Resume (§7.5)
   */
  pairLoopSpent(a: string, b: string): boolean {
    const since = Math.max(this.now() - HOUR_MS, this.lastPersonWord(a), this.lastPersonWord(b), this.pairFrom.get(pairKey(a, b)) ?? 0)
    return this.records.pairTurnsSince(a, b, since) > this.o.turnsPerHour
  }

  /** The person pressed Resume on a pair that was paused: its turns are counted from now */
  resumePair(a: string, b: string): void {
    this.pairFrom.set(pairKey(a, b), this.now())
  }

  /** When the person last spoke to the session at `address`: a turn they started, or a message they sent it; 0 when never */
  private lastPersonWord(address: string): number {
    const party = parseAddress(address)
    const turn = party?.kind === 'session' ? (this.records.lastPersonTurn(party.sessionId) ?? 0) : 0
    return Math.max(turn, this.records.lastFromPerson(address) ?? 0)
  }
}

/** An unordered pair, as one key */
const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`)
