import { errorMessage } from '@cc/protocol'
import type { MailRecords } from '../dev-services/store/mail.js'
import { parseAddress } from './address.js'
import type { MailService } from './service.js'

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
   * resumed. `quiet`: it can take mail without a turn, which is a live process of a tool that takes quiet input (Claude)
   */
  | { kind: 'ready'; live: boolean; quiet: boolean }

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
  /** Resolves when the tool took the input (§7.6.2); rejects with the reason when it did not, or could not be woken, and with `MailNotAtRest` when the receiver left rest meanwhile */
  deliver(sessionId: string, input: MailInput): Promise<void>
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
}

const DEFAULTS = { sweepEveryMs: 60_000, minWakeGapMs: 30_000, retryBaseMs: 5_000, maxRetryMs: 15 * 60_000, maxAttempts: 6 }

export class MailDelivery {
  private readonly now: () => number
  private readonly schedule: (ms: number, fn: () => void) => () => void
  private readonly o: Required<Omit<MailDeliveryOptions, 'now' | 'schedule'>>
  /** One delivery in flight per mailbox; a change that comes meanwhile is looked at when it ends */
  private readonly inFlight = new Set<string>()
  private readonly again = new Set<string>()
  /** The timer for the next due mail of a mailbox */
  private readonly timers = new Map<string, () => void>()
  /** When a mailbox was last woken: the 30 s gap */
  private readonly lastWake = new Map<string, number>()
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
    this.o = { ...DEFAULTS, ...Object.fromEntries(Object.entries(opts).filter(([k]) => k !== 'now' && k !== 'schedule')) }
  }

  /** Begins hearing the mailbox and sweeping. A host that is leaving does not (`stop`) */
  start(): void {
    if (this.running) return
    this.running = true
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
    this.running = false
    this.stopListening?.()
    this.stopSweep?.()
    for (const cancel of this.timers.values()) cancel()
    this.timers.clear()
  }

  /** Something about a session changed that may let its mail go: it came to rest, a card was answered, a limit lifted, it was restored */
  poke(sessionId: string): void {
    if (!this.running) return
    this.look(this.service.sessionAddress(sessionId))
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
    await Promise.all(this.records.recipientsWithMail().map((r) => this.process(r)))
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
    if (this.inFlight.has(recipient)) {
      this.again.add(recipient)
      return
    }
    this.inFlight.add(recipient)
    try {
      await this.deliverOnce(recipient, party.sessionId)
    } catch (e) {
      console.error(`[mail] ${recipient}: delivery failed (${errorMessage(e)})`)
    } finally {
      this.inFlight.delete(recipient)
      if (this.again.delete(recipient)) this.look(recipient)
    }
  }

  private async deliverOnce(recipient: string, sessionId: string): Promise<void> {
    const state = this.sessions.receiver(sessionId)
    // Held, not lost: a session that comes to rest, answers its card, or is restored pokes it again
    if (state.kind !== 'ready') return

    /*
     * Revalidated in the transaction that writes the attempt (§7.5): what was read since is not sent, and nothing left sends
     * nothing. Whether to go ahead is decided before the attempt is written: a try that is not made leaves no trace
     */
    const now = this.now()
    const plan = this.records.transaction(() => {
      const drained = this.service.drain(recipient)
      if (drained.messageIds.length === 0) return { drained, go: false as const, waitMs: 0 }
      // Mail that wakes goes at most every 30 s, but the person's words and urgent mail do not wait (§7.9)
      if (drained.wake && !drained.immediate) {
        const gap = (this.lastWake.get(recipient) ?? -Infinity) + this.o.minWakeGapMs - now
        if (gap > 0) return { drained, go: false as const, waitMs: gap }
      }
      // Quiet mail goes into a process that takes it; asleep, or in a tool that cannot, it waits for the next wake, which carries it
      if (!drained.wake && !state.quiet) return { drained, go: false as const, waitMs: 0 }
      this.records.markAttempt(recipient, drained.messageIds, now)
      return { drained, go: true as const, waitMs: 0 }
    })
    if (!plan.go) {
      if (plan.waitMs > 0) this.later(recipient, plan.waitMs)
      return
    }
    const { drained } = plan
    const quiet = !drained.wake

    try {
      await this.sessions.deliver(sessionId, { text: drained.text, quiet, line: drained.line })
    } catch (e) {
      if (e instanceof MailNotAtRest) {
        this.records.undoAttempt(recipient, drained.messageIds)
        return
      }
      const attempts = this.records.attemptsOf(recipient, drained.messageIds)
      const error = errorMessage(e)
      if (attempts >= this.o.maxAttempts) {
        this.records.transaction(() => {
          this.records.failAttempt(recipient, drained.messageIds, error, this.now())
          this.records.setHeld(recipient, drained.messageIds, 'failed')
        })
        return
      }
      const retryIn = Math.min(this.o.maxRetryMs, this.o.retryBaseMs * 2 ** Math.max(0, attempts - 1))
      this.records.transaction(() => this.records.failAttempt(recipient, drained.messageIds, error, this.now() + retryIn))
      this.look(recipient)
      return
    }
    // The tool took it (§7.6): delivered, and read for what went in whole
    this.records.transaction(() => this.records.markDelivered(recipient, drained.messageIds, drained.inline, this.now()))
    if (!quiet) this.lastWake.set(recipient, this.now())
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
