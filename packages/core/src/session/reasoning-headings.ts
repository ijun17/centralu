/**
 * Reasoning summaries stored with their headings run together (#1464).
 *
 * Codex's summary is a `**Heading**` and a paragraph, one per part. Before the host kept two reasoning items apart, the
 * second item's heading was appended to the first with nothing between: `**Checking projects child process****흰 화면…**`,
 * on the screen and in the stored row. New rows are joined with a blank line at the source (`ReasoningParts`); a row
 * stored before that is mended when it is read, and the store is left as it was: nothing is lost by it, and a
 * migration would have to touch every Codex row to fix a display.
 *
 * Only a whole bold span with another bold span opening right after it (`**A****B**`) is a join. Four asterisks in
 * prose, a code span or a masked number (`sk-****abcd`, `4111****1111`) have no bold span before them. A paragraph that
 * ends where the next heading starts with nothing between (`text.**Next**`) is the same join, but a bold span after
 * text is also what an author writes, so it is not touched.
 */
export function splitRunTogetherHeadings(text: string): string {
  return text.includes('****') ? text.replace(/(\*\*[^*\n]+\*\*)(?=\*\*[^\s*])/g, '$1\n\n') : text
}
