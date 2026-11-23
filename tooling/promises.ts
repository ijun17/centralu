/**
 * `guard/promises` (#2488 item 2): a code comment that promises work for later ("TODO", "a later release removes …", "not
 * supported yet") names the issue that carries it (#N) or says "dropped: <why>", in the same sentence: an umbrella issue
 * closed while such a sentence stands in code loses the work without a trace.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Files whose comments the guard reads; recordings and generated text are a tool's words, not ours */
const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|rs|yml|yaml)$/
const SKIP = /(^|\/)(recordings|generated|node_modules)\//

const MARKER = /\b(?:TODO|FIXME)\b/
/** A "later release" is ours; a "later version" is most often a vendor's, so it is left out */
const LATER = new RegExp(
  [
    String.raw`\b(?:a|the|one) (?:later|future|next) release(?: may| will)? (?:adds?|removes?|drops?|sends?|switch(?:es)?|moves?|renames?|reads?|writes?)\b`,
    String.raw`\b(?:in|with|by) (?:a|the) (?:later|future|next) (?:release|pull request)\b`,
    String.raw`\bnot (?:built|supported|provided|implemented|wired|handled) yet\b`,
    String.raw`\byet to be (?:built|added|done|implemented)\b`,
  ].join('|'),
  'i',
)
const CARRIED = /#\d+|\bdropped:/i
/** Where a sentence ends: not inside "e.g.", "i.e.", "etc." or "vs." */
const END = /(?<!\b(?:e\.g|i\.e|etc|vs))[.!?]\s/g

/** A comment's words, with quoted text taken out: a quotation is not a promise */
const words = (t: string) => t.replace(/"[^"]*"|`[^`]*`/g, '""').trim()

/**
 * The comment on a line, or null: what follows `//`, `/*`, a leading `*` or (YAML) `#`. `starts`: it begins a block of its
 * own (`/*`, or a comment after code)
 */
function commentOf(line: string, yaml: boolean): { text: string; starts: boolean } | null {
  const own = yaml ? /^\s*#(.*)$/.exec(line) : /^\s*(\/\/|\/\*+|\*(?!\/))(.*)$/.exec(line)
  const after = own || yaml ? null : /\s\/\/(.*)$/.exec(line)
  const text = own ? (yaml ? own[1] : own[2]) : after?.[1]
  if (text === undefined) return null
  return { text: words(text), starts: !!after || (!!own && !yaml && own[1].startsWith('/*')) }
}

/**
 * Each promise in `text` (the file at `path`) whose sentence carries no issue and no "dropped:", as `<line>: <the words>`.
 * The sentence, not the block: a long comment cites issues of its own, which say nothing of what the promise leaves for later.
 */
export function unownedPromises(path: string, text: string): string[] {
  const yaml = /\.ya?ml$/.test(path)
  const found: string[] = []
  let block: { at: number; text: string }[] = []
  const close = () => {
    let joined = ''
    const starts = block.map((l) => {
      const at = joined.length
      joined += `${l.text} `
      return at
    })
    block.forEach((l, k) => {
      const m = MARKER.exec(l.text) ?? LATER.exec(l.text)
      if (!m) return
      const at = starts[k] + m.index
      const from = Math.max(0, ...[...joined.slice(0, at).matchAll(END)].map((x) => x.index + 2))
      const end = joined.slice(at).search(new RegExp(END.source))
      if (!CARRIED.test(joined.slice(from, end < 0 ? joined.length : at + end + 1))) found.push(`${l.at + 1}: ${m[0]}`)
    })
    block = []
  }
  // Inside a `/*` opened at the start of a line, a line without a leading `*` is comment too
  let open = false
  text.split('\n').forEach((line, i) => {
    const comment = open && !/^\s*\*/.test(line) ? { text: words(line.replace(/\*\/.*$/, '')), starts: false } : commentOf(line, yaml)
    if (!yaml) open = /^\s*\/\*/.test(line) ? !/\*\//.test(line) : open && !/\*\//.test(line)
    if (comment === null || comment.starts) close()
    if (comment !== null) block.push({ at: i, text: comment.text })
    // A comment after code is a block of its own; a `/*` goes on to the lines under it
    if (comment !== null && comment.starts && !/^\s*\/\*/.test(line)) close()
  })
  close()
  return found
}

/** Every unowned promise in the repository's tracked code, as `<path>:<line>: <the words>` */
export function scanRepository(root: string): string[] {
  // The guard and its test spell the promises out on purpose
  const own = new Set(['tooling/promises.ts', 'tooling/promises.test.ts'])
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, maxBuffer: 1 << 26 })
    .toString('utf8')
    .split('\0')
    .filter((f) => CODE.test(f) && !SKIP.test(f) && !own.has(f))
  return files.flatMap((f) => unownedPromises(f, readFileSync(join(root, f), 'utf8')).map((what) => `${f}:${what}`))
}
