import { useEffect, useRef, type ReactNode, type RefObject } from 'react'
import { useOpenLayer } from '@cc/ui'

/**
 * What every dialog the desktop draws itself needs, written once: it counts as an open layer (so a
 * global shortcut — y/n/a on an approval card, the inbox keys — never answers what lies behind it),
 * it takes the keyboard when it opens and gives it back when it closes (useOpenLayer), Esc cancels,
 * and Tab stays inside it. The quit dialog keeps its own Enter/Esc handling and only needs the layer.
 */
export function useDialogLayer(box: RefObject<HTMLElement | null>, onCancel?: () => void): void {
  useOpenLayer()
  useEffect(() => {
    if (!onCancel) return
    box.current?.querySelector<HTMLElement>('button')?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing) {
        e.preventDefault()
        e.stopPropagation()
        onCancel()
        return
      }
      if (e.key !== 'Tab') return
      const el = box.current
      if (!el) return
      const stops = [...el.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(
        (x) => !x.hasAttribute('disabled'),
      )
      if (stops.length === 0) return
      const at = stops.indexOf(document.activeElement as HTMLElement)
      e.preventDefault()
      e.stopPropagation()
      const next = at < 0 ? (e.shiftKey ? stops.length - 1 : 0) : (at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length
      stops[next]!.focus()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [box, onCancel])
}

/** The desktop's own confirmation dialog: the backdrop that cancels on a press outside, and the box (useDialogLayer) */
export function DesktopDialog({
  onCancel,
  testId,
  label,
  children,
}: {
  onCancel: () => void
  testId: string
  label: string
  children: ReactNode
}) {
  const box = useRef<HTMLDivElement>(null)
  useDialogLayer(box, onCancel)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-scrim-thin" data-testid={testId} onClick={onCancel}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        className="w-[380px] rounded-lg border border-line bg-surface-side p-4 shadow-(--shadow-modal)"
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </div>
  )
}

/** Only counts a layer: for a dialog that keeps its own keyboard handling (the quit dialog) */
export function OpenLayer(): null {
  useOpenLayer()
  return null
}
