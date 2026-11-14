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
  /*
   * A drop reorders the list as it is at the drop, read from here, so the handler is one function for the list's life
   * and a row whose session did not change is not drawn again (SessionListRow).
   */
  const latest = useRef({ sessions, byApp: groupedSessions.byApp })
  useLayoutEffect(() => {
    latest.current = { sessions, byApp: groupedSessions.byApp }
  })
  const onReorder = useCallback(
    (rowId: string, draggedId: string, before: boolean) => {
      const { sessions: listed, byApp } = latest.current
      // App-owned rows can still be dropped on the grid, but their appId — not list position — is their membership.
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
