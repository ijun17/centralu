import type { SessionInfo } from '@cc/protocol'
import type { Store } from '../dev-services/store.js'

/**
 * What to add to a "not a session" refusal when the id is not a live session (a caller kept it in memory past a deletion or a
 * handoff): was it deleted (the archive keeps the row), and which live session of the same project now carries its name, so
 * the caller can resend at once. Only names the candidates; nothing is ever sent to one for the caller. Every tool that takes
 * a session id to send to or read goes through this (orchestrator-seat's scope and read errors, agent_session's).
 */
export function staleSessionHint(
  host: { store: Store; meta: ReadonlyMap<string, SessionInfo> },
  id: string,
  /** The sessions this caller may name: the ones its tools would accept */
  visible: (s: SessionInfo) => boolean,
  /** The caller sees every project (the central orchestrator, which lists the archive anyway); else only those of the sessions it can name */
  seesAll = false,
): string {
  // A live session that is out of this caller's view is not a stale id: say nothing that would tell it more
  if (host.meta.has(id)) return ''
  const live = [...host.meta.values()].filter((s) => s.kind !== 'orchestrator' && visible(s))
  // An archived session of a project the caller cannot see is refused as a missing one: its name is not for it
  const found = host.store.trash.trashedSession(id)
  const trashed = found && (seesAll || live.some((s) => s.projectId === found.record.projectId)) ? found : null
  const heirs = host.store.handoffs.handoffHeirs(id).filter((h) => !h.trashed).map((h) => host.meta.get(h.sessionId)).filter((s): s is SessionInfo => !!s && visible(s))
  const named = trashed
    ? live.filter((s) => s.name === trashed.session.name && s.projectId === trashed.record.projectId && !heirs.includes(s))
    : []
  const label = (s: SessionInfo) => `"${s.name}" (id ${s.id})`
  // Not in the archive and no heir: nothing is known of the id, so nothing is added
  if (!trashed && !heirs.length) return ''
  const parts: string[] = []
  if (trashed) parts.push(`That id was the session "${trashed.session.name}", deleted since (it is in the archive).`)
  else parts.push('That id was a session that has been replaced by a handoff.')
  if (heirs.length) parts.push(`Taken over by: ${heirs.map(label).join(', ')}.`)
  if (named.length) parts.push(`Live in the same project with the same name: ${named.map(label).join(', ')}.`)
  if (heirs.length + named.length) parts.push('Nothing was sent; resend to the one you meant, by its id.')
  else parts.push('No live session carries its name; list the sessions to find the one you meant.')
  return ' ' + parts.join(' ')
}
