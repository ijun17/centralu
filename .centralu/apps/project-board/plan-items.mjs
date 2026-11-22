// The items an issue plans, and where each went (#2488): what close_issue and queue_merge hold an issue's closing to (pure).
import { headingKey, itemState } from './rules.mjs'

const TASK = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/
// A table row whose first cell starts with a number: a plan's step table, or an umbrella's work units
const ROW = /^\s*\|\s*(\d+)\b[^|]*\|/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
// Numbered lines here are how to see a bug, not work planned
const NOT_PLANS = /reproduc|how to get there/i

/**
 * The items a Markdown text plans, in order: task-list boxes anywhere, numbered lines (but under a heading on how to reproduce),
 * and table rows whose first cell is a number. Each is `{ text, state, where }`; `text` takes the item's indented continuation lines.
 * Fenced code and HTML comments are not read.
 */
export function planItems(markdown, source = 'the body') {
  const items = []
  let heading = ''
  let fenced = false
  let last = null
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n')
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced
      last = null
      continue
    }
    if (fenced) continue
    const h = HEADING.exec(line)
    if (h) {
      heading = h[2]
      last = null
      continue
    }
    const task = TASK.exec(line)
    const numbered = !task && !NOT_PLANS.test(heading) ? NUMBERED.exec(line) : null
    const row = !task && !numbered && ROW.test(line) ? line : null
    if (task || numbered || row) {
      last = { text: (task?.[2] ?? numbered?.[0] ?? row).trim(), ticked: task ? task[1] !== ' ' : false, where: heading ? `${source}, "${heading}"` : source }
      items.push(last)
    } else if (last && /^\s+\S/.test(line) && !/^\s*[-*+]\s/.test(line)) last.text += ` ${line.trim()}`
    else last = null
  }
  return items.map(({ ticked, ...i }) => ({ ...i, state: itemState(i.text, ticked) }))
}

// A plan's section cited in an issue: docs/plans/<name>.md §n, …#anchor or … "Heading" (the forms guard/doc-refs reads)
const CITED = /(?:^|[^\w.-])(?:[\w.-]+\/)*plans\/([\w.-]+\.md)(?:#([\w-]+)|\s*§\s*(\d+(?:\.\d+)*)|\s+"([^"\n]+)")/g

/** The plan sections a text cites, once each: `{ file, section }`, where `section` is `§n`, `#anchor` or `"Heading"`. */
export function citedPlans(text) {
  const out = new Map()
  for (const m of String(text ?? '').matchAll(CITED)) {
    const section = m[2] ? `#${m[2]}` : m[3] ? `§${m[3]}` : `"${m[4]}"`
    out.set(`${m[1]} ${section}`, { file: m[1], section })
  }
  return [...out.values()]
}

// GitHub's anchor for a heading: lower case, punctuation but hyphens out, spaces to hyphens
const anchorOf = (heading) => heading.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-')

/** The text of a plan's section (its heading to the next heading of its level or above), or null when it has none. */
export function planSection(markdown, section) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  const named = (title) => {
    if (section.startsWith('§')) return new RegExp(`^§?${section.slice(1).replace(/\./g, '\\.')}(?:[.)]|\\s|$)`).test(title)
    if (section.startsWith('#')) return anchorOf(title) === section.slice(1).toLowerCase()
    const want = headingKey(section.slice(1, -1))
    return headingKey(title) === want || headingKey(title.replace(/^§?\d+(?:\.\d+)*[.)]?\s*/, '')) === want
  }
  let fenced = false
  let level = 0
  let start = -1
  for (const [i, line] of lines.entries()) {
    if (/^\s*(?:```|~~~)/.test(line)) fenced = !fenced
    const h = fenced ? null : HEADING.exec(line)
    if (!h) continue
    if (start >= 0 && h[1].length <= level) return lines.slice(start, i).join('\n')
    if (start < 0 && named(h[2])) [start, level] = [i, h[1].length]
  }
  return start >= 0 ? lines.slice(start).join('\n') : null
}
