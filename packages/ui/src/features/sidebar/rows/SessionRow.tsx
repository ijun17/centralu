import type { ReactNode } from 'react'
import { SESSION_MIME, projectItemMime } from '../reorder.js'
import { INDENT, GUIDE } from '../layout.js'
import { useDropLine, dropLine } from '../dragDrop.js'

/**
 * One session row. It can be dragged, and can receive another row being dropped on it.
 *
 * Each row has to hold its own drop state so the line is drawn **only on that row** — combining
 * them into one would mean recomputing which row it is over on every event.
 */
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
  /**
   * Not draggable while the name is being edited. An input inside a draggable ancestor gets a
   * text-selection drag from the browser interpreted as **dragging the element** instead, so
   * rubbing across it to fix the name drags the whole row along with it.
   */
  draggable: boolean
  /**
   * Is this a worktree session, drawn indented under the session that started it (#69, #561)? Indentation plus a
   * vertical guide line — hierarchy lives only in the sidebar (the grid is flat, a design
   * decision).
   */
  nested?: boolean | number
  /**
   * How far in the row stands (#666): 1 for a session of a project, one more for the children it started, and for
   * the sessions of an app (the app row is the level-1 item), one more again for theirs, and one more for each step
   * further in a child's own children hang (#862), up to `MAX_LEVEL`. Every level is 16px, the
   * width of the chevron's gutter, so the tool mark of a level starts at one column. Levels 2 and up also carry the
   * guide line that ties a row to what it hangs under; level 1 hangs under the project's tinted group instead.
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
      <div className="relative">{children}</div>
    </li>
  )
}
