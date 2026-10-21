import { parseAddress } from './address.js'
import { COMMAND_CALLS, PLAIN_CALLS } from './frame.js'
import type { MailPolicy } from './service.js'

/**
 * Who may write to whom (docs/plans/mailbox.md §9.1): sessions along the relations they already have, the person, and apps
 * into the threads they are in or to a session that called them. This is the `MailPolicy` the host runs with. It is asked
 * when mail is posted and again when it is handed over (§7.5), so trust lost in between holds the mail.
 *
 * | From → to | Allowed when |
 * |---|---|
 * | Anyone → a party already in the thread | always: replies in it (an app and a member too) |
 * | The person, Centralu → a session | the session is here (not in the session archive) |
 * | Anyone → a session whose seat has no `mail` tool | never: a coordinator, a builder, an app's agent and a session outside a project cannot read it (`no_mailbox`). The orchestrator can: it runs `mail` as a command |
 * | A session → the person | always |
 * | A session → a session it started (`askedBy`) | always |
 * | A session → the session that started it | replies in the thread they share (§9.1); never a new thread |
 * | The orchestrator → any session | always (`send_to_session` today) |
 * | A coordinator → a member of its scope | always |
 * | An app → a session | the session called the app (the signed caller address, §9.4) |
 * | Anything → an app | not yet: apps take mail from slice 7 |
 * | Any other session → a session | no: the orchestrator is the way, or `ask_project` (slice 3) |
 *
 * An ordinary session cannot open a thread with the orchestrator (§1.2, question 2): it writes to the person.
 */
export type RelationsHost = {
  /** The relations of a session that is here, or undefined for one that is gone or in the session archive */
  session(id: string): { kind: 'worker' | 'orchestrator' | 'coordinator'; askedBy?: string | null; scopeSessionIds?: readonly string[] | null } | undefined
  /** Whether the session's seat has the `mail` tool (`toolProfileOf` is `reader` or `orchestrator`): the seats that can read what a wake points at */
  mailTool(sessionId: string): boolean
  /** Whether the session reaches `mail` as a command behind `centralu_run` (the orchestrator), so the calls it is told of are `centralu_run`'s */
  mailCommand?(sessionId: string): boolean
  /** Whether the session called the app. Nothing records that before the apps' mail API (slices 5 and 7), so nobody did */
  appCalledBy?(appAddress: string, sessionId: string): boolean
  /** Whether a party is in the thread, so that a reply needs no relation. The service passes the thread itself; this reads its participants */
  inThread(threadId: string, address: string): boolean
}

export function mailRelations(host: RelationsHost): MailPolicy {
  return {
    calls(to) {
      const t = parseAddress(to)
      return t?.kind === 'session' && host.mailCommand?.(t.sessionId) ? COMMAND_CALLS : PLAIN_CALLS
    },
    cannotRead(to) {
      const t = parseAddress(to)
      if (t?.kind !== 'session' || !host.session(t.sessionId)) return null
      return host.mailTool(t.sessionId) ? null : 'that session cannot read mail: only an ordinary session in a project, or the orchestrator, has the mail tool'
    },
    mayWrite(from, to, thread) {
      const f = parseAddress(from)
      const t = parseAddress(to)
      if (!f || !t) return 'that is not an address'
      if (t.kind === 'centralu') return 'Centralu only sends'
      // A session that is gone takes no new mail (§7.1), also in a thread it was in
      if (t.kind === 'session' && !host.session(t.sessionId)) return 'that session is gone: it is in the session archive or deleted'
      if (thread && host.inThread(thread.id, to)) return null
      if (t.kind === 'app') return 'apps take no mail yet'
      if (f.kind === 'centralu' || f.kind === 'person') return null
      if (t.kind === 'person') return f.kind === 'session' ? null : 'an app writes to the person inside a thread it is in'
      // From here on the receiver is a session
      if (f.kind === 'app') return host.appCalledBy?.(from, t.sessionId) ? null : 'an app writes to a session that called it'
      const sender = host.session(f.sessionId)
      const receiver = host.session(t.sessionId)
      if (!sender || !receiver) return 'that session is gone: it is in the session archive or deleted'
      if (sender.kind === 'orchestrator') return null
      if (sender.kind === 'coordinator' && sender.scopeSessionIds?.includes(t.sessionId)) return null
      if (receiver.askedBy === f.sessionId) return null
      return 'a session writes to the sessions it started, to the person, and replies in a thread it shares with another; the orchestrator is the way to another'
    },
  }
}
