import { mayTakeFocus } from '../../components/offerFocus.js'

/**
 * What a composer asked to take the keyboard does now (#528).
 *
 *  - `wait`: not asked, or asked while something covers the session (a dialog, the palette, the
 *    inbox, settings, an overlay, another panel focused). The request stays: the new-session dialog
 *    asks while it is still closing, and the composer takes the keyboard once it is gone.
 *  - `decline`: asked, but the keys belong elsewhere. An approval card answers y/n/a only while no
 *    field has the keyboard, so a session waiting on one keeps its keys for the card; and a field the
 *    person is already typing in keeps them (`mayTakeFocus`). The request is spent either way.
 *  - `take`: focus moves into the composer.
 */
export type ComposerFocusAnswer = 'take' | 'decline' | 'wait'

export function composerFocusAnswer(x: {
  asked: boolean
  covered: boolean
  approval: boolean
  holder: EventTarget | null
  input: EventTarget | null
}): ComposerFocusAnswer {
  if (!x.asked || x.covered) return 'wait'
  if (x.approval || !mayTakeFocus(x.holder, x.input)) return 'decline'
  return 'take'
}
