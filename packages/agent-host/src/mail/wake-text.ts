/**
 * Recognises a mail wake in a read-back conversation (docs/plans/mailbox.md §9.2): the host writes no user row for it, so
 * `read_session` and `recall` must not credit it to the person. Matched by text only Centralu writes: the reminder head and the
 * message header. Apart from `frame.ts` so adapters need not the store; `wake-text.test.ts` reads this and an older frame.
 */

/** The reminder a wake writes, up to its end tag, and the inline messages that follow it (a header line, then its quoted lines) */
const WAKE = new RegExp(
  String.raw`<system-reminder>\s*\[SYSTEM NOTIFICATION - NOT USER INPUT\]\s*This is Centralu's mailbox, NOT a message from the person\.[\s\S]*?</system-reminder>` +
    String.raw`(?:\s*\nMessage [^\n]*?; the person (?:wrote|did not write) it:(?:\r?\n>[^\n]*)*)*`,
  'g',
)

/** `text` without any mail wake in it: what is left is what else the turn held (nothing, for a wake that was sent alone) */
export function stripMailWakes(text: string): string {
  return text.replace(WAKE, '')
}
