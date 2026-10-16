// The repository's rules for public text, as pure functions (no gh, no IO): what goes into an issue,
// a comment, a pull request or a commit message (#386 step 2). contribute-tools.mjs reads the rules'
// sources from the repository (the commit conventions, the pull request template) and the private word
// list from the app's data folder, and hands them in; the answers are lists of problems, in words for
// the reader, and an empty list means the text may go.
import { attributionLines } from './ci.mjs'

// --- English only ----------------------------------------------------------------------------------
// CONTRIBUTING.md, Language: everything written down is in English, and non-English text is quoted
// verbatim when the exact words matter. So code (fenced or inline), quotes (`> `) and addresses are
// left out, and what remains may hold no letter of another script. Greek stays allowed: it is the
// notation of units and formulas (µs, Δ, π). Latin-script languages are not told apart from English;
// that would need a dictionary, and the mistake this catches is a sentence in Korean or Japanese.

// A letter of another script: Latin, Greek and the letters every script shares (µ, ª) aside
const OTHER = String.raw`[\p{L}--[\p{Script=Latin}\p{Script=Greek}\p{Script=Common}\p{Script=Inherited}]]`
const FOREIGN = new RegExp(String.raw`${OTHER}+(?:[\s\p{P}]*${OTHER}+)*`, 'v')

/** The text without what may be in another language: code, quotes, HTML comments and addresses. */
export function unquoted(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\1[^\n]*|$)/gm, '')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/(`+)[\s\S]*?\1/g, '')
    .replace(/^ {0,3}>.*$/gm, '')
    .replace(/\bhttps?:\/\/\S+/g, '')
}

/** One problem when the text holds words in another script outside code and quotes, else none. */
export function englishProblems(text, what = 'The text') {
  const m = FOREIGN.exec(unquoted(text))
  if (!m) return []
  const sample = m[0].length > 24 ? `${m[0].slice(0, 24)}…` : m[0]
  return [
    `${what} is not in English ("${sample}"). Write it in English; a word whose exact form matters goes in backticks or a > quote (CONTRIBUTING.md, Language).`,
  ]
}

// --- The private word list -------------------------------------------------------------------------
// Words that must not appear in public text (names of the person's other projects and the like),
// kept in the app's data folder, never in the repository (#386, owner decision 2026-10-06). Matched
// whole, ignoring case, anywhere: in code and addresses too, since a leak there is still a leak.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Cleans a list for storing: trimmed, one space inside, no empties, once each ignoring case, sorted. */
export function normalizeWords(words) {
  const seen = new Map()
  for (const w of Array.isArray(words) ? words : []) {
    const s = String(w ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    if (s && !seen.has(s.toLowerCase())) seen.set(s.toLowerCase(), s)
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

/** The private words a text contains, each once, in the list's order. */
export function privateWordHits(text, words) {
  const t = String(text ?? '')
  return normalizeWords(words).filter((w) => {
    const pattern = escapeRe(w).replace(/ /g, '[\\s_-]+')
    return new RegExp(`(?<![\\p{L}\\p{N}_])${pattern}(?![\\p{L}\\p{N}_])`, 'iu').test(t)
  })
}

export function privateWordProblems(text, words, what = 'The text') {
  const hits = privateWordHits(text, words)
  if (!hits.length) return []
  return [`${what} contains ${hits.length === 1 ? 'a word' : 'words'} from the private list: ${hits.map((w) => `"${w}"`).join(', ')}. Leave ${hits.length === 1 ? 'it' : 'them'} out or say it in general terms.`]
}

export function attributionProblems(text, what = 'The text') {
  const lines = attributionLines(text)
  if (!lines.length) return []
  return [`${what} carries attribution lines (${lines.map((l) => `"${l.trim()}"`).join(', ')}). Remove them: nothing here is signed by a tool (docs/commit-conventions.md).`]
}

/** Every rule for text that goes public: English, the private list, and no attribution lines. */
export function publicTextProblems(text, words, what = 'The text') {
  return [...englishProblems(text, what), ...privateWordProblems(text, words, what), ...attributionProblems(text, what)]
}

/**
 * A bare #N belongs to this repository unless it is written beside an attribution to another one.
 * This is a warning: prose is ambiguous, but `owner/repo#N` removes the ambiguity before it is
 * published. The narrow patterns avoid treating ordinary mentions of a repository as a problem.
 */
export function foreignBareIssueWarnings(text, repository, what = 'The text') {
  const own = String(repository ?? '').toLowerCase()
  const hits = new Set()
  const named = /(?:\b(?:in|on|from|of|at)\s+)?([\w.-]+\/[\w.-]+)\s+(?:issue\s+|pull request\s+|PR\s+)?#(\d+)\b/gi
  for (const m of String(text ?? '').matchAll(named)) {
    if (m[1].toLowerCase() !== own) hits.add(`${m[1]}#${m[2]}`)
  }
  if (!hits.size) return []
  return [`${what} attributes bare ${[...hits].map((x) => `#${x.slice(x.lastIndexOf('#') + 1)}`).join(', ')} to another repository (${[...hits].join(', ')}). Write the reference as owner/repo#N so it cannot link here by mistake.`]
}

// --- Commit messages (docs/commit-conventions.md) ----------------------------------------------------

/** The rules read from the conventions document; `fallback` names what could not be read. */
export const DEFAULT_CONVENTIONS = {
  types: ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'style', 'build', 'ci', 'chore', 'revert'],
  subjectMax: 72,
  bodyWrap: 72,
}

/** The types table, the subject's length and the body's wrap from docs/commit-conventions.md. */
export function parseConventions(markdown) {
  const text = String(markdown ?? '')
  const types = [...text.matchAll(/^\|\s*`([a-z]+)`\s*\|/gm)].map((m) => m[1])
  const subject = /subject at (\d+) characters or fewer/i.exec(text)
  const wrap = /wrap prose at (\d+) characters/i.exec(text)
  return {
    types: types.length ? types : DEFAULT_CONVENTIONS.types,
    subjectMax: subject ? Number(subject[1]) : DEFAULT_CONVENTIONS.subjectMax,
    bodyWrap: wrap ? Number(wrap[1]) : DEFAULT_CONVENTIONS.bodyWrap,
  }
}

const SUBJECT = /^(?<type>[^\s(:!]+)(?:\((?<scope>[^)]*)\))?(?<bang>!)?: (?<desc>.*)$/
// A first word that reports instead of commanding ("added", "fixes", "adding"). A warning, so a short
// list for the -s form (a rule for it would catch "focus" and "status"), and the -ed and -ing forms
// less the verbs that are spelled that way in the imperative.
const REPORTED = new Set(['adds', 'fixes', 'updates', 'removes', 'makes', 'moves', 'keeps', 'uses', 'shows', 'lets', 'gives', 'allows', 'handles', 'improves', 'changes', 'renames', 'reads', 'writes', 'runs', 'implements', 'introduces', 'supports', 'ensures', 'prevents', 'refactors', 'cleans', 'bumps', 'drops'])
const ED_OK = new Set(['need', 'embed', 'feed', 'speed', 'seed', 'shred', 'proceed', 'succeed', 'exceed', 'bleed', 'breed', 'shed'])
const ING_OK = new Set(['bring', 'string', 'ring', 'sing', 'sting', 'swing', 'wring', 'cling', 'fling', 'sling'])
const reported = (w) => REPORTED.has(w) || (/^[a-z]{2,}ed$/.test(w) && !ED_OK.has(w)) || (/^[a-z]{3,}ing$/.test(w) && !ING_OK.has(w))

/**
 * A subject line against the conventions: `<type>(<scope>)?!?: <description>`. Problems refuse it;
 * warnings are worth a look but may be right ("adds" is how a few verbs end).
 */
export function subjectProblems(subject, conventions = DEFAULT_CONVENTIONS) {
  const problems = []
  const warnings = []
  const s = String(subject ?? '')
  const m = SUBJECT.exec(s)
  if (!m) {
    problems.push(`The subject "${s}" is not <type>(<scope>): <description>, for example "fix(ui): keep grid focus on the orchestrator".`)
    return { problems, warnings }
  }
  const { type, scope, desc } = m.groups
  if (!conventions.types.includes(type)) problems.push(`"${type}" is not a commit type here. Use one of: ${conventions.types.join(', ')}.`)
  if (scope !== undefined && !/^[a-z0-9][a-z0-9./-]*$/.test(scope)) problems.push(`The scope "${scope}" must be lowercase, one word such as ui or agent-host.`)
  if (!desc.trim()) problems.push('The description after the colon is empty.')
  else {
    if (/^\s/.test(desc) || /\s$/.test(desc)) problems.push('The description has spaces at its start or end.')
    if (/^\p{Lu}/u.test(desc) && !/^\p{Lu}{2,}/u.test(desc)) problems.push(`The description starts with a capital ("${desc.split(' ')[0]}"); it is lowercase.`)
    if (/\.$/.test(desc)) problems.push('The description ends with a period; it has none.')
    const first = desc.trim().split(/\s+/)[0].toLowerCase()
    if (reported(first))
      warnings.push(`"${first}" reads as a report; the description is imperative ("add", not "added" or "adds").`)
  }
  if ([...s].length > conventions.subjectMax) problems.push(`The subject is ${[...s].length} characters; keep it at ${conventions.subjectMax} or fewer.`)
  return { problems, warnings }
}

/**
 * A whole commit message: the subject, a blank line before a body, the body's wrap (a warning), and
 * the rules for public text. Returns { problems, warnings }.
 */
export function commitProblems(message, conventions = DEFAULT_CONVENTIONS, words = []) {
  const text = String(message ?? '').replace(/\r\n?/g, '\n').replace(/\n+$/, '')
  const lines = text.split('\n')
  const { problems, warnings } = subjectProblems(lines[0], conventions)
  if (lines.length > 1 && lines[1].trim() !== '') problems.push('The second line must be blank: the subject stands alone, and the body starts after an empty line.')
  let fence = false
  const long = []
  for (const [n, l] of lines.slice(2).entries()) {
    if (/^\s*(`{3,}|~{3,})/.test(l)) fence = !fence
    if (fence || /^\s{4}/.test(l) || /https?:\/\//.test(l) || /^[\w-]+: /.test(l)) continue
    if ([...l].length > conventions.bodyWrap) long.push(n + 3)
  }
  if (long.length) warnings.push(`Body line${long.length === 1 ? '' : 's'} ${long.join(', ')} ${long.length === 1 ? 'is' : 'are'} longer than ${conventions.bodyWrap} characters; wrap prose at ${conventions.bodyWrap}.`)
  problems.push(...publicTextProblems(text, words, 'The message'))
  return { problems, warnings }
}

// --- The pull request template ---------------------------------------------------------------------

/** A heading's name, for matching: "What changed", "whatChanged" and "what_changed" are one. */
export const headingKey = (s) => String(s ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')

/** The `## ` headings of a template, in order, with the guidance under each (its HTML comments). */
export function templateSections(template) {
  const out = []
  let current = null
  for (const line of String(template ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(line)
    if (h) {
      current = { heading: h[1], guidance: '' }
      out.push(current)
    } else if (current) current.guidance += `${line}\n`
  }
  for (const s of out) s.guidance = s.guidance.replace(/<!--|-->/g, '').replace(/\s+/g, ' ').trim()
  return out
}

// What "Not exercised" may not say: nothing at all, or a placeholder. "Nothing" is a real answer
// when it is true (the template says so), so it passes.
const PLACEHOLDER = /^(?:n\/?a|-+|tbd|todo|none\??|\?+|\.+|…)$/i

/**
 * Fills the template's headings from `sections` (keyed by heading, any spelling). A heading left
 * out is dropped (the template: "Delete any heading that does not apply"), except two kinds:
 * `required` ones, which must name something real (not "N/A"), and those whose own guidance says to
 * keep the heading (Usability: "write n/a and keep the heading"), which must say something, n/a
 * included. Both are read from the template, so a changed template changes the rule. Returns
 * { body, problems, warnings }.
 */
export function fillTemplate(template, sections, { required = ['Not exercised'] } = {}) {
  const heads = templateSections(template)
  const given = new Map()
  const problems = []
  const warnings = []
  for (const [k, v] of Object.entries(sections ?? {})) {
    if (v === undefined || v === null) continue
    const key = headingKey(k)
    if (!heads.some((h) => headingKey(h.heading) === key)) {
      problems.push(`The template has no heading "${k}". Its headings: ${heads.map((h) => h.heading).join(', ')}.`)
      continue
    }
    given.set(key, String(v).replace(/<!--[\s\S]*?-->/g, '').trim())
  }
  const parts = []
  for (const h of heads) {
    const key = headingKey(h.heading)
    const text = given.get(key) ?? ''
    const must = required.some((r) => headingKey(r) === key)
    const keep = /keep the heading/i.test(h.guidance)
    if (must && (!text || PLACEHOLDER.test(text)))
      problems.push(`"${h.heading}" is ${text ? `only "${text}"` : 'empty'}. Name the surfaces this change touches that you did not run (the packaged app, another platform, a live model session), or "Nothing" when that is true.`)
    else if (keep && !text) problems.push(`"${h.heading}" is empty, and the template keeps it: ${h.guidance}`)
    if (!text) {
      if (!must && !keep) warnings.push(`"${h.heading}" is left out.`)
      continue
    }
    parts.push(`## ${h.heading}\n\n${text}`)
  }
  if (!heads.length) problems.push('The pull request template has no "## " headings to fill.')
  return { body: parts.join('\n\n'), problems, warnings }
}
