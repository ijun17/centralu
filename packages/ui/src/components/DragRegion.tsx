import { errorMessage } from '@cc/protocol/client'
import { useRef, type CSSProperties, type ReactNode } from 'react'
import { usePlatform } from '../app/PlatformProvider.jsx'
import { useStore } from '../store/store.js'

/**
 * The handle that moves the window. Tauri's `data-tauri-drag-region` works only on the exact element pressed (text or
 * an icon in the header would be a hole, and spreading it on every child misses new ones), so the drag starts here
 * on any press that is not on something interactive.
 *
 * A popover inside the region marks itself `data-no-drag`, its full-screen backdrop too (#365): on Windows tao's drag
 * (ReleaseCapture, WM_NCLBUTTONDOWN/HTCAPTION) runs a modal move loop that eats the mouseup, so a backdrop waiting for
 * `click` would never close. Backdrops close on mousedown for the same reason.
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
      // Kept too: the native path is smoother when it catches the press first
      data-tauri-drag-region
      onMouseDown={(e) => {
        if (e.button !== 0) return
        const el = e.target as HTMLElement
        // React bubbles through portals by component tree, so a popover portalled to body arrives here too (#365)
        if (!e.currentTarget.contains(el)) return
        if (el.closest('button, a, input, textarea, select, label, [role="button"], [data-no-drag]')) return
        // A double click's second press is the shell's: it maximizes (or zooms) on the marked region itself
        if (e.detail >= 2) return
        // Keeps focus where it was, as a native title bar does (#115): a press on a div would move it to <body>
        e.preventDefault()
        /*
         * One drag per press: a press on an element carrying data-tauri-drag-region also reaches the shell's own drag
         * script on `document`, and on Windows its second start can land after the first drag began or ended, so the
         * drag does not start. `false` tells that script to skip this press; the value is put back on the next task.
         */
        if (el.hasAttribute('data-tauri-drag-region') && el.getAttribute('data-tauri-drag-region') !== 'false') {
          const was = el.getAttribute('data-tauri-drag-region') ?? ''
          el.setAttribute('data-tauri-drag-region', 'false')
          setTimeout(() => el.setAttribute('data-tauri-drag-region', was), 0)
        }
        void platform.system.startWindowDrag().catch((err: unknown) => {
          // A missing Tauri permission (core:window:allow-start-dragging) rejects here; silent, the window just stops moving
          if (warned.current) return
          warned.current = true
          setToast(`Could not move window: ${errorMessage(err)}`)
        })
      }}
      onDoubleClick={(e) => {
        const el = e.target as HTMLElement
        if (el.closest('button, a, input, textarea, select, label')) return
        // macOS: double-clicking the title bar zooms; left to the native handler
      }}
    >
      {children}
    </div>
  )
}
