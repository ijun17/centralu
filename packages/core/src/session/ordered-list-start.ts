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
 * The line is `N.` or `N)` (N other than 1 as it is written, so `01.` too; up to nine digits as CommonMark has them) with
 * words after it, indented at most three spaces, under a line of prose that sits at the left edge. A year at the start of a
 * sentence (`2024. was the year`) reads as a list under a line of prose, as CommonMark already reads it at the start of a
 * paragraph. Left alone: a list that starts at 1, a line under a blank line, a heading, a rule, a quote, a table row, HTML,
 * a list item or the lazy lines of one (so `2.` after `1.` stays one tight list), an indented line (an item's own
 * continuation), and everything in a fenced block. A line indented four spaces or more is code, and a `>` line is a quote:
 * neither is matched as a list line.
 */
const LIST_START = /^ {0,3}(\d{1,9})[.)][ \t]+\S/
const ANY_LIST_START = /^ {0,3}\d{1,9}[.)][ \t]+\S/m
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const NOT_PROSE = /^(?:[>|<]|#{1,6}(?:[ \t]|$)|(?:[-*_=][ \t]*)+$)/
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/

export function startNumberedLists(text: string): string {
  if (!ANY_LIST_START.test(text)) return text
  let fence = ''
  let changed = false
  // The line above, whether it was a fence line, and whether the block it is in began as a list item
  let prev = ''
  let prevFence = false
  let inList = false
  const out: string[] = []
  for (const line of text.split('\n')) {
    const [, mark = '', info = ''] = FENCE.exec(line) ?? []
    // A fence closes on its mark alone, at least as long; with an info string it is another opening line, which is code
    const closes = fence !== '' && mark[0] === fence[0] && mark.length >= fence.length && info.trim() === ''
    const opens = mark !== '' && !(mark[0] === '`' && info.includes('`'))
    const isFence = fence !== '' || opens
    if (fence) {
      if (closes) fence = ''
    } else if (opens) {
      fence = mark
    }
    if (isFence) {
      inList = false
    } else {
      let blockStart = prev.trim() === ''
      const start = LIST_START.exec(line)
      if (!blockStart && start && start[1] !== '1' && /^\S/.test(prev) && !prevFence && !inList && !NOT_PROSE.test(prev)) {
        out.push('')
        changed = true
        blockStart = true
      }
      // A block is a list when its first line is a list item: the lines it goes on with are that list's own
      if (blockStart) inList = LIST_ITEM.test(line)
    }
    out.push(line)
    prev = line
    prevFence = isFence
  }
  return changed ? out.join('\n') : text
}
