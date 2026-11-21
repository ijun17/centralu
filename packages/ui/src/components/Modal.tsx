import { useEffect, useRef, type ReactNode } from 'react'
import { useDismiss } from './useDismiss.js'
import { createPortal } from 'react-dom'
import { useStore } from '../store/store.js'
import { useFocusReturn } from './focusReturn.js'
import { useDialogFocus } from './dialogFocus.js'

/**
 * Counts a screen-covering layer in the store's `openLayers` (#158), so global keys (y/n/a on an approval card) know a
 * dialog floats; a layer that is not a `Modal` (the run-command window) calls this directly. Also gives focus back
 * once the layer is gone (#115, focusReturn.ts).
 */
export function useOpenLayer(): void {
  useFocusReturn(true)
  useEffect(() => {
    useStore.setState((s) => ({ openLayers: s.openLayers + 1 }))
    return () => useStore.setState((s) => ({ openLayers: Math.max(0, s.openLayers - 1) }))
  }, [])
}

/**
 * The modal's shell, in a portal to body: `absolute inset-0` would sit in the nearest positioned ancestor (the sidebar
 * is `relative` for its resize handle). Esc and the outside click are handled here once, so every modal has both.
 */
export function Modal({
  onClose,
  children,
  testId,
  align = 'center',
}: {
  onClose: () => void
  children: ReactNode
  testId?: string
  /** `top` suits a list-shaped modal */
  align?: 'center' | 'top'
}) {
  useOpenLayer()
  // Escape only: the scrim below takes the outside press, and a modal stays up when the window loses focus
  useDismiss({ onClose, closeOverWindow: false })
  const panelRef = useRef<HTMLDivElement>(null)
  const dialog = useDialogFocus(panelRef)

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex justify-center bg-scrim backdrop-blur-[2px] ${
        align === 'top' ? 'items-start pt-[calc(12vh/var(--text-zoom))]' : 'items-center'
      }`}
      onClick={onClose}
      data-testid={testId}
    >
      <div ref={panelRef} {...dialog} className="outline-none" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>,
    document.body,
  )
}
