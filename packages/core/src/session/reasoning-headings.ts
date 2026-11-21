/**
 * Codex summary rows stored before #1464 run headings together (`**A****B**`); mended when read, as a migration would
 * touch every Codex row to fix a display. New rows are joined with a blank line at the source (`ReasoningParts`).
 */
/*
 * Only in prose, not code. Skipped when a digit or one of `-_@/+=#` touches the four asterisks (a masked key, card
 * number or address: `**sk-****abcd**`). A letters-only mask (`**tok****en**`) cannot be told apart and is split;
 * `text.**Next**` is left, since an author writes bold after text too.
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
      // A fence closes on the same mark, at least as long
      if (fence || mark) {
        if (!fence) fence = mark
        else if (mark[0] === fence[0] && mark.length >= fence.length) fence = ''
        return line
      }
      // Pieces of three: prose, the code span, its backticks
      return line
        .split(/((`+)[^`]*?\2)/)
        .map((p, i) => (i % 3 ? (i % 3 === 1 ? p : '') : p.replace(JOIN, (all, a: string, z: string, n: string) => (MASK.test(z) || MASK.test(n) ? all : `${a}${z}**\n\n`))))
        .join('')
    })
    .join('\n')
}
