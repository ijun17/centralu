import { useCallback, useLayoutEffect, useRef, type DragEvent } from 'react'

/**
 * What the grid and the project screen share about the panels they lay out: the element of each
 * panel, the conversation scroll that a reorder would reset, and the drag image that lifts a whole
 * panel. `place` is the ref callback of the panel with that id.
 */
export function usePanelCards() {
  /** Reference used to lift the **whole panel**, not just the header, while dragging */
  const cards = useRef(new Map<string, HTMLDivElement>())
  /** Conversation scroll positions, taken right before a reorder — see the layout effect below */
  const scrolls = useRef(new Map<string, number>())

  /*
    Reordering panels moves DOM nodes, and the browser resets a moved node's scrollable
    descendants to scrollTop 0 — scroll is layout state, not a DOM property (measured: a
    pane scrolled to 40 came back at 0 after one insertBefore; the node itself survived,
    so `key={id}` was not the culprit and React never learns anything happened — no effect
    in the pane re-runs). Every reflow step would kick each conversation back to the top.

    So the handlers below snapshot every pane's conversation scroll *before* changing the
    order, and this effect puts the values back before paint. It only acts when a snapshot
    was explicitly taken: restoring on every render would clobber a scroll the user made
    while a message streamed in.
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
    /** The element of the panel with this id, if it is on screen */
    cardOf,
    /** The `ref` of the panel with this id */
    place,
    /** Call before any state change that can reorder the panels */
    snapshotScroll,
    /**
     * Makes the drag carry the whole panel: the draggable element is the header, so the browser
     * picked up only the header and carried it around — the panel stayed put and only a thin strip
     * followed the pointer, so nobody could tell what was actually being moved (dogfooding).
     */
    liftPanel,
  }
}

/**
 * A panel's frame, the same on both screens: the look (`.cc-panel`, styles/index.css), the border
 * and the isolation. `dragged` dims the original while its copy follows the hand.
 */
export function panelClass(dragged: boolean): string {
  /*
    The panel's border is brighter than any line inside the panel (user's
    observation, 2026-09-11). Before, the panel was `line` and the folded input card
    was `line-strong`, so **what was inside was brighter than the vessel holding it**,
    and the eye went to the card's curve before the panel's boundary. The two are
    swapped — the panel goes up to `line-strong` and the card goes down to `line`.

    isolate: the panel contains its own stacking layer.
    The spinning border sits at z-30, because it has to be above the folded composer
    (z-20) inside the panel. But without the panel forming a stacking context, that
    30 leaked outside the panel, and the border was drawn over the file/git overlay
    (z-20) (user's observation). Raising the overlay's number to win would also work,
    but then whoever next picks a number starts the same race over again. For
    "highest within the panel" to actually be true, the panel has to be a fence —
    the same fence the mark's ring needed.
  */
  return `cc-panel relative isolate flex min-h-0 flex-col overflow-hidden rounded-lg border border-line-strong bg-surface-floor transition-opacity ${
    dragged ? 'opacity-40' : ''
  }`
}
