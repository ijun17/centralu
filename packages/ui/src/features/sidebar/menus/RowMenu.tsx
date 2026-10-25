import { useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPlacement } from '../../../components/anchored.js'
import { useDismiss } from '../../../components/useDismiss.js'

/**
 * The shared shell for sidebar row menus — placement (zoom compensation, flipping, edge handling)
 * and the closing rules live here. Pulled out of the project menu: once session rows needed the
 * same menu, writing this calculation twice would foreseeably end up with only one copy fixed later
 * (the zoom compensation already went through that once).
 */
export function RowMenu({
  anchorEl,
  testId,
  onClose,
  children,
  className = 'w-48',
}: {
  anchorEl: HTMLElement | null
  testId: string
  onClose: () => void
  children: ReactNode
  /** The menu's width: a row menu's by default, wider for one that reads out a state (the machine badge's) */
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)

  /*
   * **Appears right below the button that opened it.**
   *
   * It used to be `absolute right-2 top-6`. This row has no positioned ancestor of its own, so
   * that coordinate resolved against the sidebar as a whole, and no matter which project was
   * pressed, the menu always landed at one fixed spot near the top right of the sidebar — pressing
   * the tenth project produced its answer at the very top (a dogfooding finding). A menu has to sit
   * **next to whatever called it** for it to read as a menu about that thing.
   *
   * Why `fixed`: the sidebar has `overflow-y-auto`, so placing it in normal flow would clip the
   * menu for projects lower in the list. Positioning it relative to the viewport leaves no box to
   * clip against.
   *
   * If there is no room below, it flips upward. That means the height has to be **measured first**,
   * and the height is only known once it is rendered — so it is measured and placed with
   * useLayoutEffect (which runs before paint), and any frame where the position is not yet decided
   * never reaches the screen (hidden via visibility).
   */
  const place = useAnchoredPlacement(anchorEl, ref, true, { align: 'right' })
  /*
   * Closes when the person clicks outside it, presses Escape (focus goes back to the button that opened it), or leaves
   * the window. If another project is pressed while
   * a menu is open, it can look as if two menus are open at once, but in fact each one holds its own state, so neither
   * closes the other.
   */
  // The anchor is the box that holds the button (it places the menu); the button is what takes the keyboard back
  /*
   * The trigger is inside `refs`: its click toggles the menu (`setMenuOpen(v => !v)`), so pressing it must not also count as
   * a press outside, or the menu closes on mousedown and the click opens it again.
   */
  useDismiss({ onClose, refs: [ref, { current: anchorEl }], returnFocusTo: anchorEl?.querySelector('button') ?? anchorEl })

  /*
   * **Drawn into the body, not inside the row that opened it** (#1531). `position: fixed` frees a box from clipping, not
   * from its ancestors' paint: an `opacity` on any ancestor applies to every descendant, fixed ones included, so the
   * menu of a project on a machine that is away (its block is `opacity-60`) came up half transparent, the rows under it
   * showing through. Opacity on an ancestor cannot be undone by a child; outside it the menu is whole — the same reason
   * the tooltip is portaled. It also covers any other menu inside a faded or transformed ancestor.
   */
  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-testid={testId}
      className={`fixed z-30 ${className} overflow-y-auto rounded-lg border border-line bg-surface-raised p-1 shadow-(--shadow-popover)`}
      style={{
        top: place?.top ?? 0,
        left: place?.left ?? 0,
        maxHeight: place?.maxHeight,
        visibility: place ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  )
}
