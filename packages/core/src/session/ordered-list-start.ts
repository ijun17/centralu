/**
 * CommonMark lets only a list starting at 1 interrupt a paragraph, so a model's `2. …` under prose is read as words in it
 * (#2242). A blank line is put in before such a line when it is read; the stored text is left as it was.
 */
/*
 * Matched: `N.` or `N)` (N not 1 as written, `01.` too; up to nine digits) with words after, indented at most three spaces,
 * under prose at the left edge (so `2024. was the year` too, as CommonMark reads it at a paragraph's start). Left alone:
 * a line under a blank line, a heading, rule, quote, table row, HTML, a list item or its lazy lines (`2.` after `1.`), an
 * indented line, and fenced blocks.
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
  let prev = ''
  let prevFence = false
  let inList = false
  const out: string[] = []
  for (const line of text.split('\n')) {
    const [, mark = '', info = ''] = FENCE.exec(line) ?? []
    // A fence closes on its mark alone, at least as long; with an info string it is code
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
      // A block whose first line is a list item is a list: its following lines are its own
      if (blockStart) inList = LIST_ITEM.test(line)
    }
    out.push(line)
    prev = line
    prevFence = isFence
  }
  return changed ? out.join('\n') : text
}
