import type { ReactNode } from 'react'
import { SESSION_MIME, projectItemMime } from '../reorder.js'
import { INDENT, GUIDE } from '../layout.js'
import { useDropLine, dropLine } from '../dragDrop.js'

/** One draggable session row; each holds its own drop state so the line is drawn only on it */
export function SessionRow({
  id,
  projectId,
  onReorder,
  draggable,
  nested,
  level,
  children,
}: {
  id: string
  /** Carried in the drag, so the project screen can tell its own sessions from another project's (reorder.ts) */
  projectId: string
  onReorder: (draggedId: string, before: boolean) => void
  /** Off while the name is edited: in a draggable ancestor, selecting the input's text drags the whole row */
  draggable: boolean
  /** Drawn under the session that started it (#69, #561) */
  nested?: boolean | number
  /**
   * How far in the row stands (#666, #862), up to `MAX_LEVEL`: 1 for a project's session or an app row, one more per
   * step in. Levels 2 and up carry the guide line; level 1 hangs under the project's tinted group.
   */
  level: keyof typeof INDENT
  children: ReactNode
}) {
  const drop = useDropLine(SESSION_MIME, onReorder)
  return (
    <li
      data-nested={nested === true ? true : typeof nested === 'number' && nested > 0 ? nested : undefined}
      data-level={level}
      className={`group/row relative ${INDENT[level]} ${level > 1 ? GUIDE : ''} ${dropLine(drop.edge)}`}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData(SESSION_MIME, id)
        e.dataTransfer.setData(projectItemMime(projectId), projectId)
        e.dataTransfer.effectAllowed = 'move'
      }}
      {...drop.handlers}
    >
      <div className="relative pr-1.5">{children}</div>
    </li>
  )
}
