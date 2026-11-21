import { useEffect, useRef, type RefObject } from 'react'
import { isPlainEscape } from '../app/keys.js'
import { coveringLayerOpened } from '../store/layers.js'
import { useStore } from '../store/store.js'

/**
 * How a popover, a menu or a modal goes away, written once (#428).
 * - Escape closes the innermost open thing only (`stopPropagation`), in the capture phase on the window, so a row that
 *   stops its own events cannot swallow it. A composition's Esc (#181) is not one.
 * - A press outside `refs` closes it; `refs` holds the trigger too, or its mousedown closes and its click reopens.
 *   Leave `refs` out when a backdrop or a modal's scrim catches outside presses.
 * - The window losing focus closes it unless `closeOnBlur` is off: a click into an app's view takes focus but is no mousedown here.
 * - A window opening over the screen closes it unless `closeOverWindow` is off: those windows hear Escape after this listener.
 * - `returnFocusTo` gets focus after Escape only, when focus is the popover's or nobody's (WebKit does not focus a button on click).
 * `onClose` may be a new function every render; the listeners stay.
 */
export function useDismiss({
  open = true,
  onClose,
  refs,
  returnFocusTo,
  closeOnBlur = refs !== undefined,
  closeOverWindow = true,
}: {
  /** Nothing is listened to while it is false. Absent: always listening (a modal exists only while it is open) */
  open?: boolean
  onClose: () => void
  /** The popover and its trigger: a press outside all of them closes. Absent: outside presses are not handled here */
  refs?: readonly RefObject<Element | null>[]
  /** Escape focuses this afterwards */
  returnFocusTo?: RefObject<HTMLElement | null> | HTMLElement | null
  /** Defaults to on when `refs` is given: a popover without a backdrop can be left through a click into an app's view */
  closeOnBlur?: boolean
  /** Defaults to on: a popover goes when a window opens over the screen. A modal is itself such a layer and stays */
  closeOverWindow?: boolean
}): void {
  const latest = useRef({ onClose, refs, returnFocusTo })
  latest.current = { onClose, refs, returnFocusTo }
  const watchesOutside = refs !== undefined
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      const { refs: inside, onClose: close } = latest.current
      const target = e.target as Node
      if (inside && !inside.some((r) => r.current?.contains(target))) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (!isPlainEscape(e)) return
      const { onClose: close, refs: inside, returnFocusTo: back } = latest.current
      e.stopPropagation()
      const holder = document.activeElement
      const mine = !holder || holder === document.body || !!inside?.some((r) => r.current?.contains(holder))
      close()
      const to = back && 'current' in back ? back.current : back
      if (mine) to?.focus()
    }
    const onBlur = () => latest.current.onClose()
    const stopWatchingWindows = closeOverWindow
      ? useStore.subscribe((now, before) => {
          if (coveringLayerOpened(before, now)) latest.current.onClose()
        })
      : undefined
    if (watchesOutside) window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    if (closeOnBlur) window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
      stopWatchingWindows?.()
    }
  }, [open, watchesOutside, closeOnBlur, closeOverWindow])
}
