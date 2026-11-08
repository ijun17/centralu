import type { SessionInfo } from '@cc/protocol'
import type { Store } from '../dev-services/store.js'
import { liveHeirOf } from './handoff-heirs.js'
import { plainQuoted } from './tool-answers.js'

/**
 * What to add to a "not a session" refusal when the id is not a live session (a caller kept it in memory past a deletion or a
 * handoff): was it deleted (the archive keeps the row), which live session took over from it by a handoff (the same generation
 * walk as the delete's, `liveHeirOf`), and which live sessions of the same project now carry its name, so the caller can retry
 * at once. Only names the candidates; nothing is ever done to one for the caller. Every tool that takes a session id to send to
 * or read goes through this (assistant-seat's scope and read errors, agent_session's). Names are another session's text, so
 * they are quoted as plain text.
 */
export function staleSessionHint(
  host: { store: Store; meta: ReadonlyMap<string, SessionInfo> },
  id: string,
  /** The sessions this caller may name: the ones its tools would accept */
  visible: (s: SessionInfo) => boolean,
  /** The caller sees every project (the Assistant, which lists the archive anyway); else only those of the sessions it can name */
  seesAll = false,
  /** What the caller was doing, for the closing sentence */
  doing: 'send' | 'read' | 'act' = 'act',
): string {
  // A live session that is out of this caller's view is not a stale id: say nothing that would tell it more
  if (host.meta.has(id)) return ''
  const live = [...host.meta.values()].filter((s) => s.kind !== 'orchestrator' && visible(s))
  // An archived session of a project the caller cannot see is refused as a missing one: its name is not for it
  const found = host.store.trash.trashedSession(id)
  const trashed = found && (seesAll || live.some((s) => s.projectId === found.record.projectId)) ? found : null
  const heirId = liveHeirOf(host.store, id, (h) => {
    const s = host.meta.get(h)
    return !!s && s.kind !== 'orchestrator' && visible(s)
  })
  const heir = heirId ? host.meta.get(heirId) : undefined
  // Not in the archive and no heir: nothing is known of the id, so nothing is added
  if (!trashed && !heir) return ''
  const named = trashed ? live.filter((s) => s.name === trashed.session.name && s.projectId === trashed.record.projectId && s !== heir) : []
  const label = (s: SessionInfo) => `${plainQuoted(s.name, 80)} (id ${s.id})`
  const parts: string[] = []
  if (trashed) parts.push(`That id was the session ${plainQuoted(trashed.session.name, 80)}, deleted since (it is in the archive).`)
  else parts.push('That id was a session that has been replaced by a handoff.')
  if (heir) parts.push(`The live session that took over from it: ${label(heir)}.`)
  if (named.length) parts.push(`Live in the same project with the same name: ${named.map(label).join(', ')}.`)
  const then =
    doing === 'send' ? 'Nothing was sent; send to the one you meant, by its id.'
    : doing === 'read' ? 'Nothing was read; read the one you meant, by its id.'
    : 'Nothing was done; retry the same call with the id of the live session you meant.'
  parts.push(heir || named.length ? then : 'No live session carries its name; list the sessions to find the one you meant.')
  return ' ' + parts.join(' ')
}
