/**
 * `guard/doc-refs`: a reference to a section of a document points at a section that exists (#2179 step 2).
 *
 * Four forms, in any tracked text file (a code comment, a string, a document):
 *   - `<doc> §4.5`, `docs/plans/mailbox.md §10.1`, `x.md §3 and §4`: section 4.5 exists in that document (a numbered heading, or an item of a numbered list under heading 4);
 *   - `docs/releasing.md "Host-only packages"`: a heading or a bold lead-in of that document starts with the quoted text;
 *   - `docs/runtime-lessons/host-contract.md HO4, HO6`: a rule id (two capitals, a number, maybe a letter) that a bold lead-in of that document starts with (`**HO4. …**`);
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
 * A name and what it cites may be on two lines, also of a comment (` * §4.5` under ` * x.md`). Not read: the end of a range (`§4.1–4.9`), a number after a comma
 * without its own `§`, `section 4` in words, a bare rule id (`HD12`), and a link in a file that is not Markdown. In a Markdown file,
 * a fenced block and a code span are code, not references, for every form (a span that holds only a document's name is that name: `` `x.md` §3 ``).
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
  /** The paths of the documents by every ending of a path, without `.md` (`remote/serve`, `agent-host/remote/serve`, …) */
  bySuffix: Map<string, string[]>
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

/**
 * The anchor GitHub gives a heading: the rendered text (a link's text; emphasis by `_` gone, but not in code or inside a word), lower case,
 * every character but a letter, mark, number, `_`, `-` or space dropped (backticks and `*` with them), each space a hyphen
 */
export const anchorOf = (t: string) =>
  t
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split(/(`+[^`]*`+)/)
    .map((part, i) => (i % 2 ? part : part.replace(/(?<![\p{L}\p{N}_])(_+)(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}_])/gu, '$2')))
    .join('')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, '')
    .replace(/ /g, '-')

/** Code blanked in place: its offsets and lines stay */
const blank = (code: string) => code.replace(/[^\n]/g, '·')

/** A Markdown text with its fenced blocks blanked: what is inside a fence is code, neither a heading nor a reference */
const unfenced = (text: string) => {
  let fence = false
  return text
    .split('\n')
    .map((line) => {
      const mark = /^\s*(```|~~~)/.test(line)
      if (mark) fence = !fence
      return mark || fence ? blank(line) : line
    })
    .join('\n')
}

// A code span (not across a blank line), and one that holds only a document's name
const CODE = /(?<!`)(`+)(?!`)((?:(?!\n[ \t]*\n)[\s\S])*?)(?<!`)\1(?!`)/g
const NAME_ONLY = /^(?:[\w.-]+\/)*[A-Za-z][\w-]*\.md$/

/** The prose of a Markdown text, where references are read: fences and code spans blanked in place (a span of a name alone stays) */
const prose = (text: string) =>
  unfenced(text).replace(CODE, (span: string, _: string, inner: string) => (NAME_ONLY.test(inner.trim()) ? span : blank(span)))

/**
 * What a reference can name in a Markdown text, outside code fences: a numbered heading (`4.5`), an item of a numbered list under
 * one (`3.3`: the third item of §3), the text of a heading or of a bold lead-in (`**Unsigned: SmartScreen.**`), and a heading's anchor
 */
export function targets(text: string): Doc {
  const numbers = new Set<string>()
  const titles: string[] = []
  const anchors = new Set<string>()
  let under = ''
  for (const line of unfenced(text).split('\n')) {
    const heading = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) {
      const text = heading[1] ?? ''
      const num = /^(?:§\s*)?(\d+(?:\.\d+)*)\.?(?:\s+|$)/.exec(text)
      under = num?.[1] ?? ''
      if (num) numbers.add(under)
      titles.push(clean(num ? text.slice(num[0].length) : text))
      anchors.add(anchorOf(text))
      continue
    }
    const item = under ? /^(\d+)\. /.exec(line) : null
    if (item) numbers.add(`${under}.${item[1]}`)
    const lead = /^\s*(?:[-*] |\d+\. )?\*\*(.+?)\.?\*\*/.exec(line)
    if (lead) titles.push(clean(lead[1] ?? ''))
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
  const bySuffix: DocIndex['bySuffix'] = new Map()
  for (const [f, text] of texts) {
    const doc = targets(text)
    byPath.set(f, doc)
    const parts = f.replace(/\.md$/, '').split('/')
    for (let i = 0; i < parts.length; i++) {
      const suffix = parts.slice(i).join('/')
      bySuffix.set(suffix, [...(bySuffix.get(suffix) ?? []), f])
    }
    // A sub-document of a split one is named with its folder: its bare name (`keeper`, `usage`) is an ordinary word
    if ((f.includes('/') && !f.startsWith('docs/')) || folders.has(f.split('/')[1] ?? '')) continue
    const name = basename(f, '.md').toLowerCase()
    const entry = byName.get(name) ?? { numbers: new Set<string>(), titles: [], anchors: new Set<string>() }
    for (const n of doc.numbers) entry.numbers.add(n)
    entry.titles.push(...doc.titles)
    byName.set(name, entry)
  }
  return { byPath, byName, bySuffix, folders: new Set([...folders].map((f) => f.toLowerCase())) }
}

/** What is wrong with a path under docs/ (without `.md`) that is no file: it is a split document's old name, or names no file of its folder */
function splitNote(name: string, path: string, index: DocIndex): string | undefined {
  const [folder = '', ...rest] = path.toLowerCase().split('/')
  if (!index.folders.has(folder)) return undefined
  return rest.length ? `${name}.md is no file of the ${folder}/ folder` : `${name}.md is a folder now: cite the file under it`
}

/**
 * The document a name means. Written with `.md` and cited from `from`: a name starting `./` or `../` is the file it names from there, as a
 * link's target is, and a bare name is the file of that name beside it when there is one (an app's own `AGENTS.md`). Else a name with a
 * folder is the one file whose path ends with it, and a bare name every file of that name.
 * A string says what is wrong: the name is a document that is a folder now, or a path into such a folder names no file.
 */
function lookup(name: string, index: DocIndex, from?: string): Doc | string | undefined {
  const base = basename(name).toLowerCase()
  if (from && /^\.\.?\//.test(name)) {
    const path = posix.normalize(posix.join(posix.dirname(from), `${name}.md`))
    return index.byPath.get(path) ?? (path.startsWith('docs/') ? splitNote(name, path.slice('docs/'.length, -'.md'.length), index) : undefined)
  }
  const beside = from && !name.includes('/') ? index.byPath.get(posix.join(posix.dirname(from), `${name}.md`)) : undefined
  if (beside) return beside
  if (name.includes('/')) {
    const path = name.replace(/^(?:\.{1,2}\/)+/, '').replace(/^docs\//, '')
    const found = index.bySuffix.get(path) ?? []
    if (found.length === 1) return index.byPath.get(found[0] ?? '')
    const note = path.includes('/') ? splitNote(name, path, index) : undefined
    if (note) return note
  }
  if (index.folders.has(base) && !index.byName.has(base)) return `${name}.md is a folder now: cite the file under it`
  return index.byName.get(base)
}

const DOC = String.raw`((?:[\w.-]+/)*[A-Za-z][\w-]*?)(\.md)?`
const SECTION = String.raw`§\s?(\d+(?:\.\d+)*)`
// What may stand between a name and what it cites: a closing backtick, or the link that makes the name `[x.md](x.md)`
// and white space, which may break the line: then the next line's comment mark too (`//`, `//!`, ` * `, `#`)
const GAP = '(?:`|\\]\\([^)]*\\))?,?\\s+(?:(?:\\/\\/[\\/!]?|\\*|#)\\s+)?'
const NUMBERED = new RegExp(String.raw`(?<![\w./-])${DOC}${GAP}(${SECTION}(?:\s*(?:,|/|and|or|&|–|—|-|to)\s*${SECTION})*)`, 'g')
const QUOTED = new RegExp(String.raw`(?<![\w./-])${DOC}\.md${GAP}["“«]([^"”»\n]{3,80})["”»]`, 'g')
const ID = String.raw`[A-Z]{2}\d+[a-z]?`
const RULE = new RegExp(String.raw`(?<![\w./-])${DOC}${GAP}(${ID}(?:\s*(?:,|and|or|&)\s*${ID})*)(?![\w-])`, 'g')
const PLAIN = /(?<![\w./-])((?:[\w.-]+\/)*[A-Za-z][\w-]*)\.md(?![\w-])/g
const LINK = /\]\(([^)\s#]*?\.md)?(?:#([^)\s]+))?\)/g

/** What is wrong with the references in a text: one string per finding, with its line; `file` (from the root) checks its links */
export function danglingRefs(written: string, index: DocIndex, file?: string): string[] {
  const text = file?.endsWith('.md') ? prose(written) : written
  const found: string[] = []
  const lineOf = (at: number) => text.slice(0, at).split('\n').length
  // The document a reference at `at` cites; what is wrong with its name is a finding, also a `docs/` or relative path that is no file
  const docOf = (at: number, name: string, md: string) => {
    const doc = lookup(name, index, md ? file : undefined)
    if (typeof doc === 'string') found.push(`${lineOf(at)}: ${doc}`)
    else if (!doc && md && /^(?:docs|\.\.?)\//.test(name)) found.push(`${lineOf(at)}: ${name}.md does not exist`)
    return typeof doc === 'object' ? doc : undefined
  }
  // Each form is read only in a text that has its mark: most files have none, and a miss costs a try at every word
  for (const m of text.includes('§') ? text.matchAll(NUMBERED) : []) {
    const [, name = '', md = '', sections = ''] = m
    const doc = docOf(m.index, name, md)
    if (!doc) continue
    for (const [, n = ''] of sections.matchAll(/§\s?(\d+(?:\.\d+)*)/g)) if (!doc.numbers.has(n)) found.push(`${lineOf(m.index)}: ${name}${md} has no section ${n}`)
  }
  for (const m of text.includes('.md') ? text.matchAll(QUOTED) : []) {
    const [whole, name = '', , quoted = ''] = m
    // The quotation as written: a heading may hold code (`"The manifest, `x.json`"`), and the prose keeps every offset
    const end = m.index + whole.length - 1
    const title = written.slice(end - quoted.length, end)
    const doc = docOf(m.index, name, '.md')
    if (!doc) continue
    const wanted = clean(title)
    if (!doc.titles.some((t) => t.startsWith(wanted))) found.push(`${lineOf(m.index)}: ${name}.md has no heading "${title}"`)
  }
  for (const m of /[A-Z]{2}\d/.test(text) ? text.matchAll(RULE) : []) {
    const [, name = '', md = '', ids = ''] = m
    const doc = docOf(m.index, name, md)
    if (!doc) continue
    for (const [id] of ids.matchAll(new RegExp(ID, 'g'))) if (!doc.titles.some((t) => t.startsWith(`${id.toLowerCase()}.`))) found.push(`${lineOf(m.index)}: ${name}${md} has no rule ${id}`)
  }
  for (const m of text.includes('.md') ? text.matchAll(PLAIN) : []) {
    const doc = lookup(m[1] ?? '', index, file)
    if (typeof doc === 'string') found.push(`${lineOf(m.index)}: ${doc}`)
  }
  if (file?.endsWith('.md'))
    for (const m of text.matchAll(LINK)) {
      const [whole, target, anchor] = m
      if (!target && !anchor) continue
      const path = target ? posix.normalize(posix.join(posix.dirname(file), target)) : file
      if (path.startsWith('../') || /^[a-z]+:/i.test(target ?? '') || target?.startsWith('/')) continue
      const doc = index.byPath.get(path)
      if (!doc) found.push(`${lineOf(m.index)}: ${whole.slice(2, -1)} is no document`)
      else if (anchor && !doc.anchors.has(anchor)) found.push(`${lineOf(m.index)}: ${path} has no heading #${anchor}`)
    }
  return [...new Set(found)].sort((a, b) => parseInt(a) - parseInt(b))
}

/** Every dangling reference of the repository, as `file:line: what` */
export function scanRepository(root: string): string[] {
  const texts = new Map(trackedFiles(root).map((f) => [f, readFileSync(join(root, f), 'utf8')]))
  const index = indexTexts(new Map([...texts].filter(([f]) => f.endsWith('.md'))))
  // This checker and its test hold made-up references on purpose
  const own = new Set(['tooling/doc-refs.ts', 'tooling/doc-refs.test.ts'])
  const findings: string[] = []
  for (const [f, text] of texts) {
    if (own.has(f) || text.length > MAX_BYTES || !(text.includes('§') || text.includes('.md'))) continue
    for (const what of danglingRefs(text, index, f)) findings.push(`${f}:${what}`)
  }
  return findings
}
