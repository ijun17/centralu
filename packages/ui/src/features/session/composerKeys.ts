/**
 * How to read Enter in the composer — only the judgment is pulled out here.
 *
 * Knows neither the DOM nor the store. Because it sits where modifiers (Shift, Cmd/Ctrl), IME
 * state and settings meet, there are eight possible cases, and getting even one of them wrong
 * means the result is "what the person was typing went out half-written" — all eight have to be
 * checkable without opening a browser (the same reason as caret.ts).
 */

/** Only what the judgment needs. Not the whole KeyboardEvent, just these five fields */
export type ComposerKey = {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  /**
   * Whether the IME is currently composing a character.
   *
   * **The caller decides this and passes it in.** It is not computed here because that
   * judgment can only come from reading the native event (`isComposing`) — that one line
   * stays in the composer, and this file only needs to know "do nothing while composing".
   */
  composing: boolean
}

/**
 * Is this key **the send key**?
 *
 * With `sendWithModifierEnter` off, behavior is unchanged: plain Enter sends and Shift+Enter
 * breaks the line. Turning it on does not just swap the two — **Enter always breaks the line**
 * and sending moves to Cmd/Ctrl+Enter.
 *
 * The modifier check accepts either `metaKey || ctrlKey`. This is meant to cover the Mac's Cmd
 * and other keyboards' Ctrl with a single check, so this file never needs to ask which OS it is
 * on (only the label shown on screen is answered by the port — `useShortcut`).
 *
 * While composing (IME), nothing sends, no matter what is pressed. This holds even for someone
 * who turned the setting on: if Cmd+Enter is caught while Hangul is still being composed, it
 * takes away exactly what turning the setting on was supposed to give (not having a half-typed
 * message go out).
 */
export function isComposerSendKey(e: ComposerKey, sendWithModifierEnter: boolean): boolean {
  if (e.composing || e.key !== 'Enter') return false
  if (sendWithModifierEnter) return e.metaKey || e.ctrlKey
  return !e.shiftKey
}

/**
 * Does this key belong to an IME composition (#181)? Depending on the engine, this is signaled
 * either through `isComposing` or only through `key: 'Process'`. Reading the Enter that ends a
 * composition as a submit either saves the text with the last syllable missing or leaves the
 * syllable being composed sitting in the field. Every input field that receives Enter goes
 * through this check — for a while only the session composer knew this and the command palette
 * did not, so the same app had two different rules.
 */
export function composingKey(e: { key: string; isComposing: boolean }): boolean {
  return e.isComposing || e.key === 'Process'
}

/**
 * Is this a plain Enter, not part of a composition (#181) — "save what was typed" for a
 * single-line field
 */
export function isPlainEnter(e: { key: string; isComposing: boolean }): boolean {
  return e.key === 'Enter' && !composingKey(e)
}

