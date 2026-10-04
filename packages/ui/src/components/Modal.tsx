import { useEffect, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useStore } from '../store/store.js'

/**
 * Raises the store's `openLayers` while a single screen-covering layer is floating (#158).
 *
 * Whether a dialog is open is usually local state on the component that raised it, so a global
 * shortcut (y/n/a on an approval card) had no way to know one was floating. `Modal` counts itself,
 * so a new dialog is covered automatically with no extra work. A layer that does not use `Modal`
 * (the run-command window) calls this hook directly.
 */
export function useOpenLayer(): void {
  useEffect(() => {
    useStore.setState((s) => ({ openLayers: s.openLayers + 1 }))
    return () => useStore.setState((s) => ({ openLayers: Math.max(0, s.openLayers - 1) }))
  }, [])
}

/**
 * The modal's shell.
 *
 * This must be rendered through a portal. `absolute inset-0` positions itself relative to the
 * nearest positioned ancestor, and where the component using the modal happens to sit is none of
 * the modal's business. This actually happened: adding `relative` to the sidebar for its resize
 * handle trapped the session-creation modal opened inside it within the sidebar's width (caught
 * in dogfooding). Covering the whole window regardless of an ancestor's circumstances requires
 * attaching to body.
 *
 * Closing on Esc and on an outside click is also handled once, here — if every caller reimplements
 * it, some modals end up with Esc working and others without.
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
  /** Whether to anchor it to the top or center it. A list-shaped modal is easier to use anchored at the top */
  align?: 'center' | 'top'
}) {
  useOpenLayer()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  return createPortal(
    <div
      className={`fixed inset-0 z-50 flex justify-center bg-scrim backdrop-blur-[2px] ${
        align === 'top' ? 'items-start pt-[calc(12vh/var(--text-zoom))]' : 'items-center'
      }`}
      onClick={onClose}
      data-testid={testId}
    >
      <div onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>,
    document.body,
  )
}
