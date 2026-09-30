import { useRef, type CSSProperties, type ReactNode } from 'react'
import { usePlatform } from '../app/PlatformProvider.jsx'
import { useStore } from '../store/store.js'

/**
 * The handle that moves the window.
 *
 * The `data-tauri-drag-region` attribute alone is not enough: that attribute has to sit on the
 * exact element the mousedown lands on, so grabbing text or an icon inside the header simply does
 * nothing. Spreading the attribute onto every child does not fix it either, since a new child
 * opens a new hole — that is where "it works sometimes and not other times" comes from (caught
 * twice in dogfooding).
 *
 * So mousedown is caught across the whole region, and unless the spot pressed is something
 * interactive (a button, an input), the drag is started manually. Every visible empty spot
 * becomes grabbable.
 */
export function DragRegion({
  children,
  className,
  style,
  testId,
}: {
  children?: ReactNode
  className?: string
  /** For lengths that are not ours to hardcode — e.g. the room the OS window controls need */
  style?: CSSProperties
  testId?: string
}) {
  const platform = usePlatform()
  const setToast = useStore((s) => s.setToast)
  const warned = useRef(false)

  return (
    <div
      className={className}
      style={style}
      data-testid={testId}
      // The attribute is kept too — if the native path catches it first, that is smoother
      data-tauri-drag-region
      onMouseDown={(e) => {
        if (e.button !== 0) return
        const el = e.target as HTMLElement
        // Does not drag over something interactive. Without this guard, buttons stop working
        if (el.closest('button, a, input, textarea, select, label, [role="button"], [data-no-drag]')) return
        void platform.system.startWindowDrag().catch((err: Error) => {
          // Does not swallow the error. This exact thing caused the window to stop moving and
          // went unnoticed three times before — if the Tauri permission
          // (core:window:allow-start-dragging) is missing, it gets rejected right here.
          if (warned.current) return
          warned.current = true
          setToast(`Could not move window: ${err.message}`)
        })
      }}
      onDoubleClick={(e) => {
        const el = e.target as HTMLElement
        if (el.closest('button, a, input, textarea, select, label')) return
        // macOS convention: double-clicking the title bar zooms. Left to the native handler
      }}
    >
      {children}
    </div>
  )
}
