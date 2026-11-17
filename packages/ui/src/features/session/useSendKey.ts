import type { KeyboardEvent } from 'react'
import { composingKey } from '../../app/keys.js'
import { useStore } from '../../store/store.js'
import { isComposerSendKey } from './composerKeys.js'

/**
 * The send key of a field that sends what was typed, by the session composer's rule (`isComposerSendKey`, #180) and the person's
 * setting: Enter sends, or Cmd/Ctrl+Enter for someone who turned that on, and a key an input method is composing with never does.
 * The returned check is true for the key that sends, whose default (a new line) it has stopped; the caller sends. The Assistant's box,
 * an app's fix bar, a mail thread's reply box and a question card's field each read the key this one way (#2327); the session composer
 * reads it with its autocomplete first.
 */
export function useSendKey(): (e: KeyboardEvent) => boolean {
  const sendWithModifierEnter = useStore((s) => s.prefs.sendWithModifierEnter)
  return (e) => {
    const key = { key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, composing: composingKey(e.nativeEvent) }
    if (!isComposerSendKey(key, sendWithModifierEnter)) return false
    e.preventDefault()
    return true
  }
}
