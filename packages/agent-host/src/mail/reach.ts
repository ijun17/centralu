import type { MailRow } from '../dev-services/store/mailbox.js'
import { parseAddress, sessionAddress } from './address.js'
import { HOLD_UNTRUSTED_OUT, type MailRefusal } from './rules.js'

/*
 * Who may write to whom, which project is trusted, and the one hold (docs/plans/mailbox.md §7.1 to §7.4), in one module so each rule has one
 * definition. The host answers what it knows (`ReachHost`); nothing here is cached, so trust read at a check is trust now.
 */

export type RefusalReason = MailRefusal

/** What this module asks of the host. A session id is the id the manager knows it by; an address is `session:<host>/<id>` */
export type ReachHost = {
  /** This host's id: an address names the computer its session is on, and only the sessions of this one are looked up here */
  hostId: string
  /** A session: its project, the session that started it, whether it is here (not in the trash or deleted), whether its seat has the `mail` tool, and which computer. Undefined: never here */
  session(id: string): { projectId: string | null; askedBy: string | null; here: boolean; canReadMail: boolean; host: 'here' | 'elsewhere'; name?: string } | undefined
  /** The Assistant's session id, or null before it exists */
  assistantId(): string | null
  /** Whether the Assistant's tool can put each step of a request's turn to the person (§7.6): sessions may write requests to it only then */
  assistantAsks(): boolean
  appCalledBy(app: string, session: string): boolean
  /** A project of this host: whether it is trusted. Undefined: this host does not know it (a deleted project) */
  project(projectId: string): { trusted: boolean; name?: string } | undefined
  /** The session addresses of the group a session's requests to the Assistant are counted with, as `relations.ts` groups today */
  askGroupMembers(address: string): string[]
  /**
   * A session of another host this one reaches over a link (#2067 item 2): its name as last heard. Mail from it is taken as
   * from a session that is alive elsewhere; mail to it is the link's to carry, never written here. Undefined: not reached
   */
  foreign?(address: string): { name: string } | undefined
}

/** Where a delegation goes, as far as the hold goes: a session, a project (to create one in, or `ask_project`), the Assistant or a linked machine */
export type DelegationTarget = { sessionId?: string; projectId?: string | null; assistant?: boolean; linked?: boolean }

export type MailReach = {
  /**
   * Why `from` may not write to `to` (§7.1), or null. `asRequest` is false for a session's word to the Assistant that is no request (an answer to its own
   * `needsReply` message, a clarification): it needs no Assistant that can ask the person for each step
   */
  mayWrite(from: string, to: string, asRequest?: boolean): RefusalReason | null
  /** Whether the project is untrusted (§7.2): none is not, a project of this host is by its flag, one this host does not know is (fail closed) */
  untrusted(projectId: string | null): boolean
  /** `policy` (§7.4): the one hold; null when nothing holds. Mail is never held for how much of it there is (#2014) */
  holdFor(m: Pick<MailRow, 'kind' | 'senderProject'>, recipient: string): 'policy' | null
  /** The untrusted project a delegation by `callerId` to `target` leaves, or null (§7.4): the tool refuses it, S15 */
  refusesDelegation(callerId: string, target: DelegationTarget): string | null
  isAssistant(address: string): boolean
  askGroupMembers(address: string): string[]
  /** The project id of a session address, or null for a session of none or an address that is not a session here */
  projectOf(address: string): string | null
  /** The address of the session that started this one (`askedBy`), or null */
  parentOf(address: string): string | null
  /** Whether the address is a session this host knows on another computer (a child it started on a linked machine, #2067): alive there, out of mail's reach */
  elsewhere(address: string): boolean
  /** A session's name, or its address while the host gives none: the word a sentence to an agent uses for it */
  labelOf(address: string): string
  /** A project's name, or its id while the host gives none */
  projectLabel(projectId: string): string
}

export function mailReach(host: ReachHost): MailReach {
  const sessionOf = (address: string) => {
    const party = parseAddress(address)
    if (party?.kind !== 'session') return undefined
    if (party.host === host.hostId) return { id: party.sessionId, info: host.session(party.sessionId) }
    const far = host.foreign?.(address)
    return far ? { id: party.sessionId, info: { projectId: null, askedBy: null, here: true, canReadMail: false, host: 'elsewhere' as const, name: far.name } } : undefined
  }
  const untrusted = (projectId: string | null): boolean => (projectId === null ? false : !(host.project(projectId)?.trusted ?? false))
  /** The one test of leaving: an untrusted project's mail or work to a place that is not that project */
  const leaves = (senderProject: string | null, recipientProject: string | null): boolean => HOLD_UNTRUSTED_OUT && untrusted(senderProject) && recipientProject !== senderProject

  return {
    untrusted,
    isAssistant: (address) => {
      const s = sessionOf(address)
      return s !== undefined && host.assistantId() === s.id
    },
    askGroupMembers: (address) => host.askGroupMembers(address),
    projectOf: (address) => sessionOf(address)?.info?.projectId ?? null,
    parentOf: (address) => {
      const parent = sessionOf(address)?.info?.askedBy
      const party = parseAddress(address)
      return parent && party?.kind === 'session' ? sessionAddress(party.host, parent) : null
    },
    labelOf: (address) => sessionOf(address)?.info?.name ?? address,
    elsewhere: (address) => sessionOf(address)?.info?.host === 'elsewhere',
    projectLabel: (projectId) => host.project(projectId)?.name ?? projectId,

    mayWrite(from, to, asRequest = true) {
      const f = parseAddress(from)
      const t = parseAddress(to)
      if (!f || !t) return 'bad_address'
      // Nobody writes to Centralu, and apps take no mail yet
      if (t.kind === 'centralu' || t.kind === 'app') return 'not_allowed'
      if (t.kind === 'session' && t.host !== host.hostId) return 'elsewhere'
      const receiver = sessionOf(to)
      if (receiver) {
        if (!receiver.info?.here) return 'gone'
        if (receiver.info.host === 'elsewhere') return 'elsewhere'
        if (!receiver.info.canReadMail) return 'no_mailbox'
      }
      if (f.kind === 'centralu' || f.kind === 'person') return null
      // An app writes to a session that called it, and to nobody else yet
      if (f.kind === 'app') return receiver && host.appCalledBy(from, receiver.id) ? null : 'not_allowed'
      // From here on the sender is a session, which must still be here
      if (!sessionOf(from)?.info?.here) return 'gone'
      if (!receiver) return null
      const assistant = host.assistantId()
      return asRequest && receiver.id === assistant && f.sessionId !== assistant && !host.assistantAsks() ? 'assistant_asks' : null
    },

    holdFor(m, recipient) {
      if (m.kind !== 'message') return null
      const receiver = sessionOf(recipient)
      return receiver?.info && leaves(m.senderProject, receiver.info.projectId) ? 'policy' : null
    },

    refusesDelegation(callerId, target) {
      const project = host.session(callerId)?.projectId ?? null
      if (project === null) return null
      const targetProject = target.linked || target.assistant ? null : target.sessionId !== undefined ? (host.session(target.sessionId)?.projectId ?? null) : (target.projectId ?? null)
      return leaves(project, targetProject) ? project : null
    },
  }
}

/** S13: the person dismissed what a sender had waiting for a project to be trusted */
export function droppedText(ids: readonly string[], project: string): string {
  const shown = ids.slice(0, 10).join(', ') + (ids.length > 10 ? `, and ${ids.length - 10} more` : '')
  return `The person dismissed ${ids.length} of your messages that were waiting for project ${project} to be trusted (${shown}). They were not delivered and will not be.`
}

/** S16: the project is trusted, and these refused calls may be given again */
export function trustedText(project: string, calls: readonly string[]): string {
  return `${project} is trusted now. The calls refused for it can be given again: ${calls.slice(0, 10).join(', ')}${calls.length > 10 ? `, and ${calls.length - 10} more` : ''}`
}
