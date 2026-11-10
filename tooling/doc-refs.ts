/**
 * `guard/doc-refs`: a reference to a section of a document points at a section that exists (#2179 step 2).
 *
 * Two forms, in any tracked text file (a code comment, a string, a document):
 *   - `<doc> §4.5`, `docs/plans/mailbox.md §10.1`, `x.md §3 and §4`: section 4.5 exists in that document (a numbered heading, or an item of a numbered list under heading 4);
 *   - `docs/releasing.md "Host-only packages"`: a heading or a bold lead-in of that document starts with the quoted text.
 * A bare name (`architecture §6.2`) counts when it is the name of a document under docs/ or at the root; other words
 * before a `§` (`plan §4`, which means the plan the comment sits in) are not read. A name written with `.md` that no document
 * has is a finding too. Documents may be files today and folders tomorrow: a name is looked up by its file name anywhere
 * under docs/, so a split keeps references valid as long as the numbers and headings it cites survive.
 *
 * Not read: a reference whose name and section are on two lines, the end of a range (`§4.1–4.9`), a number after a comma
 * without its own `§`, `section 4` in words, and a bare rule id (`HD12`).
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, basename } from 'node:path'

export interface DocIndex {
  /** The sections (`4`, `4.5`) and heading texts of every document of a file name, as the union of the files that have it */
  byName: Map<string, { numbers: Set<string>; titles: string[] }>
}

const TEXT = /\.(ts|tsx|mts|cts|js|mjs|cjs|rs|md|yml|yaml|sh|toml|html|json|txt)$/
const MAX_BYTES = 1_000_000

/** The tracked files of the repository (paths from its root) */
export function trackedFiles(root: string): string[] {
  return execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 26 })
    .toString('utf8')
    .split('\0')
    .filter((f) => TEXT.test(f))
}

/** A heading's or a quotation's text compared by words, not by marks */
const clean = (t: string) => t.replace(/[`*_]|\[([^\]]*)\]\([^)]*\)/g, '$1').trim().toLowerCase()

/**
 * What a reference can name in a Markdown text, outside code fences: a numbered heading (`4.5`), an item of a numbered list under
 * one (`3.3`: the third item of §3), and the text of a heading or of a bold lead-in (`**Unsigned: SmartScreen.**`)
 */
export function targets(text: string): { numbers: string[]; titles: string[] } {
  const numbers: string[] = []
  const titles: string[] = []
  let fence = false
  let under = ''
  for (const line of text.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence
    if (fence) continue
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      const text = heading[1] ?? ''
      const num = /^(?:§\s*)?(\d+(?:\.\d+)*)\.?(?:\s+|$)/.exec(text)
      under = num?.[1] ?? ''
      if (num) numbers.push(under)
      titles.push(clean(num ? text.slice(num[0].length) : text))
      continue
    }
    const item = under ? /^(\d+)\. /.exec(line) : null
    if (item) numbers.push(`${under}.${item[1]}`)
    const lead = /^\s*(?:[-*] |\d+\. )?\*\*(.+?)\.?\*\*/.exec(line)
    if (lead) titles.push(clean(lead[1] ?? ''))
  }
  return { numbers, titles }
}

/** The documents a reference may name: every Markdown file under docs/ and at the root, by file name */
export function indexDocs(root: string, files: string[]): DocIndex {
  const byName: DocIndex['byName'] = new Map()
  for (const f of files) {
    if (!f.endsWith('.md') || (f.includes('/') && !f.startsWith('docs/'))) continue
    const name = basename(f, '.md').toLowerCase()
    const entry = byName.get(name) ?? { numbers: new Set<string>(), titles: [] }
    const { numbers, titles } = targets(readFileSync(join(root, f), 'utf8'))
    for (const n of numbers) entry.numbers.add(n)
    entry.titles.push(...titles)
    byName.set(name, entry)
  }
  return { byName }
}

const DOC = String.raw`((?:[\w.-]+/)*[A-Za-z][\w-]*?)(\.md)?`
const SECTION = String.raw`§\s?(\d+(?:\.\d+)*)`
// What may stand between a name and what it cites: a closing backtick, or the link that makes the name `[x.md](x.md)`
const GAP = '(?:`|\\]\\([^)]*\\))?,?\\s+'
const NUMBERED = new RegExp(String.raw`(?<![\w./-])${DOC}${GAP}(${SECTION}(?:\s*(?:,|/|and|or|&|–|—|-|to)\s*${SECTION})*)`, 'g')
const QUOTED = new RegExp(String.raw`(?<![\w./-])${DOC}\.md${GAP}["“«]([^"”»\n]{3,80})["”»]`, 'g')

/** What is wrong with the references in a text: one string per finding, with its line */
export function danglingRefs(text: string, index: DocIndex): string[] {
  const found: string[] = []
  const lineOf = (at: number) => text.slice(0, at).split('\n').length
  for (const m of text.matchAll(NUMBERED)) {
    const [, name = '', md = '', sections = ''] = m
    const doc = index.byName.get(basename(name).toLowerCase())
    if (!doc) {
      if (md && name.startsWith('docs/')) found.push(`${lineOf(m.index)}: ${name}.md does not exist`)
      continue
    }
    for (const [, n = ''] of sections.matchAll(/§\s?(\d+(?:\.\d+)*)/g)) if (!doc.numbers.has(n)) found.push(`${lineOf(m.index)}: ${name}${md} has no section ${n}`)
  }
  for (const m of text.matchAll(QUOTED)) {
    const [, name = '', , title = ''] = m
    const doc = index.byName.get(basename(name).toLowerCase())
    if (!doc) continue
    const wanted = clean(title)
    if (!doc.titles.some((t) => t.startsWith(wanted))) found.push(`${lineOf(m.index)}: ${name}.md has no heading "${title}"`)
  }
  return [...new Set(found)].sort((a, b) => parseInt(a) - parseInt(b))
}

/** Every dangling reference of the repository, as `file:line: what`, and how many references were read */
export function scanRepository(root: string): { findings: string[]; read: number } {
  const files = trackedFiles(root)
  // This checker and its test hold made-up references on purpose
  const own = new Set(['tooling/doc-refs.ts', 'tooling/doc-refs.test.ts'])
  const index = indexDocs(root, files)
  const findings: string[] = []
  let read = 0
  for (const f of files) {
    if (own.has(f)) continue
    const text = readFileSync(join(root, f), 'utf8')
    if (text.length > MAX_BYTES || !(text.includes('§') || text.includes('.md'))) continue
    read += (text.match(NUMBERED) ?? []).length + (text.match(QUOTED) ?? []).length
    for (const what of danglingRefs(text, index)) findings.push(`${f}:${what}`)
  }
  return { findings, read }
}
