import type { ComponentProps } from 'react'
import type { SessionSummary } from '@cc/core'
import { useStore } from '../../../store/store.js'
import { moveTo } from '../reorder.js'
import { SessionListRow } from '../rows/SessionListRow.jsx'

/** A session row of the project's own list: dropping another session on it reorders the list. */
export function ProjectSessionRow({
  sessions,
  byApp,
  ...row
}: Omit<ComponentProps<typeof SessionListRow>, 'inApp' | 'onReorder'> & {
  /** The project's sessions in list order: what a drop reorders */
  sessions: SessionSummary[]
  /** The sessions listed apps own, which cannot be reordered into the project's list */
  byApp: Map<string, SessionSummary[]>
}) {
  const reorderSessions = useStore((s) => s.reorderSessions)
  const { projectId } = row
  return (
    <SessionListRow
      {...row}
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
            row.row.s.id,
            before,
          ),
        )
      }}
    />
  )
}
