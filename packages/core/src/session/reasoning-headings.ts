/**
 * Reasoning summaries stored with their headings run together (#1464).
 *
 * Codex's summary is a `**Heading**` and a paragraph, one per part. Before the host kept two reasoning items apart, the
 * second item's heading was appended to the first with nothing between: `**Checking projects child process****흰 화면…**`,
 * on the screen and in the stored row. New rows are joined with a blank line at the source (`ReasoningParts`); a row
 * stored before that is mended when it is read, and the store is left as it was: nothing is lost by it, and a
 * migration would have to touch every Codex row to fix a display.
 *
 * Only a bold close and a bold open with a word character on each side (`a****b`) is a join: a part's own text
 * does not put four asterisks between two words.
 */
export function splitRunTogetherHeadings(text: string): string {
  return text.includes('****') ? text.replace(/([^\s*])\*\*\*\*(?=[^\s*])/g, '$1**\n\n**') : text
}
