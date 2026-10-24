import type { MailRecords } from '../dev-services/store/mail.js'
import { parseAddress, sessionAddress } from './address.js'
import type { MailTurns } from './turns.js'

/**
 * Who asked for the orchestrator's turn (docs/plans/mailbox.md §9.7, #1447). A turn belongs to a thread (§6); when that thread is a session's
 * request (a session owns it and the orchestrator is its assignee), the session is the one asking. What the host knows of it is the
 * record's, never anything the session wrote: its name, its project's name and whether that project is trusted.
 */
export type Asker = { threadId: string; name: string; project: string | null; trusted: boolean }

export type AskedByHost = {
  hostId: () => string
  /** A session of this host, as far as asking goes: its name and its project, or none when it is gone */
  session(sessionId: string): { name: string; projectId: string | null } | undefined
  /** A project of this host: its name and whether it is trusted */
  project(projectId: string): { name: string; trusted: boolean } | undefined
}

/** The facts the person decides on for a session: a project that is unknown or not trusted is "not trusted" (fail closed) */
export function askerFacts(host: AskedByHost, sessionId: string): Omit<Asker, 'threadId'> {
  const session = host.session(sessionId)
  const project = session?.projectId ? host.project(session.projectId) : undefined
  return { name: session?.name ?? sessionId.slice(0, 8), project: project?.name ?? null, trusted: project?.trusted === true }
}

/** The session whose request the orchestrator's open turn is, or null when the turn is nobody's request (the person's, or no turn) */
export function askedBy(host: AskedByHost, turns: Pick<MailTurns, 'current'>, records: Pick<MailRecords, 'thread'>, orchestratorId: string): Asker | null {
  const turn = turns.current(orchestratorId)
  if (!turn?.threadId) return null
  const thread = records.thread(turn.threadId)
  if (!thread || thread.assignee !== sessionAddress(host.hostId(), orchestratorId)) return null
  const owner = parseAddress(thread.owner)
  return owner?.kind === 'session' ? { threadId: thread.id, ...askerFacts(host, owner.sessionId) } : null
}
