import type { MailReach } from './reach.js'

/** Who a session asking the orchestrator is, as the person decides on it: the host's record, never anything the session wrote */
export type AskerParty = {
  sessionId: string
  name: string
  project: string | null
  trusted: boolean
}

/**
 * Who asked for the orchestrator's turn (docs/plans/mailbox.md §7.6, #1447; docs/plans/turn-owned-by-no-one.md §4.2). The turn is a session's
 * request when a request of that session was delivered into it: read from the store's rows of the turn, settled or not, so archiving the session,
 * answering the request mid-turn, a restart or a host swap does not change whose request the turn is. What the host knows of it is the record's,
 * never anything the session wrote: its name, its project's name and whether that project is trusted.
 */
export type Asker = AskerParty & {
  /** The asker's oldest request in the turn: the mail tool's `thread`/`id` that answers it in that turn needs no card */
  messageId: string
  /** The number of the turn: what a turn has read is that turn's (`AskedGate`) */
  turn: number
  /** The person's message the request cites, which Centralu checked when it was sent (docs/plans/cited-requests.md), or null: the turn is not on their word */
  cites: { seq: number; at: number } | null
  /**
   * Other sessions with a request in the same turn. The drain gives the orchestrator one asker's requests a turn and never lets a request join a
   * running turn, so there are none; if there ever were, the gate fails closed: every step but a read asks, and the card names every asker
   */
  also?: readonly AskerParty[]
}

export type AskedByHost = {
  /** A session of this host, as far as asking goes: its name and its project, or none when it is gone */
  session(sessionId: string): { name: string; projectId: string | null } | undefined
  /** A project of this host: its name (trust is `reach.untrusted`, the one rule, §7.2) */
  project(projectId: string): { name: string } | undefined
  /** §7.2's rule: no project is trusted, a known project reads its flag, an unknown id is not */
  untrusted: MailReach['untrusted']
  /** The checked citation a message carries (`facts.cites`), or null */
  cites(messageId: string): { seq: number; at: number } | null
  /** The sessions with a request in the orchestrator's open turn, oldest first, each with its oldest request there (`MessageService.requestsIn`); null outside a turn */
  requestsInTurn(orchestratorId: string): { turnSeq: number; requests: { sessionId: string; messageId: string }[] } | null
}

/** The facts the person decides on for a session; a gone session's project is unknown, so it is not trusted (fail closed) */
export function askerFacts(host: AskedByHost, sessionId: string): Pick<Asker, 'name' | 'project' | 'trusted'> {
  const session = host.session(sessionId)
  const projectId = session ? session.projectId : 'gone'
  const project = projectId ? host.project(projectId) : undefined
  return { name: session?.name ?? sessionId.slice(0, 8), project: project?.name ?? null, trusted: !host.untrusted(projectId) }
}

/** The session whose request the orchestrator's open turn is, or null when no request is in it (the person's own turn, or no turn) */
export function askedBy(host: AskedByHost, orchestratorId: string): Asker | null {
  const inTurn = host.requestsInTurn(orchestratorId)
  const [first, ...rest] = inTurn?.requests ?? []
  if (!inTurn || !first) return null
  return {
    messageId: first.messageId,
    sessionId: first.sessionId,
    turn: inTurn.turnSeq,
    ...askerFacts(host, first.sessionId),
    cites: host.cites(first.messageId),
    ...(rest.length > 0 ? { also: rest.map((r) => ({ sessionId: r.sessionId, ...askerFacts(host, r.sessionId) })) } : {}),
  }
}
