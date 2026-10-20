/**
 * A party's name in mail (docs/plans/mailbox.md §2 and §11.4).
 *
 *   session:<hostId>/<sessionId>          a session; the host id is the id of the host the session lives on
 *   app:<hostId>/<projectId>/<appId>      an app of a project
 *   person                                the person; one per host, and mail to them never crosses a link
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
const SEGMENT_RE = new RegExp(`^${SEGMENT}$`)
const SESSION_RE = new RegExp(`^session:(${SEGMENT})/(${SEGMENT})$`)
const APP_RE = new RegExp(`^app:(${SEGMENT})/(${SEGMENT})/(${SEGMENT})$`)

export const PERSON = 'person'
export const CENTRALU = 'centralu'

export type Party =
  | { kind: 'session'; host: string; sessionId: string }
  | { kind: 'app'; host: string; projectId: string; appId: string }
  | { kind: 'person' }
  | { kind: 'centralu' }

export function isAddressSegment(value: string): boolean {
  return SEGMENT_RE.test(value)
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

/** The host an address lives on, or null for the person and Centralu, who are this host's own */
export function hostOf(party: Party): string | null {
  return party.kind === 'session' || party.kind === 'app' ? party.host : null
}

function checked(address: string): string {
  if (!parseAddress(address)) throw new Error(`Not a mail address: ${JSON.stringify(address)}`)
  return address
}
