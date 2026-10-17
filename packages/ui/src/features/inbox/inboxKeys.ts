import { composingKey, letterOf } from '../../app/keys.js'
import { isCovered, type CoveringLayers } from '../../store/layers.js'

export type InboxKeyAction = 'down' | 'up' | 'open' | 'done' | 'allow' | 'deny' | 'close'

/**
 * What a key does in the open waiting list (a pure function: tests attach here). The list listens on the window, so
 * this is the whole rule for when a key is the list's, the same guards the approval card's keys have
 * (`approvalKeyAction`, #683 review):
 *
 * - **Not while something covers the list.** ⌘K over the open list put the palette's field on top; the list still
 *   heard the window's keys, so typing `yarn` allowed the command under the cursor (reproduced), and Enter or Esc
 *   meant for the palette opened or closed the list.
 * - **Not while a field has the keyboard**, nor on a key an input method is composing with (a Korean ㅛ is a `y`).
 * - **y and n**, which answer an approval, take no modifier at all and no held key: a repeat would answer the row that
 *   slides under the cursor next.
 * - **Enter on a focused button or link is that control's** (#842 item 2), as on the quit dialog (`confirmKeyAction`):
 *   the list opened the row under its cursor instead, and its preventDefault kept Done, Continue, Allow and Deny from
 *   pressing at all.
 */
export function inboxKeyAction(
  e: Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'> &
    Partial<Pick<KeyboardEvent, 'isComposing' | 'keyCode' | 'repeat'>>,
  ctx: { typing: boolean; covered: boolean; onButton?: boolean },
): InboxKeyAction | null {
  if (ctx.covered || ctx.typing) return null
  if (composingKey({ key: e.key, isComposing: !!e.isComposing, keyCode: e.keyCode ?? 0 })) return null
  if (e.key === 'Escape') return 'close'
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  if (e.key === 'ArrowDown') return 'down'
  if (e.key === 'ArrowUp') return 'up'
  if (e.key === 'Enter') return ctx.onButton ? null : 'open'
  // A letter is read by meaning: on a Korean layout j, k, d, y and n arrive as ㅓ, ㅏ, ㅇ, ㅛ and ㅜ (app/keys.ts)
  const letter = letterOf(e)
  if (letter === 'y' || letter === 'n') return e.shiftKey || e.repeat ? null : letter === 'y' ? 'allow' : 'deny'
  if (e.shiftKey) return null
  if (letter === 'j') return 'down'
  if (letter === 'k') return 'up'
  if (letter === 'd') return 'done'
  return null
}

/** Whether another layer stands over the waiting list: a modal, the palette, settings, usage, an overlay */
export function inboxCovered(st: CoveringLayers): boolean {
  return isCovered(st, 'inbox')
}

/** Whether a key press lands in a field that takes text */
export function typingTarget(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null
  return !!t && (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.isContentEditable)
}

/** Whether a key press lands on a control that presses itself on Enter: a button or a link */
export function buttonTarget(target: EventTarget | null): boolean {
  const t = target as HTMLElement | null
  return !!t && typeof t.closest === 'function' && t.closest('button, a[href], [role="button"]') !== null
}
