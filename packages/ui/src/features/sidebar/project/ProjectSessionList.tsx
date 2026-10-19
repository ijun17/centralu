import type { Dispatch, SetStateAction } from 'react'
import type { SessionSummary } from '@cc/core'
import { treeRows, type ProjectAppSessions } from '../tree.js'
import { childrenGroupKey } from '../../../store/foldGroups.js'
import { useStore } from '../../../store/store.js'
import { useSelectedSessionId } from '../../../store/selectors.js'
import { ProjectSessionRow } from './ProjectSessionRow.jsx'

export function ProjectSessionList({
  projectId,
  sessions,
  groupedSessions,
  renaming,
  setRenaming,
  sessionMenu,
  setSessionMenu,
  setHandingOff,
  setConfirming,
}: {
  projectId: string
  sessions: SessionSummary[]
  groupedSessions: ProjectAppSessions
  renaming: string | null
  setRenaming: (id: string | null) => void
  sessionMenu: { id: string; el: HTMLElement } | null
  setSessionMenu: Dispatch<SetStateAction<{ id: string; el: HTMLElement } | null>>
  setHandingOff: (id: string | null) => void
  setConfirming: (id: string | null) => void
}) {
  const focusedSessionId = useSelectedSessionId()
  // Folded groups (#666): the children of a session. `foldedGroups` is one array, so this re-renders only when it changes
  const foldedGroups = useStore((s) => s.prefs.foldedGroups)
  const rows = treeRows(groupedSessions.project, (id) => foldedGroups.includes(childrenGroupKey(id)))
  if (rows.length === 0) return null
  return (
    <ul>
      {rows.map((row) => (
        <ProjectSessionRow
          key={row.s.id}
          row={row}
          projectId={projectId}
          sessions={sessions}
          byApp={groupedSessions.byApp}
          focusedSessionId={focusedSessionId}
          renaming={renaming}
          setRenaming={setRenaming}
          sessionMenu={sessionMenu}
          setSessionMenu={setSessionMenu}
          setHandingOff={setHandingOff}
          setConfirming={setConfirming}
        />
      ))}
    </ul>
  )
}
