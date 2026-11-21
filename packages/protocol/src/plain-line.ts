import { oneLineText } from './app-frames.js'

/** A line's own marks: a fence, a heading, a quote, a list bullet or number, a task box */
const LINE_MARKS = /^\s*(?:`{3,}|~{3,}|#{1,6}\s+|>\s?|(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?)+/

/**
 * A Markdown body as one line of plain words (#2228), for a subject, a preview or a notification. A link keeps its
 * text, not its address; a mark counts only where Markdown reads one (`snake_case` and `2 * 3` keep theirs).
 */
export function plainLine(body: string, max: number): string {
  return oneLineText(plainText(body), max)
}

export function sentenceStart(words: string): string {
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** The lines kept, for a question's card */
export function plainLines(body: string, lines: number, max: number): string {
  const text = plainText(body)
    .split('\n')
    .map((l) => oneLineText(l))
    .filter((l) => l !== '')
    .slice(0, lines)
    .join('\n')
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function plainText(body: string): string {
  return body
    .split('\n')
    .map((line) => line.replace(LINE_MARKS, ''))
    .join('\n')
    .replace(/!?\[([^\]\n]*)\]\([^)\n]*\)/g, '$1')
    .replace(/`+([^`\n]+?)`+/g, '$1')
    .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, '$2')
    .replace(/(?<![\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?![\w*])/g, '$1')
    .replace(/(?<![\w_])_(?=\S)([^_\n]+?)(?<=\S)_(?![\w_])/g, '$1')
}
