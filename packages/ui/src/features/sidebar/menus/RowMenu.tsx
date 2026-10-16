import { useRef, type ReactNode } from 'react'
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
}: {
  anchorEl: HTMLElement | null
  testId: string
  onClose: () => void
  children: ReactNode
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
  useDismiss({ onClose, refs: [ref], returnFocusTo: anchorEl?.querySelector('button') ?? anchorEl })

  return (
    <div
      ref={ref}
      role="menu"
      data-testid={testId}
      className="fixed z-30 w-48 overflow-y-auto rounded-md border border-line bg-surface-raised py-1 shadow-(--shadow-popover)"
      style={{
        top: place?.top ?? 0,
        left: place?.left ?? 0,
        maxHeight: place?.maxHeight,
        visibility: place ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>
  )
}
