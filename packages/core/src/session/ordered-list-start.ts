/**
 * A numbered list that starts at another number than 1, right under a line of prose (#2242).
 *
 * CommonMark lets only a list that starts at 1 interrupt a paragraph, so a model's
 *
 *     **#1324 Watches**
 *     2. Should every session be told …
 *        - A: …
 *     3. Who watches the PR checks?
 *
 * is one paragraph with `2.` as plain words in it, and the lines after it are torn out of their item (a bullet list beside
 * the paragraph, then a list starting at 3). A writer cannot be expected to know the rule, so a blank line is put in
 * before such a line when it is read, and the text the person or the store has is left as it was.
 *
 * The line is `N.` or `N)` (N other than 1, up to nine digits as CommonMark has them) with words after it, indented
 * at most three spaces, under a line of prose that sits at the left edge. A year at the start of a sentence
 * (`2024. was the year`) reads as a list under a line of prose, as CommonMark already reads it at the start of a
 * paragraph. Left alone: a list that starts at 1, a line under a blank line, a heading, a rule, a quote, a table row,
 * HTML, a list item (so `2.` after `1.` stays one tight list), an indented line (an item's own continuation), and
 * everything in a fenced block. A line indented four spaces or more is code, and a `>` line is a quote: neither is
 * matched as a list line.
 */
const LIST_START = /^ {0,3}(\d{1,9})[.)][ \t]+\S/
const LIST_ITEM = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const NOT_PROSE = /^(?:[>#|<`~]|(?:[-*_=][ \t]*)+$)/

export function startNumberedLists(text: string): string {
  if (!/\d[.)][ \t]/.test(text)) return text
  let fence = ''
  let changed = false
  let prev = ''
  const out: string[] = []
  for (const line of text.split('\n')) {
    const mark = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1] ?? ''
    if (fence || mark) {
      if (!fence) fence = mark
      else if (mark[0] === fence[0] && mark.length >= fence.length) fence = ''
    } else {
      const start = LIST_START.exec(line)
      if (start && Number(start[1]) !== 1 && /^\S/.test(prev) && !NOT_PROSE.test(prev) && !LIST_ITEM.test(prev)) {
        out.push('')
        changed = true
      }
    }
    out.push(line)
    prev = line
  }
  return changed ? out.join('\n') : text
}
