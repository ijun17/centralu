import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPlacement } from '../../../components/anchored.js'
import { useDismiss } from '../../../components/useDismiss.js'
import { SIDEBAR_VARS } from '../layout.js'

// The one shell for sidebar row menus: placement and closing rules, written once.

/** The button that opened a row menu, from the box that holds it: what the keyboard returns to */
export function menuTrigger(anchorEl: HTMLElement | null): HTMLElement | null {
  return anchorEl?.querySelector('button') ?? anchorEl
}

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
   * Fixed, under its button: `absolute` resolves against the whole sidebar, and the sidebar's overflow would clip it.
   * It flips up when there is no room; hidden until measured.
   */
  const place = useAnchoredPlacement(anchorEl, ref, true, { align: 'right' })
  /*
   * The anchor box places the menu; its button takes the keyboard back. The trigger is in `refs`: its click toggles the
   * menu, so a press on it must not count as outside, or the menu closes on mousedown and the click reopens it.
   */
  const trigger = menuTrigger(anchorEl)
  useDismiss({ onClose, refs: [ref, { current: anchorEl }], returnFocusTo: trigger })

  // Tab from the button goes into the menu, Shift+Tab back (#1531): portaled, the menu is last in the document
  const firstItem = (): HTMLElement | null => ref.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? null
  useEffect(() => {
    if (!trigger) return
    const into = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || e.shiftKey || e.target !== trigger) return
      const first = firstItem()
      if (!first) return
      e.preventDefault()
      first.focus()
    }
    trigger.addEventListener('keydown', into)
    return () => trigger.removeEventListener('keydown', into)
  }, [trigger])
  const back = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Tab' || !e.shiftKey || e.target !== firstItem() || !(trigger instanceof HTMLElement)) return
    e.preventDefault()
    trigger.focus()
  }

  /*
   * Drawn into the body (#1531): an ancestor's opacity (an away machine's block, `opacity-60`) applies to fixed
   * descendants too and no child can undo it, the reason the tooltip is portaled.
   */
  return createPortal(
    <div
      ref={ref}
      role="menu"
      data-testid={testId}
      onKeyDown={back}
      className={`fixed z-30 ${className} overflow-y-auto rounded-lg border border-line bg-surface-raised p-1 shadow-(--shadow-popover)`}
      style={{
        // The sidebar's own line colour (SIDEBAR_VARS), which a menu drawn into the body does not inherit
        ...SIDEBAR_VARS,
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
