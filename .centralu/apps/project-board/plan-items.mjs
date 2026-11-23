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
// Numbered lines are as often facts, causes, options, a bug's steps or a plan's rules: only those under a heading of work are planned
const WORK = /pull requests?|\bPRs?\b|\bsteps\b|work units?|follow-?ups?|\blater\b|\bphases\b|what is left|\bproposals?\b|\bto ?do\b|\bfix(?:es)?\b|\bplan\b|\bchanges\b|\bscope\b|what to do/i
// …but not alternatives to pick from (one is built, the rest are not left over), nor a bug's steps to reproduce it
const CHOICE = /pick one|\boptions?\b|alternatives|\beither\b|to reproduce|\brepro\b/i

const firstCell = (row) => row.replace(TABLE_ROW, '').split('|')[0].replace(/[*_`]/g, '').trim()

/** The fenced block open after `line` (its marker, or null), given the one open before it. */
function fenceAfter(fence, line) {
  const f = FENCE.exec(line)
  if (!f || (fence && (f[1][0] !== fence[0] || f[1].length < fence.length))) return fence
  return fence ? null : f[1]
}

/**
 * The items a Markdown text plans, in order: task-list boxes, and under a heading of work its numbered lines and the numbered rows
 * of a table of work. Each is `{ text, state, where }`; `text` takes the item's indented continuation lines. Fenced code and HTML
 * comments are not read.
 */
export function planItems(markdown, source = 'the body') {
  const items = []
  let heading = ''
  let fence = null
  let last = null
  let prev = ''
  let workTable = false
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?-->/g, '').split('\n')
  for (const line of lines) {
    const next = fenceAfter(fence, line)
    if (fence || next) {
      fence = next
      last = null
      continue
    }
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
    const work = WORK.test(heading) && !CHOICE.test(heading)
    const numbered = !task && work ? NUMBERED.exec(line) : null
    const row = !task && !numbered && work && workTable && /^\d/.test(firstCell(line)) ? line : null
    if (task || numbered || row) {
      last = { text: (task?.[2] ?? numbered?.[0] ?? row).trim(), ticked: task ? task[1] !== ' ' : false, where: heading ? `${source}, "${heading}"` : source }
      items.push(last)
    } else if (last && /^\s+\S/.test(line) && !/^\s*[-*+]\s/.test(line)) last.text += ` ${line.trim()}`
    else last = null
  }
  return items.map(({ ticked, ...i }) => ({ ...i, state: itemState(i.text, ticked) }))
}

// A plan named in an issue (docs/plans/<name>.md, a link or an address of it), and the section it cites, if any: §n, #anchor or
// "Heading", one section per citation
const NAMED = new RegExp(String.raw`(?:^|[^\w.-])(?:[\w.-]+/)*${PLANS.split('/').at(-1)}/([\w.-]+\.md)(?:#([\w-]+)|\s*§\s*(\d+(?:\.\d+)*)|\s+"([^"\n]+)")?`, 'g')

/** The plan sections a text cites, once each (`{ file, section }`, where `section` is `§n`, `#anchor` or `"Heading"`), and the plans it names with no section cited. */
export function citedPlans(text) {
  const cited = new Map()
  const named = new Set()
  for (const m of String(text ?? '').matchAll(NAMED)) {
    if (!m[2] && !m[3] && !m[4]) named.add(m[1])
    else {
      const section = m[2] ? `#${m[2]}` : m[3] ? `§${m[3]}` : `"${m[4]}"`
      cited.set(`${m[1]} ${section}`, { file: m[1], section })
    }
  }
  const sections = [...cited.values()]
  return { sections, bare: [...named].filter((f) => !sections.some((c) => c.file === f)) }
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
    const next = fenceAfter(fence, line)
    const h = fence || next ? null : HEADING.exec(line)
    fence = next
    if (!h) continue
    if (start >= 0 && h[1].length <= level) return lines.slice(start, i).join('\n')
    if (start < 0 && named(h[2])) [start, level] = [i, h[1].length]
  }
  return start >= 0 ? lines.slice(start).join('\n') : null
}
