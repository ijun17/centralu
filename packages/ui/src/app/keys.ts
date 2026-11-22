import { isRecord } from '@cc/protocol/client'

/** A window listener passes the `KeyboardEvent` itself, a React handler `e.nativeEvent` */
export type ImeKey = { key: string; isComposing: boolean; keyCode: number }

/**
 * Does this key belong to an IME composition (#181)? Each signal alone misses a case: `isComposing`;
 * `key: 'Process'` (Chromium on Windows); `keyCode: 229` (WebKit, WKWebView included, ends the composition
 * before it dispatches the Enter that ended it, so that keydown has `isComposing` false and `key: 'Enter'`).
 * Every Enter, Escape or arrow handler where text can be typed goes through this one check:
 * docs/usability.md "Principles and decisions".
 */
export function composingKey(e: ImeKey): boolean {
  return e.isComposing || e.key === 'Process' || e.keyCode === 229
}

export function isPlainEnter(e: ImeKey): boolean {
  return e.key === 'Enter' && !composingKey(e)
}

export function isPlainEscape(e: ImeKey): boolean {
  return e.key === 'Escape' && !composingKey(e)
}

/**
 * The Latin letter a key press points to: `e.key` when it is one, else the physical `e.code`. On a Mac
 * (UCKeyTranslate) ⌥A gives 'å' on ABC and A gives 'ㅁ' on 2-Set Korean, so `e.key` alone misses ⌥a and every
 * letter while typing Korean. Not `e.code` alone: on Dvorak 'y' (approve) sits at `KeyF`.
 */
export function letterOf(e: Pick<KeyboardEvent, 'key' | 'code'>): string | null {
  const key = e.key.toLowerCase()
  if (/^[a-z]$/.test(key)) return key
  const spot = /^Key([A-Z])$/.exec(e.code)
  return spot ? spot[1]!.toLowerCase() : null
}

/** Arrow keys and Enter inside a field that accepts text belong to the field (#181) */
export function isTextEntry(target: EventTarget | null): boolean {
  // The fields are read unchecked: tests hand in plain objects, and a window's own target has none of them
  if (!isRecord(target) || typeof target.tagName !== 'string') return false
  const tag = target.tagName
  if (target.isContentEditable === true || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag !== 'INPUT') return false
  const type = (typeof target.type === 'string' && target.type ? target.type : 'text').toLowerCase()
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type)
}

export function pressesItself(target: EventTarget | null): boolean {
  return isRecord(target) && typeof target.closest === 'function' && target.closest.call(target, 'button, a[href], [role="button"]') !== null
}

/**
 * A key in the quit confirmation (#181): a composing key means nothing, and Enter on a button (Tab to
 * Cancel, then Enter) belongs to the button, never quit.
 */
export function confirmKeyAction(e: ImeKey & { onButton: boolean }): 'confirm' | 'cancel' | null {
  if (composingKey(e)) return null
  if (e.key === 'Escape') return 'cancel'
  if (e.key === 'Enter' && !e.onButton) return 'confirm'
  return null
}

/**
 * Back (-1) or forward (1) between screens: docs/state-management.md §5a. The ui does not know its OS, so
 * ⌘[ ⌘] and Alt+← Alt+→ both work everywhere; exact modifiers only, so ⌘⇧[ or Ctrl+Alt+← keep their meaning. Never
 * in a text field (xterm's input is a textarea), where Alt+← moves by word and ⌘[ outdents.
 */
export function navKeyOf(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'target'>,
): -1 | 1 | null {
  if (e.isComposing || e.shiftKey || e.ctrlKey || isTextEntry(e.target)) return null
  if (e.metaKey && !e.altKey) {
    if (e.code === 'BracketLeft' || e.key === '[') return -1
    if (e.code === 'BracketRight' || e.key === ']') return 1
  }
  if (e.altKey && !e.metaKey) {
    if (e.key === 'ArrowLeft') return -1
    if (e.key === 'ArrowRight') return 1
  }
  return null
}

export function navButtonOf(button: number): -1 | 1 | null {
  return button === 3 ? -1 : button === 4 ? 1 : null
}

