import { isTextEntry } from '../app/keys.js'

/**
 * Whether `el` may take the keyboard from whatever holds it now (#528): not from another field the
 * person types in. A field that has the keyboard may be mid-sentence or mid-composition (an IME
 * syllable, #181); moving focus out of it would drop the rest of what they type somewhere else, or
 * end the composition under them. A button, the page itself, or `el` already holding focus are not
 * someone typing.
 */
export function mayTakeFocus(holder: EventTarget | null, el: EventTarget | null): boolean {
  return !holder || holder === el || !isTextEntry(holder)
}

/**
 * Gives `el` the keyboard where the next keystroke goes into it (#528), unless a field the person
 * types in has it (`mayTakeFocus`). Returns whether `el` holds focus afterwards.
 */
export function offerFocus(el: HTMLElement | null, opts?: FocusOptions): boolean {
  if (!el || typeof document === 'undefined') return false
  if (!mayTakeFocus(document.activeElement, el)) return false
  el.focus(opts)
  return document.activeElement === el
}
