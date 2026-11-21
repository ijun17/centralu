import { isTextEntry } from '../app/keys.js'

/**
 * Whether `el` may take the keyboard from its holder (#528): not from a field the person types in, which may be
 * mid-sentence or mid-composition (#181).
 */
export function mayTakeFocus(holder: EventTarget | null, el: EventTarget | null): boolean {
  return !holder || holder === el || !isTextEntry(holder)
}

/** Focuses `el` unless a text field has the keyboard (#528); whether `el` holds focus afterwards */
export function offerFocus(el: HTMLElement | null, opts?: FocusOptions): boolean {
  if (!el || typeof document === 'undefined') return false
  if (!mayTakeFocus(document.activeElement, el)) return false
  el.focus(opts)
  return document.activeElement === el
}
