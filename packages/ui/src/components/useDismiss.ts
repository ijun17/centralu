import { useEffect, useRef, type RefObject } from 'react'
import { isPlainEscape } from '../app/keys.js'

/**
 * How a popover, a menu or a modal goes away: one set of rules, written once (#428).
 *
 * Seven popovers each had their own copy, and the copies had drifted. The sidebar's row menu let its Escape travel on,
 * so the same press also closed the inbox behind it; only the span picker closed when the window lost focus (a click
 * into an app's view never reaches this document as a mousedown, but it takes focus out of it); only it gave focus
 * back to its button.
 *
 * - **Escape** closes the innermost open thing only: the press is claimed (`stopPropagation`), so the inbox, a modal or
 *   a layer under it does not close along with it. Capture phase on the window, so a row below that stops its own
 *   events cannot swallow it. A composition's Esc (#181) is not one.
 * - **A press outside** every element of `refs` closes it (capture phase, for the same reason). `refs` holds the
 *   trigger too, or pressing the trigger closes it on mousedown and its click reopens it (unless the trigger's own handler
 *   copes, as the sidebar menus' do). Leave `refs` out when
 *   something else catches outside presses (a backdrop under the popover, or a modal's own scrim).
 * - **The window losing focus** closes it, unless `closeOnBlur` is off: the popovers that sit over an app's view need it,
 *   a modal or a popover with a backdrop (which covers the view) does not.
 * - **`returnFocusTo`**: Escape gives focus back to the trigger, since the person is on the keyboard. A press outside
 *   or a blur does not: they moved focus on purpose. Only when focus is the popover's or nobody's: a composer the person
 *   is typing in (WebKit does not focus a button on click, so focus may never have left it) keeps the keyboard.
 *
 * `onClose` may be a new function every render; the listeners stay.
 */
export function useDismiss({
  open = true,
  onClose,
  refs,
  returnFocusTo,
  closeOnBlur = refs !== undefined,
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
    if (watchesOutside) window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    if (closeOnBlur) window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [open, watchesOutside, closeOnBlur])
}
