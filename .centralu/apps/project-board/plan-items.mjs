// The items an issue plans, and where each went (#2488): what close_issue and queue_merge hold an issue's closing to (pure).
import { headingKey, itemState } from './rules.mjs'

/** Where a repository keeps its plans; an issue cites a section of one by this path */
export const PLANS = 'docs/plans'

const TASK = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/
const NUMBERED = /^\s*(\d+)[.)]\s+(.*)$/
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/
const FENCE = /^\s*(`{3,}|~{3,})/
const TABLE_ROW = /^\s*\|/
const TABLE_RULE = /^\s*\|[\s:|-]+\|\s*$/
// A table of work: its first column is the step, unit or pull request ("| # | Area | What | Issue |", "| Step | What | Lands |")
const WORK_TABLE = /^(?:#|no\.?|steps?|units?|prs?|pull requests?|items?|phases?|parts?)$/i
// Numbered lines here are how to see a bug, not work planned
const NOT_PLANS = /reproduc|how to get there/i
// In a plan, numbered lines are as often rules, facts or the steps of an algorithm: only those under a heading of work count
const PLAN_WORK = /pull requests?|\bPRs?\b|\bsteps\b|work units?|follow-?ups?|\blater\b|\bphases\b|what is left/i

const firstCell = (row) => row.replace(TABLE_ROW, '').split('|')[0].replace(/[*_`]/g, '').trim()

/**
 * The items a Markdown text plans, in order: task-list boxes; numbered lines (in an issue's body, but under a heading on how to
 * reproduce; in a plan's section, only under a heading of work); and the numbered rows of a table of work. Each is
 * `{ text, state, where }`; `text` takes the item's indented continuation lines. Fenced code and HTML comments are not read.
 */
export function planItems(markdown, source = 'the body', { plan = false } = {}) {
  const items = []
  let heading = ''
  let fence = null
  let last = null
  let prev = ''
  let workTable = false
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n')
  for (const line of lines) {
    const f = FENCE.exec(line)
    if (f && (!fence || (f[1][0] === fence[0] && f[1].length >= fence.length))) {
      fence = fence ? null : f[1]
      last = null
      continue
    }
    if (fence) continue
    const h = HEADING.exec(line)
    if (h) {
      heading = h[2]
      last = null
      continue
    }
    if (!TABLE_ROW.test(line)) workTable = false
    else if (TABLE_RULE.test(line) && TABLE_ROW.test(prev)) workTable = WORK_TABLE.test(firstCell(prev))
    prev = line
    const task = TASK.exec(line)
    const numbers = plan ? PLAN_WORK.test(heading) : !NOT_PLANS.test(heading)
    const numbered = !task && numbers ? NUMBERED.exec(line) : null
    const row = !task && !numbered && workTable && /^\d/.test(firstCell(line)) ? line : null
    if (task || numbered || row) {
      last = { text: (task?.[2] ?? numbered?.[0] ?? row).trim(), ticked: task ? task[1] !== ' ' : false, where: heading ? `${source}, "${heading}"` : source }
      items.push(last)
    } else if (last && /^\s+\S/.test(line) && !/^\s*[-*+]\s/.test(line)) last.text += ` ${line.trim()}`
    else last = null
  }
  return items.map(({ ticked, ...i }) => ({ ...i, state: itemState(i.text, ticked) }))
}

// A plan's section cited in an issue: docs/plans/<name>.md §n, …#anchor or … "Heading", one section per citation
const CITED = new RegExp(String.raw`(?:^|[^\w.-])(?:[\w.-]+/)*${PLANS.split('/').at(-1)}/([\w.-]+\.md)(?:#([\w-]+)|\s*§\s*(\d+(?:\.\d+)*)|\s+"([^"\n]+)")`, 'g')

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
// A heading's number: "13" of "13. The pull requests", "3.1" of "3.1 Detail"
const NUMBER = /^§?(\d+(?:\.\d+)*)\.?(?:[\s)]|$)/

/** The text of a plan's section (its heading to the next heading of its level or above), or null when it has none. */
export function planSection(markdown, section) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n')
  const named = (title) => {
    if (section.startsWith('§')) return NUMBER.exec(title)?.[1] === section.slice(1)
    if (section.startsWith('#')) return anchorOf(title) === section.slice(1).toLowerCase()
    const want = headingKey(section.slice(1, -1))
    return headingKey(title) === want || headingKey(title.replace(NUMBER, '')) === want
  }
  let fence = null
  let level = 0
  let start = -1
  for (const [i, line] of lines.entries()) {
    const f = FENCE.exec(line)
    if (f && (!fence || (f[1][0] === fence[0] && f[1].length >= fence.length))) fence = fence ? null : f[1]
    const h = fence || f ? null : HEADING.exec(line)
    if (!h) continue
    if (start >= 0 && h[1].length <= level) return lines.slice(start, i).join('\n')
    if (start < 0 && named(h[2])) [start, level] = [i, h[1].length]
  }
  return start >= 0 ? lines.slice(start).join('\n') : null
}
