import { oneLineText } from '@cc/protocol'

/** A line's own marks: a fence, a heading, a quote, a list bullet or number, a task box */
const LINE_MARKS = /^\s*(?:`{3,}|~{3,}|#{1,6}\s+|>\s?|(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?)+/

/**
 * A message body as one line of plain words (#2228): the thread's subject, the Inbox row's preview and a notification's text.
 * The window draws the body itself as Markdown (`MailThread`); here the marks that would show as stray characters in a line
 * are dropped and their words kept: emphasis, code spans, links and images (the text, not the address), headings, quotes and
 * list bullets. A mark counts only where Markdown would read it as one (the word `snake_case` and `2 * 3` keep theirs).
 * Then `oneLineText` makes it one line, cut to `max`.
 */
export function plainLine(body: string, max: number): string {
  const text = body
    .split('\n')
    .map((line) => line.replace(LINE_MARKS, ''))
    .join('\n')
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/`+([^`\n]+?)`+/g, '$1')
    .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, '$1')
    .replace(/(?<![\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])/g, '$1')
  return oneLineText(text, max)
}
