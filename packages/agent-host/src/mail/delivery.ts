import { errorMessage } from '@cc/protocol'
import type { MailRecords, MessageRow, ReceiptRow } from '../dev-services/store/mail.js'
import { CENTRALU, PERSON, parseAddress } from './address.js'
import { needsReceiver } from './rules.js'
import { holdsInbound } from './policy.js'
import type { MailTurns } from './turns.js'
import type { DrainOptions, MailService } from './service.js'

/**
 * Waking is the mailbox's job (docs/plans/mailbox.md §5): a sender only posts, and `MailDelivery` hands each receiver its mail.
 * It works from events and sweeps only as a safety net; it keeps one delivery in flight per mailbox; and it writes what it is
 * about to do before it does it, so a host that dies in the middle leaves a trace instead of a guess (§7.6).
 *
 * What it delivers to is a session of this host, through `MailSessions`, which is the host's way into a session: whether it
 * can take a message now, and the message. The person is not woken (their mail is read in the Inbox), and an app takes mail
 * from slice 7, so a receipt for either waits where it is.
 */

/** What a receiver is, for the one question delivery asks: can it be told now */
export type ReceiverState =
  /** Not here: in the trash or deleted. Its mail waits, and goes with it if it is purged (§4.1) */
  | { kind: 'gone' }
  /** In a turn (mail waits for its end, until in-turn delivery in slice 6), waiting on a card (mail never answers a card), or at its usage limit */
  | { kind: 'busy'; why: 'turn' | 'card' | 'limited' }
  /**
   * At rest: idle or in error (woken the same way). `live` is whether its process runs; asleep, it is
   * resumed. `quiet`: it can take mail without a turn, which is a live process of a tool that takes quiet input (Claude). `auto`: it
   * runs without asking, so mail from another session or an app is held, not a reason to wake it (§7.7)
   */
  | { kind: 'ready'; live: boolean; quiet: boolean; auto?: boolean }

/**
 * `deliver` found the receiver no longer at rest after waking it: the person typed, or a card came up, while it resumed (§7.1). Nothing
 * was sent, and this is not a failed try: the mail waits for the receiver's next rest, which pokes it
 */
export class MailNotAtRest extends Error {
  constructor() {
    super('The session is in a turn again: the mail waits for its end')
    this.name = 'MailNotAtRest'
  }
}

export type MailInput = {
  /** The wake frame (§7.3) */
  text: string
  /** Goes in without a turn: Claude's `shouldQuery: false`. Only to a receiver that takes it (`quiet` above); otherwise it waits for a wake */
  quiet: boolean
  /** The compact line the conversation keeps of it (§9.2), in Centralu's words */
  line: string
}

export type MailSessions = {
  receiver(sessionId: string): ReceiverState
  /**
   * Resolves when the tool took the input (§7.6.2); rejects with the reason when it did not, or could not be woken, and with `MailNotAtRest`
   * when the receiver left rest meanwhile. A tool that stayed silent past the wait counts as having taken it; if it then fails the input,
   * which it never ran, `late` is called with the error (after this has resolved)
   */
  deliver(sessionId: string, input: MailInput, late?: (error: Error) => void): Promise<void>
  /** One line in the session's conversation, in Centralu's words (§7.6.5: a delivery that may not have arrived) */
  note(sessionId: string, text: string): void
}

export type MailDeliveryOptions = {
  now?: () => number
  /** Runs `fn` after `ms`; returns how to cancel it. Tests drive it by hand */
  schedule?: (ms: number, fn: () => void) => () => void
  /** The safety-net sweep (§5): 60 s */
  sweepEveryMs?: number
  /** At most one wake per session in this long, urgent mail and the person's words excepted (§7.9) */
  minWakeGapMs?: number
  /** The first retry after a delivery failed; it doubles, up to `maxRetryMs` */
  retryBaseMs?: number
  maxRetryMs?: number
  /** After this many failed tries mail is held for the person (Inbox: Retry) */
  maxAttempts?: number
  /** The loop and token guards (§7.9); without them mail is held by nothing but the receiver's policy */
  turns?: MailTurns
  /** When the delivery last ran, kept by the host: how long it was off tells how to start (§7.9) */
  heartbeat?: { read(): number | null; write(ms: number): void }
  /** A host that was off longer than this wakes a sleeping session only for mail that needs it (30 minutes) */
  catchUpAfterMs?: number
  /** More sleeping sessions than this to wake after such a stop, and the person is asked once */
  crowdOver?: number
  /** Sleeping sessions resumed at once, after such a stop */
  resumeAtOnce?: number
}

const DEFAULTS = { sweepEveryMs: 60_000, minWakeGapMs: 30_000, retryBaseMs: 5_000, maxRetryMs: 15 * 60_000, maxAttempts: 6, catchUpAfterMs: 30 * 60_000, crowdOver: 10, resumeAtOnce: 2 }

export class MailDelivery {
  private readonly now: () => number
  private readonly schedule: (ms: number, fn: () => void) => () => void
  private readonly o: Required<Omit<MailDeliveryOptions, 'now' | 'schedule' | 'heartbeat' | 'turns'>>
  private readonly heartbeat: MailDeliveryOptions['heartbeat']
  private readonly turns: MailTurns | undefined
  /** One delivery in flight per mailbox; a change that comes meanwhile is looked at when it ends */
  private readonly inFlight = new Set<string>()
  private readonly again = new Set<string>()
  /** The timer for the next due mail of a mailbox */
  private readonly timers = new Map<string, () => void>()
  /** When a mailbox was last woken: the 30 s gap */
  private readonly lastWake = new Map<string, number>()
  /**
   * After a stop longer than `catchUpAfterMs` (§7.9): the time the host started. A sleeping session is then woken only for mail that
   * needs it, among what came due before; the rest waits for its next turn. Null in a host that was running a moment ago
   */
  private cutoff: number | null = null
  /** The first sweep after such a stop is the catch-up */
  private catchUpPending = false
  /** When the sweep last ran: a gap longer than a stop's means the host was away without stopping */
  private lastSweepAt: number | null = null
  /** The sleeping sessions that would be woken and are too many to wake without asking (§7.9): the Inbox asks once */
  private crowd: string[] | null = null
  /** Sessions the person said to leave for their next turn: not woken until something about them happens */
  private readonly left = new Set<string>()
  private stopListening: (() => void) | null = null
  private stopSweep: (() => void) | null = null
  private running = false

  constructor(
    private readonly service: MailService,
    private readonly records: MailRecords,
    private readonly sessions: MailSessions,
    opts: MailDeliveryOptions = {},
  ) {
    this.now = opts.now ?? Date.now
    this.schedule =
      opts.schedule ??
      ((ms, fn) => {
        const t = setTimeout(fn, ms)
        t.unref()
        return () => clearTimeout(t)
      })
    this.heartbeat = opts.heartbeat
    this.turns = opts.turns
    this.o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([k]) => k !== 'now' && k !== 'schedule' && k !== 'heartbeat' && k !== 'turns')) }
  }

  /** Begins hearing the mailbox and sweeping. A host that is leaving does not (`stop`) */
  start(): void {
    if (this.running) return
    this.running = true
    this.turns?.closeStale()
    this.sayWhatWasLeftHalfDone()
    const last = this.heartbeat?.read() ?? null
    if (last !== null && this.now() - last > this.o.catchUpAfterMs) {
      this.cutoff = this.now()
      this.catchUpPending = true
    }
    this.stopListening = this.service.onChange((c) => {
      for (const r of c.recipients) this.look(r)
    })
    const loop = (): void => {
      this.stopSweep = this.schedule(this.o.sweepEveryMs, () => {
        void this.sweep().finally(() => {
          if (this.running) loop()
        })
      })
    }
    loop()
    void this.sweep()
  }

  stop(): void {
    // While the person has not answered for the crowd, the host is still as it was when it started: a restart asks again
    if (!this.crowd) this.heartbeat?.write(this.now())
    this.running = false
    this.stopListening?.()
    this.stopSweep?.()
    for (const cancel of this.timers.values()) cancel()
    this.timers.clear()
  }

  /** Something about a session changed that may let its mail go: it came to rest, a card was answered, a limit lifted, it was restored */
  poke(sessionId: string): void {
    if (!this.running) return
    const address = this.service.sessionAddress(sessionId)
    // Something happened to it (the person is using it, say): it is no longer one to ask about, nor one to leave
    this.left.delete(address)
    if (this.crowd?.includes(address)) {
      this.crowd = this.crowd.filter((r) => r !== address)
      if (this.crowd.length === 0) this.crowd = null
      this.crowdChanged()
    }
    this.look(address)
  }

  /**
   * The safety net (§5): every mailbox with mail waiting is looked at, whatever an event missed, and retention runs.
   * Resolves when each has been tried once
   */
  async sweep(): Promise<void> {
    if (!this.running) return
    try {
      this.service.sweep()
    } catch (e) {
      console.error(`[mail] retention failed; it runs again at the next sweep: ${errorMessage(e)}`)
    }
    const now = this.now()
    // The host itself may have been away without stopping (the computer asleep): the same rule as after a stop
    if (this.lastSweepAt !== null && now - this.lastSweepAt > this.o.catchUpAfterMs) {
      this.cutoff = now
      this.catchUpPending = true
    }
    this.lastSweepAt = now
    this.moveOnWorkOfGoneSessions()
    const recipients = this.records.recipientsWithMail()
    if (this.catchUpPending) {
      this.catchUpPending = false
      await this.catchUp(recipients)
    } else await this.processAll(recipients)
    // After the catch-up, so a host that stops while the crowd waits is read as it was when it started (a restart asks again)
    if (!this.crowd) this.heartbeat?.write(now)
  }

  /** Every mailbox once; the sleeping sessions this wakes are resumed two at a time, as in the catch-up (§7.9) */
  private async processAll(recipients: string[]): Promise<void> {
    const asleep: string[] = []
    const rest: string[] = []
    for (const recipient of recipients) {
      const party = parseAddress(recipient)
      const state = party?.kind === 'session' ? this.sessions.receiver(party.sessionId) : null
      if (state?.kind === 'ready' && !state.live) asleep.push(recipient)
      else rest.push(recipient)
    }
    await Promise.all([...rest.map((r) => this.process(r)), this.wakeInOrder(asleep)])
  }

  /**
   * The first sweep after the host was off a long while (§7.9). Everything that came due while it was down is one batched wake
   * per receiver, as always. Sessions that are awake take their mail at once. A sleeping one is woken only for mail that needs it,
   * the person's threads first, then the ones with a question waiting, then the rest, two at a time. Past `crowdOver` of them
   * nobody is woken: the Inbox asks once (`crowdWaiting`, `answerCrowd`)
   */
  private async catchUp(recipients: string[]): Promise<void> {
    const asleep: { recipient: string; rank: number }[] = []
    const awake: string[] = []
    for (const recipient of recipients) {
      const party = parseAddress(recipient)
      if (party?.kind !== 'session') continue
      const state = this.sessions.receiver(party.sessionId)
      if (state.kind === 'ready' && !state.live) {
        const d = this.service.drain(recipient, { skip: this.skipOld })
        if (d.messageIds.length > 0) asleep.push({ recipient, rank: d.immediate ? 0 : d.asks ? 1 : 2 })
      } else awake.push(recipient)
    }
    asleep.sort((a, b) => a.rank - b.rank)
    if (asleep.length > this.o.crowdOver) {
      this.crowd = asleep.map((a) => a.recipient)
      this.crowdChanged()
    } else await this.wakeInOrder(asleep.map((a) => a.recipient))
    await Promise.all(awake.map((r) => this.process(r)))
  }

  private async wakeInOrder(recipients: string[]): Promise<void> {
    for (let i = 0; i < recipients.length; i += this.o.resumeAtOnce) {
      await Promise.all(recipients.slice(i, i + this.o.resumeAtOnce).map((r) => this.process(r)))
    }
  }

  /** How many sleeping sessions are waiting for the person to say whether to wake them (§7.9); zero when nobody is asking */
  crowdWaiting(): number {
    return this.crowd?.length ?? 0
  }

  /** The person's answer: wake them (two at a time, the ones with the most pressing mail first), or leave them for their next turn */
  async answerCrowd(wake: boolean): Promise<void> {
    const crowd = this.crowd
    this.crowd = null
    if (!crowd) return
    this.crowdChanged()
    if (!wake) {
      for (const r of crowd) this.left.add(r)
      return
    }
    await this.wakeInOrder(crowd)
  }

  /** For a session in the crowd or left for its next turn: everything but the person's words written since the host came back */
  private readonly skipUnlessPersonSince = (message: MessageRow, receipt: ReceiptRow): boolean =>
    message.sender !== PERSON || (this.cutoff !== null && receipt.dueAt <= this.cutoff)

  /** What a host that was off a long while does not wake a sleeping session for (`cutoff`) */
  private readonly skipOld = (message: MessageRow, receipt: ReceiptRow): boolean =>
    this.cutoff !== null && receipt.dueAt <= this.cutoff && !needsReceiver(parseAddress(message.sender)?.kind ?? 'session', message)

  /**
   * A session that left the host's list without telling the mailbox (the host stopped between the trash move and `sessionGone`,
   * or the call failed) still holds work: it is moved on now (§3.3). Cheap: only the owners and assignees of open threads
   */
  private moveOnWorkOfGoneSessions(): void {
    for (const address of this.records.partiesOfOpenThreads()) {
      const party = parseAddress(address)
      if (party?.kind !== 'session' || this.sessions.receiver(party.sessionId).kind !== 'gone') continue
      try {
        this.service.sessionGone(party.sessionId)
      } catch (e) {
        console.error(`[mail] ${address}: the work it held could not be moved on (${errorMessage(e)})`)
      }
    }
  }

  /** The tool did not take the wake: tried again after a wait that doubles, or held for the person when it has failed too often */
  private failedTry(recipient: string, messageIds: readonly string[], error: string): void {
    const attempts = this.records.attemptsOf(recipient, messageIds)
    if (attempts >= this.o.maxAttempts) {
      this.records.transaction(() => {
        this.records.failAttempt(recipient, messageIds, error, this.now())
        this.hold(recipient, messageIds, 'failed')
      })
      return
    }
    const retryIn = Math.min(this.o.maxRetryMs, this.o.retryBaseMs * 2 ** Math.max(0, attempts - 1))
    this.records.transaction(() => this.records.failAttempt(recipient, messageIds, error, this.now() + retryIn))
    this.look(recipient)
  }

  /**
   * The tool failed a wake after the wait for it ran out and the wake was counted as taken (§7.6.2). Counted as taken, the mail was
   * delivered and read; failed, it must not stay so. It is not sent again by itself, though: a failure told this late (the session was
   * stopped or closed, a turn that took the input among others ended in an error) does not prove the tool never ran it, and sending
   * work twice is worse than asking. So it is treated as a restart's uncertain delivery (§7.6.5, `MailService.deliveryFailedLate`): unread
   * and undelivered again, held `uncertain` for the person (Inbox: Send again), said in the thread to the sender and in the receiver's
   * conversation, and never sent again by itself, unless it is news that starts no work. Only the receipts that wake delivered:
   * mail delivered again since by another wake, handled, or held is left alone
   */
  private takeBack(recipient: string, messageIds: readonly string[], deliveredAt: number, cause: Error): void {
    console.error(`[mail] ${recipient}: the tool failed a wake after it had been counted as taken (${errorMessage(cause)}); not sent again by itself`)
    const { held } = this.service.deliveryFailedLate(recipient, messageIds, deliveredAt)
    const party = parseAddress(recipient)
    if (held > 0 && party?.kind === 'session') {
      const n = held === 1 ? 'A delivery' : `${held} deliveries`
      this.sessions.note(party.sessionId, `✉ ${n} may have reached you although the tool reported a failure, and was not sent again: the Inbox has Resend and Dismiss`)
    }
  }

  /** A delivery the previous host left half done is held or sent again (`reconcileInterrupted`), and the receiver is told when it is held */
  private sayWhatWasLeftHalfDone(): void {
    try {
      for (const { recipient, held } of this.service.reconcileInterrupted()) {
        const party = parseAddress(recipient)
        if (held > 0 && party?.kind === 'session') {
          const n = held === 1 ? 'A delivery' : `${held} deliveries`
          this.sessions.note(party.sessionId, `✉ ${n} may not have arrived when Centralu restarted, and was not sent again: the Inbox has Resend and Dismiss`)
        }
      }
    } catch (e) {
      console.error(`[mail] could not look at what the last host left half done: ${errorMessage(e)}`)
    }
  }

  /** Looks at a mailbox: now if its mail is due, else when it is */
  private look(recipient: string): void {
    if (!this.running) return
    const party = parseAddress(recipient)
    // The person reads in the Inbox and an app takes mail from slice 7: neither is woken
    if (party?.kind !== 'session') return
    const now = this.now()
    // Mail already due is delivered now; mail that falls due later is looked at then
    if (this.records.hasDue(recipient, now)) void this.process(recipient)
    const due = this.records.nextDue(recipient, now)
    if (due === null) return
    this.timers.get(recipient)?.()
    this.timers.delete(recipient)
    const wait = due - now
    this.timers.set(
      recipient,
      this.schedule(wait, () => {
        this.timers.delete(recipient)
        void this.process(recipient)
      }),
    )
  }

  /** Delivers to one mailbox what is due, once, if the receiver can take it now */
  async process(recipient: string): Promise<void> {
    if (!this.running) return
    const party = parseAddress(recipient)
    if (party?.kind !== 'session') return
    // In the crowd the person has not answered for, or told to be left for its next turn: not woken by what came before that, but
    // by the person's own words since (they wrote to it)
    const waiting = !!this.crowd?.includes(recipient) || this.left.has(recipient)
    if (this.inFlight.has(recipient)) {
      this.again.add(recipient)
      return
    }
    this.inFlight.add(recipient)
    try {
      await this.deliverOnce(recipient, party.sessionId, waiting)
    } catch (e) {
      console.error(`[mail] ${recipient}: delivery failed (${errorMessage(e)})`)
    } finally {
      this.inFlight.delete(recipient)
      if (this.again.delete(recipient)) this.look(recipient)
    }
  }

  private async deliverOnce(recipient: string, sessionId: string, waiting: boolean): Promise<void> {
    const state = this.sessions.receiver(sessionId)
    // Held, not lost: a session that comes to rest, answers its card, or is restored pokes it again
    if (state.kind !== 'ready') return

    /*
     * Revalidated in the transaction that writes the attempt (§7.5): what was read since is not sent, and nothing left sends
     * nothing. Whether to go ahead is decided before the attempt is written: a try that is not made leaves no trace
     */
    const now = this.now()
    const plan = this.records.transaction(() => {
      const skip = waiting ? this.skipUnlessPersonSince : state.live ? undefined : this.skipOld
      const drained = this.service.drain(recipient, { ...(skip ? { skip } : {}), ...this.guardsFor(recipient, state) })
      if (drained.heldBack.length > 0) this.records.transaction(() => this.holdBack(recipient, drained.heldBack))
      if (drained.messageIds.length === 0) return { drained, go: false as const, waitMs: 0 }
      // Mail that wakes goes at most every 30 s, but the person's words and urgent mail do not wait (§7.9)
      if (drained.wake && !drained.immediate) {
        const gap = (this.lastWake.get(recipient) ?? -Infinity) + this.o.minWakeGapMs - now
        if (gap > 0) return { drained, go: false as const, waitMs: gap }
      }
      // Quiet mail goes into a process that takes it; asleep, or in a tool that cannot, it waits for the next wake, which carries it.
      // What was to be told of and held (a policy, a spent budget) is listed for the person now: no wake may come to carry it
      if (!drained.wake && !state.quiet) {
        this.holdBack(recipient, drained.quieted)
        return { drained, go: false as const, waitMs: 0 }
      }
      this.records.markAttempt(recipient, drained.messageIds, now)
      return { drained, go: true as const, waitMs: 0 }
    })
    if (!plan.go) {
      if (plan.waitMs > 0) this.later(recipient, plan.waitMs)
      return
    }
    const { drained } = plan
    const quiet = !drained.wake

    // A turn mail starts is known before the session's first event of it, and forgotten if the tool does not take the input
    const turn = quiet ? undefined : this.turns?.begin(sessionId, drained.workThread ?? drained.threads[0] ?? null)
    const cancelTurn = () => {
      if (turn !== undefined) this.turns?.cancel(sessionId, turn)
    }
    const delivered: { at?: number } = {}
    try {
      await this.sessions.deliver(sessionId, { text: drained.text, quiet, line: drained.line }, (e) => {
        cancelTurn()
        // Told after `deliver` resolved, so the time is set
        if (delivered.at !== undefined) this.takeBack(recipient, drained.messageIds, delivered.at, e)
      })
    } catch (e) {
      cancelTurn()
      if (e instanceof MailNotAtRest) {
        this.records.undoAttempt(recipient, drained.messageIds)
        return
      }
      this.failedTry(recipient, drained.messageIds, errorMessage(e))
      return
    }
    // The tool took it (§7.6): delivered, and read for what went in whole. What was told of without a turn for a reason is held for the person
    const deliveredAt = this.now()
    delivered.at = deliveredAt
    this.records.transaction(() => {
      // Told of and held is not read: the person finds it in the Inbox, with Release, until they have seen it
      const heldIds = new Set(drained.quieted.map((q) => q.messageId))
      this.records.markDelivered(recipient, drained.messageIds, drained.inline.filter((id) => !heldIds.has(id)), deliveredAt)
      for (const reason of new Set(drained.quieted.map((q) => q.reason))) {
        this.hold(recipient, drained.quieted.filter((q) => q.reason === reason).map((q) => q.messageId), reason)
      }
    })
    if (!quiet) this.lastWake.set(recipient, this.now())
    // The person wrote to it and it took the words: it is no longer waiting for an answer about the crowd
    if (waiting) {
      this.left.delete(recipient)
      this.crowd = this.crowd?.filter((r) => r !== recipient) ?? null
      if (this.crowd?.length === 0) this.crowd = null
      this.crowdChanged()
    }
  }

  /** What the receiver's guards say about its mail (§7.7, §7.9) */
  private guardsFor(recipient: string, state: { auto?: boolean }): Pick<DrainOptions, 'quiet' | 'holdBack'> {
    const session = parseAddress(recipient)
    const spent = this.turns && session?.kind === 'session' && this.turns.budgetSpent(session.sessionId)
    return {
      holdBack: (message, receipt, thread) => {
        // The person's words are never held, and mail the person released has been looked at
        if (!this.turns || receipt.held === 'released' || message.sender === PERSON) return null
        return this.turns.loopSpent(thread.id) ? 'loop' : null
      },
      quiet: (message, receipt, thread) => {
        // The person's words and Centralu's own are never held. Another session's or an app's, to a session that runs without asking,
        // is told of and never a reason to wake it, until the person releases it
        if (state.auto && receipt.held !== 'released' && holdsInbound(message, thread)) return 'policy'
        // A session whose mail has used up its budget is told of what comes, and not woken for it (Centralu's own are never held)
        if (spent && receipt.held !== 'released' && message.sender !== PERSON && message.sender !== CENTRALU) return 'budget'
        return null
      },
    }
  }

  private holdBack(recipient: string, held: readonly { messageId: string; reason: string }[]): void {
    for (const reason of new Set(held.map((h) => h.reason))) {
      this.hold(recipient, held.filter((h) => h.reason === reason).map((h) => h.messageId), reason)
    }
  }

  /** Mail held for the person to act on: written, and the Inbox is told (it lists it with the button that frees it) */
  private hold(recipient: string, messageIds: readonly string[], reason: string): void {
    this.records.setHeld(recipient, messageIds, reason)
    this.service.announceMessages(messageIds)
  }

  /** The question about sleeping sessions came up, or was answered or went away: the Inbox is told */
  private crowdChanged(): void {
    this.service.announce('')
  }

  /** The person pressed Resume on a session whose mail was paused for its budget: counted anew, and what was held goes now */
  resumeSession(sessionId: string): void {
    this.turns?.resumeBudget(sessionId)
    const recipient = this.service.sessionAddress(sessionId)
    this.releaseHeld((r) => r.recipient === recipient && r.held === 'budget')
  }

  /** The person pressed Resume on a thread paused for its turns: counted from now, and what was held goes now */
  resumeThread(threadId: string): void {
    this.turns?.resumeLoop(threadId)
    this.releaseHeld((r) => r.held === 'loop' && this.records.message(r.messageId)?.threadId === threadId)
  }

  private releaseHeld(which: (r: ReceiptRow) => boolean): void {
    const byRecipient = new Map<string, string[]>()
    for (const r of this.records.heldReceipts().filter(which)) byRecipient.set(r.recipient, [...(byRecipient.get(r.recipient) ?? []), r.messageId])
    for (const [recipient, ids] of byRecipient) this.service.resendHeld(recipient, ids)
  }

  /** Looks at the mailbox again after `ms` */
  private later(recipient: string, ms: number): void {
    this.timers.get(recipient)?.()
    this.timers.set(
      recipient,
      this.schedule(ms, () => {
        this.timers.delete(recipient)
        void this.process(recipient)
      }),
    )
  }
}
