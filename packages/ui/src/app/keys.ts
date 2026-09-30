/**
 * The Latin letter a key press points to. null if there is none.
 *
 * Letter shortcuts (y/n/a, j/k/d) used to look only at `e.key`. That value is the character the
 * keyboard actually produced, so the comparison goes wrong entirely the moment someone is not on
 * a Latin layout or a modifier key changes the character. These values were asked directly of the
 * installed layout (UCKeyTranslate):
 *
 *   ABC / U.S.     A = a    ⌥A = å
 *   2-Set Korean   A = ㅁ   ⌥A = a
 *
 * So the `⌥a` the settings screen advertised ("always allow — project scope") did nothing at all
 * on a Mac, because `'å' === 'a'` is false. On Linux and Windows, Alt does not change the
 * character, so it worked fine there — meaning it was dead only on the platform this app runs on
 * every day. For the same reason, while typing Korean, y/n/a/j/k/d all arrive as different
 * characters entirely.
 *
 * The rule: only ask for the key's physical position when the character is not a Latin letter.
 *
 * Why this does not standardize on `e.code` (the physical position) instead: Dvorak. On Dvorak,
 * 'y' sits at QWERTY's `KeyF` position, so reading position alone would read 'y' when the person
 * pressed 'f' — and 'y' is approval in this app. The thing that must never be misread cannot be
 * misread just because of a keyboard layout. Conversely, when a character arrives as a Latin
 * letter, that is the actual character the person produced, so it can simply be trusted. Position
 * is only checked when the character is not Latin — that is, only when a layout or a modifier key
 * has swapped out the character and position is the only thing left that can carry intent.
 */
export function letterOf(e: Pick<KeyboardEvent, 'key' | 'code'>): string | null {
  const key = e.key.toLowerCase()
  if (/^[a-z]$/.test(key)) return key
  // Only looks at `KeyA` through `KeyZ`. `Digit1` or `Enter` are not letters, and must not be
  // treated as if they were
  const spot = /^Key([A-Z])$/.exec(e.code)
  return spot ? spot[1]!.toLowerCase() : null
}

/**
 * Is this a field that accepts text (#181) — the arrow keys and Enter inside that field belong to
 * the field. An input like a checkbox or a button does not accept text.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string') return false
  if (el.isContentEditable || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true
  if (el.tagName !== 'INPUT') return false
  const type = ((el as HTMLInputElement).type || 'text').toLowerCase()
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file'].includes(type)
}

/**
 * What a single key press means in a confirmation dialog (quit confirmation) (#181) — a pure
 * function, so it is tested without a browser.
 *
 *  - A key that is part of an IME composition means nothing. If the dialog appeared while typing
 *    Korean, an Enter pressed to finish the composition used to quit the app, and an Esc pressed
 *    to cancel the composition used to close the dialog.
 *  - Enter on a button belongs to that button — pressing Enter after Tab-ing to Cancel must not
 *    become quit (the button presses itself).
 *  - Any other Enter confirms, Esc cancels.
 */
export function confirmKeyAction(e: { key: string; isComposing: boolean; onButton: boolean }): 'confirm' | 'cancel' | null {
  if (e.isComposing || e.key === 'Process') return null
  if (e.key === 'Escape') return 'cancel'
  if (e.key === 'Enter' && !e.onButton) return 'confirm'
  return null
}

