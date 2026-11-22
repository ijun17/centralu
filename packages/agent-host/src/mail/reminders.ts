import type { MailboxRecords, RecipientRow, ReleaseWhy } from '../dev-services/store/mailbox.js'
import { senderKind } from './address.js'
import type { MessageService } from './messages.js'
import { restForReminder, type RestFacts, type RestWhy } from './rest.js'
import { HOUR_MS, REMINDER } from './rules.js'

/**
 * The unanswered reminder (docs/plans/mailbox.md §10): a message that needs a reply and has none while its receiver is at rest is
 * reminded, twice at most, then released, and its sender told once in a gathered notice (D25). It runs with the delivery's sweep, and
 * reads everything but how long a session has been at rest from the store, so a restart or a swap keeps its counts and clocks.
 *
 * **Only the receiver's host decides.** A row is reminded and released only by the host whose session it is to (`facts` is null for any
 * other address: another computer's session, or a linked machine's on a hub). A sender's copy of mail that crossed a link is never
 * reminded or released where it was written; what the receiver's host releases comes back as a receipt (`MailAcross`), and that host's
 * notice to the sender crosses as any notice does.
 */

/** Why no reminder went, or what was posted: the decision log's words (§10.8) */
export type ReminderWhy = RestWhy | 'covered' | 'cap_gap' | 'cap_day' | 'undelivered' | 'grace' | 'again'

export type ReminderDecision =
  | { remind: RecipientRow[]; n: 1 | 2; quiet: boolean }
  | { remind: null; why: ReminderWhy; detail?: string }

/** The releases this sweep writes, and the reminders' words for them: the stop notice owns every other release */
const REMINDER_RELEASES: readonly ReleaseWhy[] = ['reminders', 'waited', 'working', 'waiting']

export type ReminderOptions = {
  now?: () => number
  log?: (line: string) => void
  limits?: Partial<typeof REMINDER>
}

export class MailReminders {
  private readonly now: () => number
  private readonly log: (line: string) => void
  private readonly limits: typeof REMINDER
  /**
   * When each session was last found not at rest (its own work running, say), and when this host started: a session is at rest since the latest of
   * these and its last turn's end (§10.1). Kept in memory, so a restart starts the clock again, as the sleep rule does
   */
  private readonly busySeen = new Map<string, number>()
  private readonly startedAt: number
  /** The last decision logged per session, so the log says each change once (§10.8) */
  private readonly logged = new Map<string, string>()

  constructor(
    private readonly service: Pick<MessageService, 'remind' | 'stops'>,
    private readonly records: MailboxRecords,
    /** A session of this host by its address, as the rest rule reads it; null for any address this host does not decide for */
    private readonly facts: (address: string) => RestFacts | null,
    opts: ReminderOptions = {},
  ) {
    this.now = opts.now ?? Date.now
    this.log = opts.log ?? ((line) => console.error(line))
    this.limits = { ...REMINDER, ...opts.limits }
    this.startedAt = this.now()
  }

  /** The 60 s sweep: releases what is due, reminds each session at rest of what still waits, and tells senders what was released */
  sweep(): void {
    const now = this.now()
    for (const address of this.records.awaitingRecipients()) {
      const facts = this.facts(address)
      if (!facts) continue
      this.release(address, facts, now)
      this.act(address, this.decide(address, facts, now))
    }
    this.tellSenders(now)
  }

  /** What a reminder to `address` would do now (§10.1 to §10.4), recording when it was found not at rest */
  decide(address: string, f: RestFacts, now: number): ReminderDecision {
    const L = this.limits
    const rows = this.records.awaitingAnswer(address).filter((r) => r.reminded < L.perRow)
    if (rows.length === 0) return { remind: null, why: 'again', detail: 'nothing left to remind' }
    const rest = restForReminder(f, now, L.personQuietMs)
    if (!rest.atRest) {
      this.busySeen.set(address, now)
      return { remind: null, why: rest.why, ...(rest.why === 'own_work' ? { detail: `${f.work} ${f.work === 1 ? 'task' : 'tasks'}` } : {}) }
    }
    const since = Math.max(this.startedAt, this.busySeen.get(address) ?? 0, f.lastTurn?.endedAt ?? 0)
    if (now - since < L.graceMs) return { remind: null, why: 'grace' }
    // A second reminder comes `againMs` after the first one's turn ended
    const due = rows.filter((r) => r.reminded === 0 || now >= this.reminderTurnEnd(address, r) + L.againMs)
    if (due.length === 0) return { remind: null, why: 'again' }
    const covers = due.map((r) => this.records.covering(r))
    const uncovered = due.filter((_, i) => covers[i] === null)
    if (uncovered.length === 0) {
      const by = covers.find((c) => c !== null)
      return { remind: null, why: 'covered', ...(by ? { detail: `by ${short(by.messageId)} to ${short(by.recipient)}` } : {}) }
    }
    const capped = this.capped(address, now)
    if (capped) return { remind: null, why: capped }
    const remind = uncovered.slice(0, L.rowsAtMost)
    return { remind, n: remind.some((r) => r.reminded > 0) ? 2 : 1, quiet: this.cold(f, now) }
  }

  /**
   * Its rows that are due for release (§10.3), each released once: after its last reminder's turn ended `againMs` ago (`reminders`), or `unansweredAfterMs`
   * after its delivery, saying why it is still open: waiting on another (`waiting`), on its own work (`working`), or neither (`waited`)
   */
  private release(address: string, f: RestFacts, now: number): void {
    const L = this.limits
    if (f.receiver.kind === 'gone') return
    const inTurn = f.receiver.kind === 'busy' || f.receiver.joins === true
    for (const r of this.records.awaitingAnswer(address)) {
      let why: ReleaseWhy | null = null
      if (r.reminded >= L.perRow && !inTurn && now >= this.reminderTurnEnd(address, r) + L.againMs) why = 'reminders'
      else if (r.deliveredAt !== null && now - r.deliveredAt >= L.unansweredAfterMs) why = this.records.covering(r) ? 'waiting' : f.work > 0 ? 'working' : 'waited'
      if (why && this.records.markReleased(r.messageId, address, now, why)) this.log(`[mail] reminder ${short(address)}: released ${short(r.messageId)} (${why})`)
    }
  }

  /**
   * Each sender of rows this sweep's rules released and nobody told yet hears of them in one notice (D25). A session of this host is told when its own
   * follow-up budget allows (D24) and quietly when it is cold; the person, and a session on another computer (whose host keeps its own budget), at once
   */
  private tellSenders(now: number): void {
    for (const sender of this.records.untoldSenders(REMINDER_RELEASES)) {
      const kind = senderKind(sender)
      if (kind !== 'session' && kind !== 'person') continue
      const f = kind === 'session' ? this.facts(sender) : null
      const capped = f ? this.capped(sender, now) : null
      if (capped) {
        this.say(sender, `sender told later (${capped})`)
        continue
      }
      this.service.stops.tellReleased(sender, REMINDER_RELEASES, f !== null && this.cold(f, now))
      this.say(sender, 'sender told', true)
    }
  }

  private act(address: string, d: ReminderDecision): void {
    if (d.remind === null) {
      this.say(address, `no (${d.why}${d.detail ? `; ${d.detail}` : ''})`)
      return
    }
    if (this.service.remind(address, d.remind, d.quiet)) {
      this.say(address, `posted ${d.n}/${this.limits.perRow} rows=${d.remind.length} quiet=${d.quiet ? 'yes' : 'no'}`, true)
    }
  }

  /** One line per change of a session's decision, and one for every reminder posted or sender told (§10.8) */
  private say(address: string, what: string, always = false): void {
    if (!always && this.logged.get(address) === what) return
    this.logged.set(address, what)
    this.log(`[mail] reminder ${short(address)}: ${what}`)
  }

  /**
   * Whether a follow-up to `address` must wait (D24): one is undelivered, the last was delivered under `gapMs` ago, or `perDay` were delivered in 24 hours.
   * Reminders and notices of unanswered mail count together, read from the store
   */
  private capped(address: string, now: number): 'undelivered' | 'cap_gap' | 'cap_day' | null {
    const L = this.limits
    const sent = this.records.followUpsTo(address, now - 24 * HOUR_MS)
    if (sent.some((r) => r.deliveredAt === null)) return 'undelivered'
    if (sent.length >= L.perDay) return 'cap_day'
    if (sent.some((r) => r.deliveredAt !== null && now - r.deliveredAt < L.gapMs)) return 'cap_gap'
    return null
  }

  /** Asleep past `warmMs` since its last turn: a follow-up is posted quiet and rides its next wake (#561) */
  private cold(f: RestFacts, now: number): boolean {
    return f.receiver.kind === 'ready' && !f.receiver.live && now - (f.lastTurn?.endedAt ?? 0) >= this.limits.warmMs
  }

  /** When the turn that `r`'s last reminder was delivered in ended; the reminder's delivery when it started none (it went quiet) or that turn still runs */
  private reminderTurnEnd(address: string, r: RecipientRow): number {
    if (r.remindedAt === null) return 0
    const reminder = this.records.followUpsTo(address, r.remindedAt).find((n) => n.deliveredAt === r.remindedAt)
    return (reminder && this.records.turnEndOf(reminder)) ?? r.remindedAt
  }
}

/** The first 8 characters of an id or address's last part, as the host logs ids */
function short(idOrAddress: string): string {
  return (idOrAddress.split(/[/.]/).at(-1) ?? idOrAddress).slice(0, 8)
}
