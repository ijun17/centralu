import { useCallback, useEffect, useId, type KeyboardEvent, type RefObject } from 'react'
import { composingKey } from '../app/keys.js'

/**
 * The keyboard inside a dialog (#842 item 7): where focus starts, and Tab staying inside.
 *
 * A dialog that covers the window (a modal, Settings, the palette) used to leave focus wherever it was: on the button
 * that opened it, behind the scrim, so the first Tab walked into the screen the dialog was hiding and a screen reader
 * never heard that a dialog had opened. Now:
 *
 * - **Focus starts inside.** A dialog that put focus somewhere of its own (an `autoFocus` field, a child's effect) keeps
 *   that; otherwise the dialog's panel takes it. The panel, not its first control: the first control of a confirmation
 *   is often the one that deletes, and Enter on a focused button presses it.
 * - **Tab cycles inside**, through every control, and from the last back to the first. It is moved here rather than left
 *   to the browser: WebKit's Tab passes over buttons unless the system's keyboard setting says otherwise, so the control
 *   it would stop on last was not the last one, and the browser walked out of the dialog. A control outside the panel's
 *   DOM (a menu drawn in a portal) is left to the browser.
 *   Focus that fell to the page (the focused control went away, a re-render dropped it) is brought back the same way: Tab
 *   from `<body>` goes to the top dialog's first control, Shift+Tab to its last. A Tab an input method is composing with
 *   is left alone.
 * - **The panel says what it is**: `role="dialog"`, `aria-modal`, and its name from its first heading unless it has one.
 *
 * Spread the returned props on the panel element.
 */
export function useDialogFocus(
  panelRef: RefObject<HTMLElement | null>,
  open = true,
): { role: 'dialog'; 'aria-modal': true; tabIndex: -1; onKeyDown: (e: KeyboardEvent<HTMLElement>) => void } {
  const headingId = useId()
  useEffect(() => {
    const panel = panelRef.current
    if (!open || !panel) return
    if (!panel.hasAttribute('aria-label') && !panel.hasAttribute('aria-labelledby')) {
      const heading = panel.querySelector('h1, h2, h3')
      if (heading) {
        heading.id ||= headingId
        panel.setAttribute('aria-labelledby', heading.id)
      }
    }
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true })
    /*
     * A key pressed while focus sits on the page never reaches the panel's own handler, so the dialog on top listens on
     * the document for that one case.
     */
    open_.push(panel)
    const onPageKey = (e: globalThis.KeyboardEvent) => {
      if (open_.at(-1) !== panel || !tabKey(e)) return
      const holder = document.activeElement
      if (holder && holder !== document.body) return
      const next = trapTarget(focusablesIn(panel), panel, panel, e.shiftKey)
      if (!next) return
      e.preventDefault()
      next.focus()
    }
    document.addEventListener('keydown', onPageKey)
    return () => {
      document.removeEventListener('keydown', onPageKey)
      open_.splice(open_.lastIndexOf(panel), 1)
    }
  }, [open, panelRef, headingId])

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (!tabKey(e.nativeEvent)) return
      const panel = panelRef.current
      if (!panel) return
      const next = trapTarget(focusablesIn(panel), document.activeElement, panel, e.shiftKey)
      if (!next) return
      e.preventDefault()
      next.focus()
    },
    [panelRef],
  )

  return { role: 'dialog', 'aria-modal': true, tabIndex: -1, onKeyDown }
}

/** The dialogs open now, the top one last: only it takes a Tab pressed on the page */
const open_: HTMLElement[] = []

/** A plain Tab or Shift+Tab that is not part of an input method's composition (#181) */
export function tabKey(e: Pick<globalThis.KeyboardEvent, 'key' | 'defaultPrevented' | 'altKey' | 'metaKey' | 'ctrlKey' | 'isComposing' | 'keyCode'>): boolean {
  return e.key === 'Tab' && !e.defaultPrevented && !e.altKey && !e.metaKey && !e.ctrlKey && !composingKey(e)
}

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/**
 * The controls Tab reaches inside `root`, in order: rendered ones only (not hidden, not inert), and not the ones taken
 * out of the Tab order (`tabIndex = -1`, like the palette's options, which the arrows walk)
 */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) =>
      el.tabIndex >= 0 && !el.closest('[inert]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden',
  )
}

/**
 * Where Tab goes inside a dialog, or null to leave it to the browser (a pure function: tests attach here). The next
 * control, or the previous one with Shift, wrapping at both ends; from the panel itself, the first or the last. A
 * focused element that is neither a control here nor the panel (a portal's) is left alone.
 */
export function trapTarget<T>(focusables: readonly T[], active: unknown, panel: unknown, shift: boolean): T | null {
  const n = focusables.length
  if (n === 0) return null
  if (active === panel) return shift ? focusables[n - 1]! : focusables[0]!
  const at = focusables.indexOf(active as T)
  if (at < 0) return null
  return focusables[(at + (shift ? n - 1 : 1)) % n]!
}
