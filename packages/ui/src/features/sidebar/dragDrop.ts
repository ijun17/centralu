import { useState } from 'react'
import { dropsBefore } from './reorder.js'

/**
 * Drag-to-reorder. The dragged kind is a MIME type, so a session dropped on a project's spot is refused instead of
 * reordering the wrong list. The drop spot shows as a line, so the hand knows where it lands before it lifts.
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
 * The drop-spot line. Not a border: that grows the row by 1px, so the list jumps as the line moves. Not an inset
 * shadow: the rows on either side of one boundary would draw it 2-3px apart. An absolute `after` at -1px puts both
 * rows' lines on the same pixel and claims no layout space.
 */
const DROP_LINE = 'after:pointer-events-none after:absolute after:inset-x-0 after:z-10 after:h-0.5 after:bg-ink-muted after:content-[""]'

export function dropLine(edge: 'top' | 'bottom' | null): string {
  if (!edge) return ''
  return `${DROP_LINE} ${edge === 'top' ? 'after:-top-px' : 'after:-bottom-px'}`
}
