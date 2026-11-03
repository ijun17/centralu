import { parseAddress } from './address.js'
import type { MailReach } from './reach.js'
import type { MailTurns } from './turns.js'

/**
 * Who asked for the orchestrator's turn (docs/plans/mailbox.md §7.6, #1447). A turn begins from its work message; when that message is a session's
 * request, the session is the one asking, and the turn records it when it begins (`MailTurns`), so archiving the session does not change whose
 * request the turn is. What the host knows of it is the record's, never anything the session wrote: its name, its project's name and whether that
 * project is trusted.
 */
export type Asker = {
  /** The request the turn is for: the mail tool's `thread`/`id` that answers it in that turn needs no card */
  messageId: string
  /** The asking session, and the number of the turn: what a turn has read is that turn's (`AskedGate`) */
  sessionId: string
  turn: number
  name: string
  project: string | null
  trusted: boolean
}

export type AskedByHost = {
  /** A session of this host, as far as asking goes: its name and its project, or none when it is gone */
  session(sessionId: string): { name: string; projectId: string | null } | undefined
  /** A project of this host: its name (trust is `reach.untrusted`, the one rule, §7.2) */
  project(projectId: string): { name: string } | undefined
  /** §7.2's rule: no project is trusted, a known project reads its flag, an unknown id is not */
  untrusted: MailReach['untrusted']
}

/** The facts the person decides on for a session; a gone session's project is unknown, so it is not trusted (fail closed) */
export function askerFacts(host: AskedByHost, sessionId: string): Pick<Asker, 'name' | 'project' | 'trusted'> {
  const session = host.session(sessionId)
  const projectId = session ? session.projectId : 'gone'
  const project = projectId ? host.project(projectId) : undefined
  return { name: session?.name ?? sessionId.slice(0, 8), project: project?.name ?? null, trusted: !host.untrusted(projectId) }
}

/** The session whose request the orchestrator's open turn is, or null when the turn is nobody's request (the person's, or no turn) */
export function askedBy(host: AskedByHost, turns: Pick<MailTurns, 'current'>, orchestratorId: string): Asker | null {
  const turn = turns.current(orchestratorId)
  const asker = turn?.asker ? parseAddress(turn.asker) : undefined
  if (!turn?.messageId || asker?.kind !== 'session') return null
  return { messageId: turn.messageId, sessionId: asker.sessionId, turn: turn.turnSeq, ...askerFacts(host, asker.sessionId) }
}
