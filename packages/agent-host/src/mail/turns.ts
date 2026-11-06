import type { NormalizedEvent } from '@cc/protocol'
import type { MailboxRecords } from '../dev-services/store/mailbox.js'
import { parseAddress } from './address.js'
import { HOUR_MS } from './rules.js'

export type TurnGuardOptions = {
  now?: () => number
  /**
   * Whether the session's turn is still going from the host before: kept by the keeper, or cut by an update and continued (#1618). Its open row
   * stays open and is read back, its end is recorded here, and what it sends keeps the row's cause (§8.2 step 6). Without it every open row is closed `lost`
   */
  keepOpen?: (sessionId: string) => boolean
  /**
   * The session whose request the turn is, read from the store's rows of that turn (`MessageService.requestsIn`, docs/plans/turn-owned-by-no-one.md
   * §4.2), or null. Nothing of it is kept here: a restart or a swap reads it from the same rows
   */
  askerIn?: (sessionId: string, turn: TurnRead) => string | null
}

const STARTED_BY: readonly TurnStartedBy[] = ['mail', 'person', 'caller', 'cli', 'report', 'app']
/** The starter a stored row names; a word this build does not know is read as a caller's, which no count of mail-started turns counts */
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

/** What a turn's rows are read by: its number, who started it and its work message */
export type TurnRead = { turnSeq: number; by: TurnStartedBy; messageId: string | null }

/** A session's turn now (§8.2 step 6), read from its row so a restart or an update's continue keeps it; `asker` is an address, from the store (`askerIn`) */
export type TurnNow = TurnRead & { starter: string | null; asker: string | null; startedAt: number }

type LastTurn = {
  seq: number
  startedAt: number
  /** The turn's work message (a task, or the orchestrator's request) */
  messageId: string | null
}

/** What is known of a turn while it runs */
type Open = LastTurn & {
  acted: boolean
  by: TurnStartedBy
  /** The message that started it: what its sends are caused by */
  starter: string | null
  /** The caller whose work the turn is, when it is */
  owner?: string
}

/**
 * Each session's turns as mail sees them (docs/plans/mailbox.md §7.5, §8.2): the work message and starter of the running one, and the counts the
 * delivery's warning to the person reads (#2014): a pair's mail-started turns with no word from the person (`pairTurns`), and the host's
 * (`hostTurns`). Both are counted from the store, so a restart does not reset them. Nothing here holds or defers mail.
 *
 * **A turn continued after a restart or an update is not mail-started** (§8.2 step 6): nothing begins it here, its row is read back (`closeStale`
 * with `keepOpen`), so `current` gives the original turn's starter and work message, and it adds no row either count could count.
 */
/** What started a turn the mailbox did not: the person's own turn, or the CLI's, has no cause (D9); a caller's turn of known work was started by it */
const causeOf = (by: Exclude<TurnStartedBy, 'mail'>, messageId: string | null): string | null => (by === 'caller' ? messageId : null)

export class MailTurns {
  private readonly now: () => number
  private readonly open = new Map<string, Open>()
  /** The work message and number of each session's last turn that ended; replaced when the next turn begins */
  private readonly lastEnded = new Map<string, LastTurn>()

  constructor(
    private readonly records: MailboxRecords,
    private readonly opts: TurnGuardOptions = {},
  ) {
    this.now = opts.now ?? Date.now
  }

  /**
   * Turns the previous host left open: the ones of sessions still in that turn (kept by the keeper, or continued after an update cut them) go
   * on and are read back with their work message and starter; the rest can never end and are closed `lost`. Returns those closed
   */
  closeStale(): { sessionId: string; turnSeq: number }[] {
    const lost: { sessionId: string; turnSeq: number }[] = []
    for (const row of this.records.openTurns()) {
      if (this.opts.keepOpen?.(row.sessionId) && !this.open.has(row.sessionId)) {
        this.open.set(row.sessionId, { seq: row.turnSeq, startedAt: row.startedAt, acted: false, by: turnStartedBy(row.startedBy), messageId: row.messageId, starter: row.starterId })
      } else {
        this.records.endTurn(row.sessionId, row.turnSeq, this.now(), 'lost')
        lost.push({ sessionId: row.sessionId, turnSeq: row.turnSeq })
      }
    }
    return lost
  }

  /** Mail is about to start a turn of the session: its work message (or null) and the message that starts it. The turn's number */
  begin(sessionId: string, turn: { workMessage: string | null; starter: string | null }): number {
    this.end(sessionId, 'lost')
    const seq = this.records.nextTurnSeq(sessionId)
    const startedAt = this.now()
    this.records.startTurn({ sessionId, turnSeq: seq, messageId: turn.workMessage, starterId: turn.starter, startedBy: 'mail', startedAt })
    this.open.set(sessionId, { seq, startedAt, acted: false, by: 'mail', messageId: turn.workMessage, starter: turn.starter })
    return seq
  }

  /**
   * A turn the mailbox did not start begins: the person typed, a caller's message came, or the CLI ran on after its background work. `messageId`
   * is the work it belongs to, if known (its starter too, the task that started it). When a turn mail started is going, this is that turn (the
   * wake is its first input), and nothing is added. No count of mail-started turns counts it
   */
  beginOther(sessionId: string, by: Exclude<TurnStartedBy, 'mail'>, messageId: string | null, owner?: string): void {
    if (this.open.get(sessionId)?.by === 'mail') return
    this.end(sessionId, 'lost')
    const seq = this.records.nextTurnSeq(sessionId)
    const startedAt = this.now()
    const starter = causeOf(by, messageId)
    this.records.startTurn({ sessionId, turnSeq: seq, messageId, starterId: starter, startedBy: by, startedAt })
    this.open.set(sessionId, { seq, startedAt, acted: false, by, messageId, starter, ...(owner ? { owner } : {}) })
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
    if (!t) return undefined
    const read = { turnSeq: t.seq, by: t.by, messageId: t.messageId }
    return { ...read, starter: t.starter, asker: this.opts.askerIn?.(sessionId, read) ?? null, startedAt: t.startedAt }
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
    if (endedTurn) this.end(e.sessionId, turn.acted ? 'acted' : 'empty')
  }

  private end(sessionId: string, outcome: string): void {
    const turn = this.open.get(sessionId)
    if (!turn) return
    this.open.delete(sessionId)
    this.lastEnded.set(sessionId, turn)
    this.records.endTurn(sessionId, turn.seq, this.now(), outcome)
  }

  /** Mail-started turns on this host in the last hour (the host's warning, §7.5) */
  hostTurns(): number {
    return this.records.mailStartedSince(this.now() - HOUR_MS)
  }

  /**
   * The turns the mail between sessions `a` and `b` (addresses) started in the last hour with no word from the person: counted since the latest of an
   * hour ago and the person's last word to either, a turn of theirs or a message (the pair's warning, §7.5)
   */
  pairTurns(a: string, b: string): number {
    return this.records.pairTurnsSince(a, b, Math.max(this.now() - HOUR_MS, this.lastPersonWord(a), this.lastPersonWord(b)))
  }

  /** When the person last spoke to the session at `address`: a turn they started, or a message they sent it; 0 when never */
  private lastPersonWord(address: string): number {
    const party = parseAddress(address)
    const turn = party?.kind === 'session' ? (this.records.lastPersonTurn(party.sessionId) ?? 0) : 0
    return Math.max(turn, this.records.lastFromPerson(address) ?? 0)
  }
}

