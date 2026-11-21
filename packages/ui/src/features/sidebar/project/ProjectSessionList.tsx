import { useCallback, useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { SessionSummary } from '@cc/core'
import { treeRows, type ProjectAppSessions } from '../tree.js'
import { childrenGroupKey } from '../../../store/foldGroups.js'
import { useStore } from '../../../store/store.js'
import { useSelectedSessionId } from '../../../store/selectors.js'
import { moveTo } from '../reorder.js'
import { SessionListRow } from '../rows/SessionListRow.jsx'

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
  // Read at the drop, so the handler stays one function and unchanged rows are not redrawn (SessionListRow)
  const latest = useRef({ sessions, byApp: groupedSessions.byApp })
  useLayoutEffect(() => {
    latest.current = { sessions, byApp: groupedSessions.byApp }
  })
  const onReorder = useCallback(
    (rowId: string, draggedId: string, before: boolean) => {
      const { sessions: listed, byApp } = latest.current
      // An app-owned row belongs by its appId, not its position
      if ([...byApp.values()].some((owned) => owned.some((session) => session.id === draggedId))) return
      void useStore.getState().reorderSessions(projectId, moveTo(listed.map((x) => x.id), draggedId, rowId, before))
    },
    [projectId],
  )
  // Folded groups (#666): the children of a session. `foldedGroups` is one array, so this re-renders only when it changes
  const foldedGroups = useStore((s) => s.prefs.foldedGroups)
  const rows = treeRows(groupedSessions.project, (id) => foldedGroups.includes(childrenGroupKey(id)))
  if (rows.length === 0) return null
  return (
    <ul>
      {rows.map((row) => (
        <SessionListRow
          key={row.s.id}
          row={row}
          projectId={projectId}
          onReorder={onReorder}
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
