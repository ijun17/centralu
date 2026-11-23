/**
 * Mail held for the person (docs/plans/mailbox.md §7.4): their acts on it (trusting or dismissing a project, resuming what an earlier build
 * held, sending or dismissing what the delivery held) and the delivery's holds (`MessageService.holds`). Each runs in the service's transaction
 * (`run`), since what `changed` queues goes to the listeners only once that commits
 */
import type { MailFacts, MailKind, MailRow, MailboxRecords } from '../dev-services/store/mailbox.js'
import { CENTRALU, PERSON, parseAddress } from './address.js'
import { droppedText, trustedText, type MailReach } from './reach.js'
import { replyAnswers } from './rules.js'

/** What it writes with: the service's records, reach, clock, transaction, Centralu notices and change listeners */
type HeldMailDeps = {
  records: MailboxRecords
  reach: Pick<MailReach, 'projectLabel'>
  now: () => number
  run: <T>(fn: () => T) => T
  notice: (recipient: string, m: { kind: MailKind; body: string; facts: MailFacts; dedupeKey: string }) => unknown
  changed: (m: Pick<MailRow, 'id' | 'rootId'>, recipients: readonly string[]) => void
}

export class HeldMail {
  constructor(private readonly d: HeldMailDeps) {}

  /**
   * The person dismissed what an untrusted project sent out (or the project was deleted): its `policy` rows are deleted, with their messages when no row
   * is left, the questions answers among them held open again (D8), and the refused records of its delegations go. Each sender is told once (S13)
   */
  dismissProject(projectId: string, label = this.d.reach.projectLabel(projectId)): { rows: number; senders: string[] } {
    return this.d.run(() => {
      const now = this.d.now()
      const held = this.d.records.heldPolicy().filter((h) => h.senderProject === projectId)
      // One message to several recipients is held in several rows: it is dropped, and counted, once
      const messages = [...new Set(held.map((h) => h.row.messageId))].flatMap((id) => this.d.records.message(id) ?? [])
      for (const m of messages) if (m.replyTo !== null) this.d.records.answerDropped(m.id)
      const rows = this.d.records.deleteHeld(held.map((h) => h.row))
      this.d.records.deleteRows(this.d.records.refusedRecords(projectId).map((p) => p.row))
      const dropped = new Map<string, string[]>()
      for (const m of messages) dropped.set(m.sender, [...(dropped.get(m.sender) ?? []), m.id])
      for (const [sender, ids] of dropped) {
        if (parseAddress(sender)?.kind !== 'session') continue
        this.d.notice(sender, { kind: 'notice', body: droppedText(ids, label), facts: {}, dedupeKey: `dropped:${sender}:${projectId}:${now}` })
      }
      for (const m of messages) this.d.changed(m, [PERSON])
      return { rows, senders: [...dropped.keys()] }
    })
  }

  /**
   * The person trusted `projectId` (§7.4): the rows held `policy` for it go, in the order they were sent, the questions they answer are answered, and each
   * caller whose delegations were refused for it gets one notice (S16) and loses the records. Returns the recipients for the delivery to poke
   */
  trustChanged(projectId: string): string[] {
    return this.d.run(() => {
      const now = this.d.now()
      const pokes = new Set<string>()
      for (const { row, senderProject } of this.d.records.heldPolicy()) {
        const m = senderProject === projectId ? this.d.records.message(row.messageId) : undefined
        if (!m) continue
        // Let go, an unread row is delivered as the mail it is, also one an older build told of quietly while it held it (§6.3). What it answers
        // (`replyAnswers`) is answered now; a task's answer is the reply its send marked on the task's row while it was held (`answerHeld`)
        this.d.records.letGo(row.recipient, [m.id])
        const target = m.replyTo === null ? undefined : this.d.records.message(m.replyTo)
        const marked = target !== undefined && this.d.records.recipient(target.id, m.sender)?.answerId === m.id
        if (target && replyAnswers(target, { needsReply: m.needsReply, answer: marked })) this.d.records.settle(target.id, m.sender, 'answered', now, m.id)
        pokes.add(row.recipient)
      }
      const refused = this.d.records.refusedRecords(projectId)
      const byCaller = new Map<string, MailRow[]>()
      for (const p of refused) byCaller.set(p.row.recipient, [...(byCaller.get(p.row.recipient) ?? []), p.message])
      for (const [caller, records] of byCaller) {
        const calls = records.flatMap((m) => (m.facts.refused ? [`${m.facts.refused.tool} to ${m.facts.refused.target} ("${m.facts.refused.firstLine}")`] : []))
        this.d.notice(caller, {
          kind: 'notice',
          body: trustedText(this.d.reach.projectLabel(projectId), calls),
          facts: { trusted: { project: projectId, refused: calls.slice(0, 10) } },
          dedupeKey: `trusted:${caller}:${projectId}:${now}`,
        })
        pokes.add(caller)
      }
      this.d.records.deleteRows(refused.map((p) => p.row))
      return [...pokes]
    })
  }

  /**
   * The person's Resume on a message an earlier build held `loop` (#2014): its rows are let go, marked `released` so a previous build still serving
   * during a host swap does not hold them again, and the question it answers is answered (D8). Returns the rows
   */
  resumeHeld(messageId: string): number {
    return this.d.run(() => {
      const m = this.d.records.message(messageId)
      const rows = m ? this.d.records.recipients(messageId).filter((r) => r.held === 'loop') : []
      // Let go as unread mail to deliver, also a row an older build told of quietly while it held it (§6.3), and never held again
      for (const r of rows) {
        this.d.records.letGo(r.recipient, [messageId])
        this.d.records.hold(r.recipient, [messageId], 'released')
      }
      if (m?.replyTo && rows.length > 0) this.d.records.settle(m.replyTo, m.sender, 'answered', this.d.now(), m.id)
      // The delivery hears of it (it goes now), and so does the Inbox (it is no longer held)
      if (m && rows.length > 0) this.d.changed(m, [...rows.map((r) => r.recipient), PERSON])
      return rows.length
    })
  }

  /**
   * What a host that died left half done (§7.6.5 of the old plan): a delivery whose attempt was written and whose acceptance was not. It is not sent
   * again on its own, since an inline task the tool took just before the host died would start the same work twice: it is held `uncertain`, for the
   * person to resend or dismiss. News and Centralu's own words go again, and their next frame says it may be a repeat
   */
  reconcileInterrupted(): { recipient: string; resent: number; held: number }[] {
    const byRecipient = new Map<string, string[]>()
    for (const r of this.d.records.interrupted()) byRecipient.set(r.recipient, [...(byRecipient.get(r.recipient) ?? []), r.messageId])
    return this.d.run(() => [...byRecipient].map(([recipient, ids]) => ({ recipient, ...this.settleUncertain(recipient, ids) })))
  }

  /** A wake the tool failed after the wait for it ran out: the rows it delivered at `deliveredAt` are undelivered again, and treated as a restart's */
  deliveryFailedLate(recipient: string, ids: readonly string[], deliveredAt: number): { resent: number; held: number } {
    return this.d.run(() => this.settleUncertain(recipient, this.d.records.undeliver(recipient, ids, deliveredAt)))
  }

  /**
   * The person says send it: mail held `uncertain` or `failed` goes now. Mail held for the project's trust has its own way out, and so does a
   * row an earlier build held `loop` (`HeldMail.resumeHeld`)
   */
  resendHeld(recipient: string, ids: readonly string[]): number {
    return this.d.run(() => {
      const released = this.heldBy(recipient, ids, ['uncertain', 'failed'])
      const n = this.d.records.release(recipient, released, this.d.now())
      // The delivery hears of it (it goes now), and so does the Inbox (it is no longer held)
      for (const id of released) {
        const m = this.d.records.message(id)
        if (m) this.d.changed(m, [recipient, PERSON])
      }
      return n
    })
  }

  /** The delivery held these rows for the person (the one hold): written, and the Inbox is told */
  hold(recipient: string, held: readonly { messageId: string; reason: string }[]): void {
    if (held.length === 0) return
    this.d.run(() => {
      for (const reason of new Set(held.map((h) => h.reason))) this.d.records.hold(recipient, held.filter((h) => h.reason === reason).map((h) => h.messageId), reason)
      for (const h of held) {
        const m = this.d.records.message(h.messageId)
        if (m) this.d.changed(m, [PERSON])
      }
    })
  }

  /**
   * The person says never: held mail is left undelivered, and not held against anyone. `uncertain` and `failed` by default; the person's window may
   * dismiss any hold it shows, and a dismissed answer leaves the question it answers open (D8)
   */
  dismissHeld(recipient: string, ids: readonly string[], why: readonly string[] = ['uncertain', 'failed']): number {
    return this.d.run(() => {
      const dismissed = this.heldBy(recipient, ids, why)
      for (const id of dismissed) this.d.records.answerDropped(id)
      const n = this.d.records.dismiss(recipient, dismissed)
      // Never delivered now, so nothing waits on it: its sender's wait for an answer or a report ends
      for (const id of dismissed) this.d.records.settle(id, recipient, 'withdrawn', this.d.now())
      for (const id of dismissed) {
        const m = this.d.records.message(id)
        if (m) this.d.changed(m, [PERSON])
      }
      return n
    })
  }

  /** Mail whose delivery may or may not have gone: news and Centralu's own words go again, the rest is held `uncertain` for the person */
  private settleUncertain(recipient: string, ids: readonly string[]): { resent: number; held: number } {
    const messages = ids.flatMap((id) => this.d.records.message(id) ?? [])
    const again = messages.filter((m) => m.kind === 'notice' || m.sender === CENTRALU).map((m) => m.id)
    const unsure = messages.filter((m) => !again.includes(m.id)).map((m) => m.id)
    if (again.length > 0) this.d.records.markMaybeRepeated(recipient, again, this.d.now())
    if (unsure.length > 0) this.d.records.markUncertain(recipient, unsure)
    // What goes again is the delivery's to look at; what is held, the Inbox's
    for (const m of messages) this.d.changed(m, again.includes(m.id) ? [recipient, PERSON] : [PERSON])
    return { resent: again.length, held: unsure.length }
  }

  /** The ids of those of `ids` that `recipient`'s rows hold for one of `why` */
  private heldBy(recipient: string, ids: readonly string[], why: readonly string[]): string[] {
    return ids.filter((id) => why.includes(this.d.records.recipient(id, recipient)?.held ?? ''))
  }
}
