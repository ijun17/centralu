/**
 * A party's name in mail (docs/plans/mailbox.md §4, §5.1).
 *
 *   session:<hostId>/<sessionId>          a session; the host id is the id of the host the session lives on
 *   app:<hostId>/<projectId>/<appId>      an app of a project
 *   person                                the person
 *   centralu                              Centralu itself: a sender only
 *
 * **Absolute from the first step.** The design (§2) writes `session:<id>` and `app:<projectId>/<appId>`, and §11.4 says
 * that across machines an address carries the host's id and that "v1 writes these shapes from its first step, so the
 * local build never needs its ids rewritten". The two disagree for a local build; this follows §11.4, so a message
 * stored today is still right when mail crosses a link (slice 4). The window's hub-relative `<machine>.<id>` is
 * translated at the edge, not stored.
 */

/**
 * One piece of an address: no separator (`/` or `:`), no space, never empty, at most 64 characters (an app's id is its author's,
 * and goes into the wake frame as it is)
 */
const SEGMENT = '[A-Za-z0-9][A-Za-z0-9._~-]{0,63}'
const SESSION_RE = new RegExp(`^session:(${SEGMENT})/(${SEGMENT})$`)
const APP_RE = new RegExp(`^app:(${SEGMENT})/(${SEGMENT})/(${SEGMENT})$`)

export const PERSON = 'person'
export const CENTRALU = 'centralu'

export type Party =
  | { kind: 'session'; host: string; sessionId: string }
  | { kind: 'app'; host: string; projectId: string; appId: string }
  | { kind: 'person' }
  | { kind: 'centralu' }

/**
 * The person of a hub, as a machine it links names them (#1987): the person works in the hub's window, so a machine's session that
 * writes to the person while a hub links it writes to the hub's person, under this address. No session's id is `person` (a host makes its
 * sessions' ids, never that word, and a linked machine's have a dot), so the address names no session. A reply from there is the person's own word,
 * and only a hub that links this host writes from it (`MailReach.mayWrite`), so a stored sender of this form is always one
 */
export const PERSON_ID = 'person'

/** Whether `address` is the person: this host's, or a hub's as a machine names them (`PERSON_ID`) */
export function isPerson(address: string): boolean {
  if (address === PERSON) return true
  const p = parseAddress(address)
  return p?.kind === 'session' && p.sessionId === PERSON_ID
}

/** What kind of party writes from `address`, as the mail's rules read it: the person under either name (`isPerson`), else its address's kind */
export function senderKind(address: string): Party['kind'] | undefined {
  return isPerson(address) ? 'person' : parseAddress(address)?.kind
}

const SESSION_ID_RE = new RegExp(`^${SEGMENT}$`)

/**
 * Whether `id` can name a session in an address (#2290). A message's sender id that cannot names no session: a hub's Assistant's (`isHubSender`)
 * and Centralu's own notices are recorded under ids that start with `_`, which no host makes
 */
export function isSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id)
}

export function sessionAddress(host: string, sessionId: string): string {
  return checked(`session:${host}/${sessionId}`)
}

export function appAddress(host: string, projectId: string, appId: string): string {
  return checked(`app:${host}/${projectId}/${appId}`)
}

/** The party an address names, or null for text that is not an address */
export function parseAddress(address: string): Party | null {
  if (address === PERSON) return { kind: 'person' }
  if (address === CENTRALU) return { kind: 'centralu' }
  const [, host, sessionId] = SESSION_RE.exec(address) ?? []
  if (host !== undefined && sessionId !== undefined) return { kind: 'session', host, sessionId }
  const [, appHost, projectId, appId] = APP_RE.exec(address) ?? []
  if (appHost !== undefined && projectId !== undefined && appId !== undefined) return { kind: 'app', host: appHost, projectId, appId }
  return null
}

/**
 * An address a machine holds, as the hub `hub` names it (docs/plans/linked-mail.md §6): the hub's person is its `person`, and a session of the
 * machine (`machine.host` its id in mail, `machine.id` its id at that hub) is `session:<hub>/<machine id>.<id>`. What is on the hub's side already,
 * or on any other host, stays as it is
 */
export function inHubTerms(address: string, hub: string, machine?: { host: string; id: string }): string {
  if (address === sessionAddress(hub, PERSON_ID)) return PERSON
  const p = parseAddress(address)
  return machine && p?.kind === 'session' && p.host === machine.host && !p.sessionId.includes('.') ? sessionAddress(hub, `${machine.id}.${p.sessionId}`) : address
}

function checked(address: string): string {
  if (!parseAddress(address)) throw new Error(`Not a mail address: ${JSON.stringify(address)}`)
  return address
}
