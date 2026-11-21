/** The composer's keys, out of the DOM: modifiers, IME state and the setting make eight cases a test holds */

export type ComposerKey = {
  key: string
  shiftKey: boolean
  metaKey: boolean
  ctrlKey: boolean
  /** Read from the native event by the caller (`composingKey`) */
  composing: boolean
}

/**
 * With `sendWithModifierEnter`, Enter always breaks the line and Cmd or Ctrl+Enter sends; either
 * modifier, so no OS is asked. Nothing sends while an IME composes, the setting on or not.
 */
export function isComposerSendKey(e: ComposerKey, sendWithModifierEnter: boolean): boolean {
  if (e.composing || e.key !== 'Enter') return false
  if (sendWithModifierEnter) return e.metaKey || e.ctrlKey
  return !e.shiftKey
}

export type AutocompleteKeyAction = 'down' | 'up' | 'close' | 'pick'

/**
 * Shift+Tab is not a pick (#842 item 12): it moves focus back, away from the suggestion. Shift+Enter
 * breaks the line, as with the list closed.
 */
export function autocompleteKeyAction(e: Pick<KeyboardEvent, 'key' | 'shiftKey'>): AutocompleteKeyAction | null {
  if (e.key === 'ArrowDown') return 'down'
  if (e.key === 'ArrowUp') return 'up'
  if (e.key === 'Escape') return 'close'
  if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) return 'pick'
  return null
}
