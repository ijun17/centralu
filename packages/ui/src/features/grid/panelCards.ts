import { useCallback, useEffect, useLayoutEffect, useRef, useState, type DragEvent } from 'react'
import { dropsLeft, moveTo } from '../sidebar/reorder.js'

/** Shared by the grid and the project screen: each panel's element, the conversation scroll a reorder resets, the drag image */
function usePanelCards() {
  const cards = useRef(new Map<string, HTMLDivElement>())
  /** Conversation scrolls, taken right before a reorder */
  const scrolls = useRef(new Map<string, number>())

  /*
    Moving a DOM node resets its scrollable descendants to scrollTop 0 (measured: a pane at 40 came back at 0 after one
    insertBefore; the node survives, so React re-runs nothing). The handlers snapshot every conversation's scroll before
    a reorder and this puts it back before paint, only after a snapshot: on every render it would undo a scroll made
    while a message streams in.
  */
  useLayoutEffect(() => {
    if (scrolls.current.size === 0) return
    for (const [id, top] of scrolls.current) {
      const sc = cards.current.get(id)?.querySelector('[data-testid="chat-stream"]')
      if (sc && sc.scrollTop !== top) sc.scrollTop = top
    }
    scrolls.current.clear()
  })

  // Stable, so an effect that reads a panel can list them as dependencies without re-running
  const cardOf = useCallback((id: string): HTMLDivElement | undefined => cards.current.get(id), [])
  const place = useCallback(
    (id: string) => (el: HTMLDivElement | null) => {
      if (el) cards.current.set(id, el)
      else cards.current.delete(id)
    },
    [],
  )
  const snapshotScroll = useCallback(() => {
    scrolls.current.clear()
    for (const [id, el] of cards.current) {
      const sc = el.querySelector('[data-testid="chat-stream"]')
      if (sc) scrolls.current.set(id, sc.scrollTop)
    }
  }, [])
  const liftPanel = useCallback((id: string, e: DragEvent<HTMLElement>) => {
    const card = cards.current.get(id)
    if (card) {
      const r = card.getBoundingClientRect()
      e.dataTransfer.setDragImage(card, e.clientX - r.left, e.clientY - r.top)
    }
  }, [])

  return {
    cardOf,
    /** The ref callback of the panel with this id */
    place,
    /** Call before any state change that can reorder the panels */
    snapshotScroll,
    /** Drags the whole panel: the draggable is the header, which alone would leave only a thin strip following the pointer */
    liftPanel,
  }
}

/**
 * A panel's frame, the same on both screens: the look (`.cc-panel`, styles/index.css), the border
 * and the isolation. `dragged` dims the original while its copy follows the hand.
 */
export function panelClass(dragged: boolean): string {
  /*
    The frame (`line-panel`) is brighter than any line inside it (docs/themes.md "The lines").
    `isolate`: the spinning border's z-30 (above the folded composer's z-20) would otherwise leak over the file/git
    overlay (z-20); raising the overlay's number instead only restarts the race.
  */
  return `cc-panel relative isolate flex min-h-0 flex-col overflow-hidden rounded-lg border border-line-panel bg-surface-floor transition-opacity ${
    dragged ? 'opacity-40' : ''
  }`
}

/** The drag state both screens share (#53). The preview is derived from `dragging` and `over`, so cancelling is clearing them */
export function usePanelDrag() {
  const cards = usePanelCards()
  const { snapshotScroll } = cards
  const [over, setOver] = useState<{ id: string; before: boolean } | null>(null)
  const [dragging, setDragging] = useState<string | null>(null)

  /*
   * Any drag's end clears the last target: a sidebar row let go elsewhere never reaches this screen's dragend, and a
   * stale target would be the next drag's preview. App views need nothing: their panels cover them (dragShield.tsx).
   */
  useEffect(() => {
    const end = () => setOver(null)
    document.addEventListener('dragend', end)
    return () => document.removeEventListener('dragend', end)
  }, [])

  return {
    ...cards,
    dragging,
    setDragging,
    clearOver: () => setOver(null),
    previewOf: (visible: readonly string[]): string[] | null =>
      dragging && over ? moveTo(visible, dragging, over.id, over.before) : null,
    dropMark: (id: string) => (over?.id === id ? (over.before ? 'before' : 'after') : undefined),
    /** The pointer is over panel `id`: aim at its half. Over the dragged panel itself the last target is kept, or the preview flickers */
    aim: (id: string, e: DragEvent<HTMLElement>) => {
      if (dragging === id) return
      const before = dropsLeft(e.currentTarget.getBoundingClientRect(), e.clientX)
      // dragover fires continuously, even with the pointer still — only re-render on change
      if (over?.id === id && over.before === before) return
      snapshotScroll()
      setOver({ id, before })
    },
    clearDrag: () => {
      setOver(null)
      setDragging(null)
    },
    /** A panel's own dragend, with or without a drop — clearing `over` is the rollback (the preview is derived from it) */
    endDrag: () => {
      snapshotScroll()
      setOver(null)
      setDragging(null)
    },
  }
}
