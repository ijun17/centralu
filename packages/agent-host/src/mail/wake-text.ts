/**
 * Recognises a mail wake in a conversation read back from the tool (docs/plans/mailbox.md §9.2).
 *
 * A delivery is the CLI's input, and the tool keeps it in its record as a user turn: the reminder, then the inline messages
 * behind it (`mailFrame`). The host writes no user row for it and shows a compact line instead, so a record read back
 * (the catch-up at a wake, an import) must not make it the person's words: `read_session` and `recall` would attribute
 * what a session wrote to them. The read-back takes it out, whole, and the line the delivery left stays the only trace.
 *
 * The text is matched by what Centralu wrote and nobody else can write: the reminder's fixed head, and the inline
 * messages' fixed header with every body line behind `> `. This file stands apart from `frame.ts` so the adapters can use it
 * without the store; `wake-text.test.ts` builds real frames and reads them back, so a change to the frame that this does
 * not follow fails there.
 */

/** The reminder `mailFrame` writes, up to its end tag, and the inline messages that follow it (a header line, then its quoted lines) */
const WAKE = new RegExp(
  String.raw`<system-reminder>\s*\[SYSTEM NOTIFICATION - NOT USER INPUT\]\s*This is Centralu's mailbox, NOT a message from the person\.[\s\S]*?</system-reminder>` +
    String.raw`(?:\s*\nMessage [^\n]*?; the person (?:wrote|did not write) it:(?:\r?\n>[^\n]*)*)*`,
  'g',
)

/** `text` without any mail wake in it: what is left is what else the turn held (nothing, for a wake that was sent alone) */
export function stripMailWakes(text: string): string {
  return text.replace(WAKE, '')
}
