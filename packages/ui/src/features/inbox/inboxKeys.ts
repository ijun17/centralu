import { composingKey, letterOf } from '../../app/keys.js'
import { isCovered, type CoveringLayers } from '../../store/layers.js'

export type InboxKeyAction = 'down' | 'up' | 'open' | 'done' | 'allow' | 'deny' | 'choose' | 'close'

/**
 * What a key does in the open waiting list, which listens on the window: the whole rule, with the approval card's
 * guards (`approvalKeyAction`, #683).
 * - Not while something covers the list: under the palette, typing `yarn` allowed the cursor's command (reproduced).
 * - Not while a field has the keyboard, nor on a key an input method composes with (a Korean ㅛ is a `y`).
 * - y and n take no modifier and no repeat: a held key would answer the row sliding under the cursor next.
 * - 1 to 6 press that choice on the cursor's card (#2229, up to six), with no modifier and no repeat.
 * - Enter on a focused button or link is that control's (#842 item 2, as `confirmKeyAction`): taking it would keep
 *   Done, Continue, Allow and Deny from pressing at all.
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
  if (/^[1-6]$/.test(e.key)) return e.shiftKey || e.repeat ? null : 'choose'
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

