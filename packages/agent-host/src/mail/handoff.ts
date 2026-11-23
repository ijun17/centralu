/**
 * A party that goes and one that takes over (docs/plans/mailbox.md §7.7, §10.6.5): a handoff's one move of the original's mail and of the tasks it gave
 * the children that move, the Assistant's role moving, and on a machine a hub's handoff of what it sent there (`MessageService.handoffs`). Each runs in
 * the service's transaction (`run`), since what it writes is told to the listeners only once that commits
 */
import type { HandOverScope, MailFacts, MailKind, MailRow, MailboxRecords, NewMail, NewRecipient, StoredMail } from '../dev-services/store/mailbox.js'
import { parseAddress } from './address.js'
import type { MailReach } from './reach.js'
import { firstLineOf, hash16 } from './rules.js'

export type HandedOverMessage = { messageId: string; firstLine: string; kind: MailKind; unread: boolean; /** The session (its address) a Centralu message is about: a report's child */ about?: string }

/** What it writes with: the service's records, reach, clock and transaction, its writers of messages and rows, and how it names a party */
type HandoffDeps = {
  records: MailboxRecords
  reach: Pick<MailReach, 'parentOf' | 'projectOf'>
  now: () => number
  run: <T>(fn: () => T) => T
  put: (mail: Partial<NewMail> & Pick<NewMail, 'sender' | 'kind' | 'body' | 'origin'>, rows: NewRecipient[]) => StoredMail
  row: (recipient: string, over: Partial<NewRecipient> & Pick<NewRecipient, 'dueAt'>) => NewRecipient
  notice: (recipient: string, input: { body: string; facts: MailFacts; dedupeKey: string }) => unknown
  centralu: (recipient: string, m: { kind: MailKind; body: string; facts: MailFacts; dedupeKey: string }) => unknown
  labelOf: (address: string) => string
  shownId: (address: string) => string
  /** Whether an address is a session on another computer (`MessageService.across`) */
  across: (address: string) => boolean
}

export class Handoffs {
  /** Tasks across a link a handoff re-pointed, for `takeMoves` */
  private readonly queuedMoves: { from: string; to: string; ids: string[] }[] = []

  constructor(private readonly d: HandoffDeps) {}

  /**
   * The handoff (§7.7, §10.6.5), its one move: `from`'s unsettled watched rows and unread mail move to `to`, and the tasks `from` gave the sessions that
   * move (`children`) become `to`'s; the successor is told of each message. Called inside the children's move
   */
  handOver(from: string, to: string, scope: HandOverScope, children: readonly string[] = scope === 'all' ? [] : scope.senders): HandedOverMessage[] {
    return this.d.run(() => {
      const plan = this.handOverPreview(from, to, scope)
      // The heir is told of what comes to it, not of a row it already had
      const fresh = plan.filter((p) => this.d.records.recipient(p.messageId, to) === undefined)
      this.d.records.moveRows(from, to, scope)
      /*
       * Each task `from` gave a child that is not settled is withdrawn and goes again from `to` with the same words, cause and delivery (#1936): the child's
       * reply or last response answers `to`, and a task `to` took over that the work was handed on from waits for that answer (`handedOn`). Its words
       * are `from`'s, not `to`'s: fact `handedOver` says so, and keeps an heir that is the Assistant from passing them off as the person's (`forPersonOf`)
       */
      const across: string[] = []
      for (const row of this.d.records.watchedFrom(from)) {
        const m = children.includes(row.recipient) ? this.d.records.message(row.messageId) : undefined
        if (m?.kind !== 'task') continue
        /*
         * A task across a link (#1948 step 6) keeps its one id on both sides: the child's turn there is that task's, and a task sent again would leave its
         * answer to a withdrawn one. It is the heir's here at once (the report that comes back is written to its sender), and the machine is told (`movedAcross`)
         */
        if (this.d.across(row.recipient)) {
          this.d.records.repoint(m.id, to, this.d.reach.projectOf(to), { ...m.facts, handedOver: true })
          across.push(m.id)
          continue
        }
        this.d.records.settle(m.id, row.recipient, 'withdrawn', this.d.now())
        const again = this.d.put({ sender: to, kind: 'task', body: m.body, causeId: m.causeId, origin: m.origin, facts: { ...m.facts, handedOver: true } }, [this.d.row(row.recipient, { dueAt: row.dueAt, deliveredAt: row.deliveredAt, readAt: row.readAt })])
        // A task a stop released stays released: its sender was told, and no one is owed it twice
        if (row.releasedAt !== null && row.releasedWhy !== null) this.d.records.markReleased(again.id, row.recipient, row.releasedAt, row.releasedWhy)
      }
      /*
       * A child `from` started that moved is told by Centralu who its parent is now (#2474): its conversation names the session that started it, and
       * without this it took the heir's work as a stranger's. Not one `from` only gave work to, or one across a link (no starter here). Quiet, so it
       * comes with the heir's first mail rather than as a turn of its own. Keyed by the time too: a later handoff back to `to` is news again
       */
      const name = (address: string) => `“${this.d.labelOf(address)}” [${this.d.shownId(address)}]`
      for (const child of children) {
        if (this.d.reach.parentOf(child) !== from) continue
        const body = `[Centralu] ${name(from)}, which started you, handed over to ${name(to)}: that session is your parent now, and its work and mail for you are your parent's.`
        this.d.notice(child, { body, facts: { quiet: true }, dedupeKey: `parent:${child}:${to}:${this.d.now()}` })
      }
      this.movedNotice(to, fresh.map((p) => p.messageId), this.foldReports(to, fresh.map((p) => p.messageId)))
      // The start_agent task that started a child across a link names its parent there (`ReachHost.starterElsewhere`, #2520): it moves with the child once reported too
      for (const child of children.filter((c) => this.d.across(c))) {
        const first = this.d.records.firstTask(child, 'start_agent')
        if (first?.sender !== from || across.includes(first.id)) continue
        this.d.records.repoint(first.id, to, this.d.reach.projectOf(to), { ...first.facts, handedOver: true })
        across.push(first.id)
      }
      // What a session across a link wrote `from` and moved here: its host checks a reply against its own copy's rows, so they move there too (#2530)
      for (const p of plan) if (this.d.across(this.d.records.message(p.messageId)?.sender ?? '')) across.push(p.messageId)
      if (across.length) this.queuedMoves.push({ from, to, ids: across })
      return plan
    })
  }

  /**
   * On a machine: a hub's handoff gave the tasks it sent here (`ids`) from its session `from` to its session `to` (`host.mailMove`, #1948 step 6). Only an
   * open task of this host's that `from` sent is moved, and its start_agent task, settled or not, which names a session's parent here (#2520); it keeps its rows, its delivery and the turn it runs in, and reads as handed over (fact
   * `handedOver`), so an heir's words never pass for the Assistant's. A message a session here sent `from` that the hub moved gives its row to `to`
   * (#2530), so the heir's reply answers one it may read. The caller checks that both are that hub's. Returns how many moved
   */
  moveAcross(from: string, to: string, ids: readonly string[]): number {
    return this.d.run(() => {
      let moved = 0
      for (const id of new Set(ids)) {
        const m = this.d.records.message(id)
        if (m && m.sender !== from && parseAddress(m.sender)?.kind === 'session' && !this.d.across(m.sender)) {
          moved += this.d.records.moveRows(from, to, 'all', [id]).length
          continue
        }
        if (!m || m.sender !== from || (m.kind !== 'task' && m.kind !== 'message')) continue
        if (m.origin !== 'start_agent' && !this.d.records.recipients(id).some((r) => r.settled === null)) continue
        this.d.records.repoint(id, to, null, { ...m.facts, handedOver: true })
        moved++
      }
      return moved
    })
  }

  /** The handoffs that moved tasks across a link, for the links to tell the machines (`MailAcross.movedAcross`); taken once */
  takeMoves(): { from: string; to: string; ids: string[] }[] {
    return this.queuedMoves.splice(0)
  }

  /** What `handOver` would move, read only: each message by id and the first line of its words, for the handoff note to quote */
  handOverPreview(from: string, to: string, scope: HandOverScope = 'all'): HandedOverMessage[] {
    return this.d.records.movable(from, to, scope).flatMap((id) => {
      const m = this.d.records.message(id)
      return m ? [{ messageId: id, firstLine: firstLineOf(m.body, 160), kind: m.kind, unread: this.d.records.recipient(id, from)?.readAt === null, ...(m.facts.about ? { about: m.facts.about.session } : {}) }] : []
    })
  }

  /** The Assistant's role is `to`'s (D15): rows sent to the role that another session held are delivered afresh, read or not, and the new Assistant is told of each. Returns how many */
  roleMoved(to: string): number {
    return this.d.run(() => {
      const ids = this.d.records.moveRole(to)
      this.movedNotice(to, ids)
      return ids.length
    })
  }

  /**
   * Of the reports among `ids` just moved to `to` (Centralu's, and unread: only a watched row moves read, and a report is not watched), each that a
   * newer one on the same session follows is marked read (#2474): a handoff moves one report per turn ended, days of them, and the newest says how
   * that session stands. The notice names the others, which may each carry a task's answer, so the heir reads one by its id. Returns their ids
   */
  private foldReports(to: string, ids: readonly string[]): string[] {
    const reports = ids.flatMap((id) => {
      const m = this.d.records.message(id)
      const session = m?.kind === 'report' ? m.facts.about?.session : undefined
      return m && session ? [{ m, session }] : []
    })
    const newest = new Map<string, MailRow>()
    for (const { m, session } of reports) {
      const kept = newest.get(session)
      if (!kept || m.createdAt > kept.createdAt || (m.createdAt === kept.createdAt && m.id > kept.id)) newest.set(session, m)
    }
    const folded = reports.filter(({ m, session }) => newest.get(session) !== m).map(({ m }) => m.id)
    if (folded.length > 0) this.d.records.markRead(to, folded, this.d.now())
    return folded
  }

  /** Rows came to `to` from another holder (a handoff, the role's move): one quiet notice for the move, so it knows why the messages are there (key `handover:`) */
  private movedNotice(to: string, messageIds: readonly string[], folded: readonly string[] = []): void {
    if (messageIds.length === 0 || parseAddress(to)?.kind !== 'session') return
    const moved = messageIds.length === 1 ? 'A message addressed to the previous holder was moved to you.' : `${messageIds.length} messages addressed to the previous holder were moved to you.`
    this.d.centralu(to, {
      kind: 'notice',
      body: folded.length === 0 ? moved : `${moved} Marked read, since a newer report on the same session follows: ${folded.map((id) => `[${id}]`).join(' ')}. The newest report on each session says how it stands; read an older one by its id for its answer.`,
      facts: { quiet: true, handedOver: true },
      dedupeKey: `handover:${to}:${hash16(messageIds)}`,
    })
  }
}
