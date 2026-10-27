/**
 * Reasoning summaries stored with their headings run together (#1464).
 *
 * Codex's summary is a `**Heading**` and a paragraph, one per part. Before the host kept two reasoning items apart, the
 * second item's heading was appended to the first with nothing between: `**Checking projects child process****흰 화면…**`,
 * on the screen and in the stored row. New rows are joined with a blank line at the source (`ReasoningParts`); a row
 * stored before that is mended when it is read, and the store is left as it was: nothing is lost by it, and a
 * migration would have to touch every Codex row to fix a display.
 *
 * Only a whole bold span with another bold span opening right after it (`**A****B**`) is a join, and only in prose: a
 * code span or a fenced block is left alone. The join is skipped when a digit or one of `-_@/+=#` touches the four
 * asterisks on either side (`**sk-****abcd**`, `**4111****1111**`, `**jo****@x.com**`): that is how a masked key, card
 * number or address looks, and a heading does not end or start like it. Two bold words cannot be told from a mask made
 * of letters only (`**tok****en**`), so those are split; a heading ending in a digit (`**Step 2****Next**`) stays
 * joined, as it was. A paragraph that ends where the next heading starts (`text.**Next**`) is the same join, but a bold
 * span after text is also what an author writes, so it is not touched.
 */
const MASK = /[\p{N}\-_@/+=#]/u
const JOIN = /(\*\*[^*\n]*?)([^*\n])\*\*(?=\*\*([^\s*]))/gu

export function splitRunTogetherHeadings(text: string): string {
  if (!text.includes('****')) return text
  let fence = ''
  return text
    .split('\n')
    .map((line) => {
      const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? ''
      // A fence closes on the same mark, at least as long; the fence lines and what is inside are code
      if (fence || mark) {
        if (!fence) fence = mark
        else if (mark[0] === fence[0] && mark.length >= fence.length) fence = ''
        return line
      }
      // The split keeps each code span (piece 1 of three, piece 2 its backticks): only piece 0 is prose
      return line
        .split(/((`+)[^`]*?\2)/)
        .map((p, i) => (i % 3 ? (i % 3 === 1 ? p : '') : p.replace(JOIN, (all, a: string, z: string, n: string) => (MASK.test(z) || MASK.test(n) ? all : `${a}${z}**\n\n`))))
        .join('')
    })
    .join('\n')
}
