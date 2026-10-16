import type { Dispatch, SetStateAction } from 'react'
import type { SessionSummary } from '@cc/core'
import { useStore } from '../../../store/store.js'
import { moveTo } from '../reorder.js'
import { SessionListRow } from '../rows/SessionListRow.jsx'
import type { TreeRow } from '../tree.js'

/** A session row of the project's own list: dropping another session on it reorders the list. */
export function ProjectSessionRow({
  row,
  projectId,
  sessions,
  byApp,
  focusedSessionId,
  renaming,
  setRenaming,
  sessionMenu,
  setSessionMenu,
  setHandingOff,
  setConfirming,
}: {
  row: TreeRow
  projectId: string
  /** The project's sessions in list order: what a drop reorders */
  sessions: SessionSummary[]
  /** The sessions listed apps own, which cannot be reordered into the project's list */
  byApp: Map<string, SessionSummary[]>
  focusedSessionId: string | null
  renaming: string | null
  setRenaming: (id: string | null) => void
  sessionMenu: { id: string; el: HTMLElement } | null
  setSessionMenu: Dispatch<SetStateAction<{ id: string; el: HTMLElement } | null>>
  setHandingOff: (id: string | null) => void
  setConfirming: (id: string | null) => void
}) {
  const reorderSessions = useStore((s) => s.reorderSessions)
  return (
    <SessionListRow
      row={row}
      projectId={projectId}
      onReorder={(draggedId, before) => {
        // App-owned rows can still be dropped on the grid, but their appId — not list position — is their membership.
        if (
          [...byApp.values()].some((owned) =>
            owned.some((session) => session.id === draggedId),
          )
        )
          return
        void reorderSessions(
          projectId,
          moveTo(
            sessions.map((x) => x.id),
            draggedId,
            row.s.id,
            before,
          ),
        )
      }}
      focusedSessionId={focusedSessionId}
      renaming={renaming}
      setRenaming={setRenaming}
      sessionMenu={sessionMenu}
      setSessionMenu={setSessionMenu}
      setHandingOff={setHandingOff}
      setConfirming={setConfirming}
    />
  )
}
