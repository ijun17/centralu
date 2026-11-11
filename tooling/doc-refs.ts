/**
 * `guard/doc-refs`: a reference to a section of a document points at a section that exists (#2179 step 2).
 *
 * Four forms, in any tracked text file (a code comment, a string, a document):
 *   - `<doc> §4.5`, `docs/plans/mailbox.md §10.1`, `x.md §3 and §4`: section 4.5 exists in that document (a numbered heading, or an item of a numbered list under heading 4);
 *   - `docs/releasing.md "Host-only packages"`: a heading or a bold lead-in of that document starts with the quoted text;
 *   - `docs/runtime-lessons/host-contract.md HO4, HO6`: a rule id (two capitals and a number) that a bold lead-in of that document starts with (`**HO4. …**`);
 *   - in a Markdown file, a link `[text](../x.md#anchor)`: the file exists and, with an anchor, one of its headings has that anchor.
 * A bare name (`architecture §6.2`) counts when it is the name of a document under docs/ or at the root; other words
 * before a `§` (`plan §4`, which means the plan the comment sits in) are not read. A name written with `.md` that no document
 * has is a finding too. A name with a folder (`agent-host/usage.md`) is that file; a bare file name is looked up anywhere
 * under docs/, as the union of the files that have it.
 *
 * A document that grew past one file is a folder of sub-documents with a `README.md` index (docs/README.md): its old name
 * (`agent-host.md`, `agent-host §4.5`) and a path into the folder that names no file are findings, so no reference is
 * left pointing at the document that was split.
 *
 * Not read: a reference whose name and section are on two lines, the end of a range (`§4.1–4.9`), a number after a comma
 * without its own `§`, `section 4` in words, a bare rule id (`HD12`), and a link in a file that is not Markdown.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, basename, posix } from 'node:path'

interface Doc {
  /** The sections (`4`, `4.5`) and heading texts of a document */
  numbers: Set<string>
  titles: string[]
  /** The anchors its headings get */
  anchors: Set<string>
}

export interface DocIndex {
  /** Every document by its path from the repository root */
  byPath: Map<string, Doc>
  /** The documents of a file name, as the union of the files that have it */
  byName: Map<string, Doc>
  /** The names of documents that are folders now (`agent-host` for docs/agent-host/README.md with no docs/agent-host.md) */
  folders: Set<string>
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

/** The anchor GitHub gives a heading: its text without marks, lower case, punctuation dropped, spaces as hyphens */
export const anchorOf = (t: string) =>
  t
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*]/g, '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-')

/**
 * What a reference can name in a Markdown text, outside code fences: a numbered heading (`4.5`), an item of a numbered list under
 * one (`3.3`: the third item of §3), the text of a heading or of a bold lead-in (`**Unsigned: SmartScreen.**`), and a heading's anchor
 */
export function targets(text: string): Doc {
  const numbers = new Set<string>()
  const titles: string[] = []
  const anchors = new Set<string>()
  const seen = new Map<string, number>()
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
      if (num) numbers.add(under)
      titles.push(clean(num ? text.slice(num[0].length) : text))
      const anchor = anchorOf(text)
      const n = seen.get(anchor) ?? 0
      seen.set(anchor, n + 1)
      anchors.add(n ? `${anchor}-${n}` : anchor)
      continue
    }
    const item = under ? /^(\d+)\. /.exec(line) : null
    if (item) numbers.add(`${under}.${item[1]}`)
    const lead = /^\s*(?:[-*] |\d+\. )?\*\*(.+?)\.?\*\*/.exec(line)
    if (lead) titles.push(clean(lead[1] ?? ''))
    for (const [, id = ''] of line.matchAll(/<a (?:name|id)="([^"]+)"/g)) anchors.add(id)
  }
  return { numbers, titles, anchors }
}

/** The documents a reference may name: every Markdown file by path; by name, those under docs/ and at the root */
export function indexDocs(root: string, files: string[]): DocIndex {
  return indexTexts(new Map(files.filter((f) => f.endsWith('.md')).map((f) => [f, readFileSync(join(root, f), 'utf8')])))
}

/** The same index, from the texts of the Markdown files by path */
export function indexTexts(texts: Map<string, string>): DocIndex {
  const folders = new Set<string>()
  for (const f of texts.keys()) {
    const m = /^docs\/([\w-]+)\/README\.md$/.exec(f)
    if (m?.[1] && !texts.has(`docs/${m[1]}.md`)) folders.add(m[1])
  }
  const byPath: DocIndex['byPath'] = new Map()
  const byName: DocIndex['byName'] = new Map()
  for (const [f, text] of texts) {
    const doc = targets(text)
    byPath.set(f, doc)
    // A sub-document of a split one is named with its folder: its bare name (`keeper`, `usage`) is an ordinary word
    if ((f.includes('/') && !f.startsWith('docs/')) || folders.has(f.split('/')[1] ?? '')) continue
    const name = basename(f, '.md').toLowerCase()
    const entry = byName.get(name) ?? { numbers: new Set<string>(), titles: [], anchors: new Set<string>() }
    for (const n of doc.numbers) entry.numbers.add(n)
    entry.titles.push(...doc.titles)
    byName.set(name, entry)
  }
  return { byPath, byName, folders: new Set([...folders].map((f) => f.toLowerCase())) }
}

/**
 * The document a name means: a name with a folder is the one file whose path ends with it, a bare name every file of that name.
 * A string says what is wrong: the name is a document that is a folder now, or a path into such a folder names no file.
 */
function lookup(name: string, index: DocIndex): Doc | string | undefined {
  const base = basename(name).toLowerCase()
  if (name.includes('/')) {
    const path = name.replace(/^(?:\.{1,2}\/)+/, '').replace(/^docs\//, '')
    const found = [...index.byPath.keys()].filter((p) => p === `docs/${path}.md` || p === `${path}.md` || p.endsWith(`/${path}.md`))
    if (found.length === 1) return index.byPath.get(found[0] ?? '')
    const folder = path.split('/')[0]?.toLowerCase() ?? ''
    if (path.includes('/') && index.folders.has(folder)) return `${name}.md is no file of the ${folder}/ folder`
  }
  if (index.folders.has(base) && !index.byName.has(base)) return `${name}.md is a folder now: cite the file under it`
  return index.byName.get(base)
}

const DOC = String.raw`((?:[\w.-]+/)*[A-Za-z][\w-]*?)(\.md)?`
const SECTION = String.raw`§\s?(\d+(?:\.\d+)*)`
// What may stand between a name and what it cites: a closing backtick, or the link that makes the name `[x.md](x.md)`
const GAP = '(?:`|\\]\\([^)]*\\))?,?\\s+'
const NUMBERED = new RegExp(String.raw`(?<![\w./-])${DOC}${GAP}(${SECTION}(?:\s*(?:,|/|and|or|&|–|—|-|to)\s*${SECTION})*)`, 'g')
const QUOTED = new RegExp(String.raw`(?<![\w./-])${DOC}\.md${GAP}["“«]([^"”»\n]{3,80})["”»]`, 'g')
const RULE = new RegExp(String.raw`(?<![\w./-])${DOC}${GAP}([A-Z]{2}\d+(?:\s*(?:,|and|or|&)\s*[A-Z]{2}\d+)*)(?![\w-])`, 'g')
const PLAIN = /(?<![\w./-])((?:[\w.-]+\/)*[A-Za-z][\w-]*)\.md(?![\w-])/g
const LINK = /\]\(([^)\s#]*?\.md)?(?:#([^)\s]+))?\)/g

/** What is wrong with the references in a text: one string per finding, with its line; `file` (from the root) checks its links */
export function danglingRefs(text: string, index: DocIndex, file?: string): string[] {
  const found: string[] = []
  const lineOf = (at: number) => text.slice(0, at).split('\n').length
  for (const m of text.matchAll(NUMBERED)) {
    const [, name = '', md = '', sections = ''] = m
    const doc = lookup(name, index)
    if (typeof doc === 'string') {
      found.push(`${lineOf(m.index)}: ${doc}`)
      continue
    }
    if (!doc) {
      if (md && name.startsWith('docs/')) found.push(`${lineOf(m.index)}: ${name}.md does not exist`)
      continue
    }
    for (const [, n = ''] of sections.matchAll(/§\s?(\d+(?:\.\d+)*)/g)) if (!doc.numbers.has(n)) found.push(`${lineOf(m.index)}: ${name}${md} has no section ${n}`)
  }
  for (const m of text.matchAll(QUOTED)) {
    const [, name = '', , title = ''] = m
    const doc = lookup(name, index)
    if (typeof doc !== 'object') continue
    const wanted = clean(title)
    if (!doc.titles.some((t) => t.startsWith(wanted))) found.push(`${lineOf(m.index)}: ${name}.md has no heading "${title}"`)
  }
  for (const m of text.matchAll(RULE)) {
    const [, name = '', md = '', ids = ''] = m
    const doc = lookup(name, index)
    if (typeof doc === 'string') found.push(`${lineOf(m.index)}: ${doc}`)
    if (typeof doc !== 'object') continue
    for (const [id] of ids.matchAll(/[A-Z]{2}\d+/g)) if (!doc.titles.some((t) => t.startsWith(`${id.toLowerCase()}.`))) found.push(`${lineOf(m.index)}: ${name}${md} has no rule ${id}`)
  }
  for (const m of text.matchAll(PLAIN)) {
    const doc = lookup(m[1] ?? '', index)
    if (typeof doc === 'string') found.push(`${lineOf(m.index)}: ${doc}`)
  }
  if (file?.endsWith('.md')) {
    let fence = false
    let at = 0
    for (const line of text.split('\n')) {
      if (/^\s*(```|~~~)/.test(line)) fence = !fence
      if (!fence) {
        for (const m of line.matchAll(LINK)) {
          const [whole, target, anchor] = m
          if (!target && !anchor) continue
          const path = target ? posix.normalize(posix.join(posix.dirname(file), target)) : file
          if (path.startsWith('../') || /^[a-z]+:/i.test(target ?? '') || target?.startsWith('/')) continue
          const doc = index.byPath.get(path)
          if (!doc) found.push(`${lineOf(at)}: ${whole.slice(2, -1)} is no document`)
          else if (anchor && !doc.anchors.has(anchor)) found.push(`${lineOf(at)}: ${path} has no heading #${anchor}`)
        }
      }
      at += line.length + 1
    }
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
    read += (text.match(NUMBERED) ?? []).length + (text.match(QUOTED) ?? []).length + (text.match(RULE) ?? []).length
    for (const what of danglingRefs(text, index, f)) findings.push(`${f}:${what}`)
  }
  return { findings, read }
}
