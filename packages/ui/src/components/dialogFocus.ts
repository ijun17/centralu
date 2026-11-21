import { useCallback, useEffect, useId, type KeyboardEvent, type RefObject } from 'react'
import { composingKey } from '../app/keys.js'

/**
 * The keyboard inside a dialog (#842 item 7); spread the returned props on the panel.
 *
 * - Focus starts inside: on what the dialog focused itself (`autoFocus`), else on the panel, not its first control,
 *   which in a confirmation is often the one that deletes, and Enter would press it.
 * - Tab cycles inside, moved here: WebKit's Tab skips buttons unless the system's keyboard setting says otherwise, so the
 *   browser walks out of the dialog. A control in a portal is left to the browser. Tab from `<body>` (the focused
 *   control went away) goes to the top dialog's first control, Shift+Tab to its last. A composing Tab is left alone.
 * - `role="dialog"`, `aria-modal`, and the name from its first heading unless it has one.
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
    // A key pressed while focus is on the page never reaches the panel, so the top dialog listens on the document
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

/** The rendered controls Tab reaches in `root`, in order; not `tabIndex = -1` ones (the palette's options: arrows walk them) */
function focusablesIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    (el) =>
      el.tabIndex >= 0 && !el.closest('[inert]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden',
  )
}

/** Where Tab goes in a dialog, wrapping at both ends, from the panel to the first or last; null leaves it to the browser */
export function trapTarget<T>(focusables: readonly T[], active: unknown, panel: unknown, shift: boolean): T | null {
  const n = focusables.length
  if (n === 0) return null
  if (active === panel) return shift ? focusables[n - 1]! : focusables[0]!
  const at = focusables.indexOf(active as T)
  if (at < 0) return null
  return focusables[(at + (shift ? n - 1 : 1)) % n]!
}
