import type { MailTurns } from './turns.js'

/**
 * Who asked for the orchestrator's turn (docs/plans/mailbox.md §9.7, #1447). A turn belongs to a thread (§6); when that thread is a session's
 * request, the session is the one asking, and the turn records it when it begins (`MailTurns`), so archiving the session or handing its
 * thread to the person does not change whose request the turn is. What the host knows of it is the record's, never anything the session
 * wrote: its name, its project's name and whether that project is trusted.
 */
export type Asker = {
  threadId: string
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
  /** A project of this host: its name and whether it is trusted */
  project(projectId: string): { name: string; trusted: boolean } | undefined
}

/** The facts the person decides on for a session: a session that is gone, or a project that is unknown or not trusted, is "not trusted" (fail closed) */
export function askerFacts(host: AskedByHost, sessionId: string): Pick<Asker, 'name' | 'project' | 'trusted'> {
  const session = host.session(sessionId)
  const project = session?.projectId ? host.project(session.projectId) : undefined
  return { name: session?.name ?? sessionId.slice(0, 8), project: project?.name ?? null, trusted: project?.trusted === true }
}

/** The session whose request the orchestrator's open turn is, or null when the turn is nobody's request (the person's, or no turn) */
export function askedBy(host: AskedByHost, turns: Pick<MailTurns, 'current' | 'numberOf'>, orchestratorId: string): Asker | null {
  const turn = turns.current(orchestratorId)
  const number = turns.numberOf(orchestratorId)
  if (!turn?.threadId || !turn.askedBy || number === undefined) return null
  return { threadId: turn.threadId, sessionId: turn.askedBy, turn: number, ...askerFacts(host, turn.askedBy) }
}
