import { useState } from 'react'
import { dropsBefore } from './reorder.js'

/**
 * Drag-to-reorder.
 *
 * **The kind of thing being dragged is stated as a MIME type.** That is what makes dropping a
 * session onto a project's spot do nothing — without checking the kind, the wrong list gets
 * reordered.
 *
 * The drop spot is shown as a line. Without the line there is no way to know where it will land
 * until the hand lifts, so the person drops it, sees it is wrong, and undoes it, over and over.
 */
export function useDropLine(mime: string, onDrop: (draggedId: string, before: boolean) => void) {
  const [edge, setEdge] = useState<'top' | 'bottom' | null>(null)

  return {
    edge,
    handlers: {
      onDragOver: (e: React.DragEvent) => {
        if (!e.dataTransfer.types.includes(mime)) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        const r = e.currentTarget.getBoundingClientRect()
        setEdge(dropsBefore(r, e.clientY) ? 'top' : 'bottom')
      },
      onDragLeave: () => setEdge(null),
      onDrop: (e: React.DragEvent) => {
        const id = e.dataTransfer.getData(mime)
        setEdge(null)
        if (!id) return
        e.preventDefault()
        e.stopPropagation()
        const r = e.currentTarget.getBoundingClientRect()
        onDrop(id, dropsBefore(r, e.clientY))
      },
    },
  }
}

/**
 * The drop-spot indicator — a single thin line is enough.
 *
 * **Must not be drawn with a border.** A border grows an element by 1px, so every time the
 * indicator moves to a different row the whole list shifts by that amount — while dragging, it
 * reads as a constant little jump (a dogfooding finding). Worse, the spot the hand is aiming for
 * keeps moving, which makes dropping harder too.
 *
 * **The line sits on the boundary between rows, not inside a row** (dogfooding, 2026-09-10:
 * "it is the same spot, but the line nudges up and down slightly"). One boundary is shared by two
 * rows — it is the "bottom" for the row above and the "top" for the row below. An inset shadow
 * draws that on **each row's own inside edge**, so the two indicators pointing at the same
 * boundary ended up 2-3px apart. That is why the line appeared to jump by that amount every time
 * the hand crossed the boundary.
 *
 * Placing an absolutely positioned pseudo-element (`after`) right on the boundary (-1px) instead
 * makes the two rows' indicators land on **the same pixel**. It keeps the property of not
 * affecting box size — `absolute` does not claim space in the layout.
 */
const DROP_LINE = 'after:pointer-events-none after:absolute after:inset-x-0 after:z-10 after:h-0.5 after:bg-ink-muted after:content-[""]'

export function dropLine(edge: 'top' | 'bottom' | null): string {
  if (!edge) return ''
  return `${DROP_LINE} ${edge === 'top' ? 'after:-top-px' : 'after:-bottom-px'}`
}
