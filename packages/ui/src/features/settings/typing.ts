/**
 * Whether someone is typing in this window, for what would swap it out under their fingers: the window's own automatic apply
 * (apply-update.ts) and an agent's "Apply now" that went with no card (store/updates.ts, #1509). A module of its own so the store
 * can read it without importing the hook file that imports the store.
 */

/**
 * How long after the last keystroke in a text field the window counts as "someone is typing". A
 * relaunch reloads the window; the composer keeps a draft, but a sentence half typed into a dialog
 * would be lost, and a window swapping itself out under someone's fingers reads as a crash.
 */
export const TYPING_QUIET_MS = 20_000

/*
 * Typing, seen from the window: the last keydown in an editable field. One capture listener for
 * the whole window, installed on first use; cheap enough to leave on.
 */
let lastTypedAt = 0
let typingTracked = false
function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  return t.isContentEditable || t.tagName === 'TEXTAREA' || (t instanceof HTMLInputElement && t.type !== 'checkbox')
}
export function trackTyping(): void {
  if (typingTracked || typeof window === 'undefined') return
  typingTracked = true
  const mark = (e: Event) => {
    if (isEditable(e.target)) lastTypedAt = Date.now()
  }
  window.addEventListener('keydown', mark, true)
  window.addEventListener('compositionupdate', mark, true)
}
export function typedWithin(ms: number, now = Date.now()): boolean {
  return lastTypedAt > 0 && now - lastTypedAt < ms
}

