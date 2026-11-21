// Whether someone is typing here, for what would swap the window out under them: the automatic apply (apply-update.ts)
// and an agent's card-less "Apply now" (store/updates.ts, #1509). Its own module, so the store need not import the hooks.
import { isTextEntry } from '../../app/keys.js'

/**
 * How long after the last keystroke in a text field the window counts as "someone is typing". A relaunch reloads the
 * window: a half-typed dialog sentence would be lost (the composer keeps a draft), and it would read as a crash.
 */
export const TYPING_QUIET_MS = 20_000

// The last keydown in an editable field: one capture listener for the window, installed on first use, left on
let lastTypedAt = 0
let typingTracked = false
export function trackTyping(): void {
  if (typingTracked || typeof window === 'undefined') return
  typingTracked = true
  const mark = (e: Event) => {
    if (isTextEntry(e.target)) lastTypedAt = Date.now()
  }
  window.addEventListener('keydown', mark, true)
  window.addEventListener('compositionupdate', mark, true)
}
export function typedWithin(ms: number, now = Date.now()): boolean {
  return lastTypedAt > 0 && now - lastTypedAt < ms
}

