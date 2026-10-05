// The decisions behind ci_status and merge_when_green, as pure functions: no gh, no IO, so the tests
// can run every case (tooling/project-board-ci.test.ts). github.mjs reads; server.mjs asks these.
//
// Why this exists (#386): on 2026-10-05 a merge script read "no checks reported yet" as "nothing
// pending, nothing failed" and merged #380 before its CI had started. The rule kept here is the
// opposite: a check is green only once it is reported and passed, and a required check nobody has
// reported is waited for, never assumed.

const MAX_LINE = 300

/** Shortens a line for an answer the model reads. */
export const clip = (s, n = MAX_LINE) => {
  const t = String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

// --- Which checks are required -------------------------------------------------------------------

/**
 * The lines of a YAML file that carry structure: comments dropped, and the content of block scalars
 * (`run: |`, `artifacts: |`) skipped, since a script line such as `name: x` is not a key. Enough YAML
 * for a workflow's jobs, names and matrices; not a YAML parser.
 */
function yamlLines(text) {
  const out = []
  let block = -1
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const indent = raw.match(/^ */)[0].length
    if (block >= 0) {
      if (!raw.trim() || indent > block) continue
      block = -1
    }
    const t = stripComment(raw).trim()
    if (!t) continue
    out.push({ indent, text: t })
    if (/:\s*[|>][-+0-9]*$/.test(t)) block = indent
  }
  return out
}

function stripComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i)
  }
  return line
}

const unquote = (s) => String(s ?? '').trim().replace(/^(['"])(.*)\1$/, '$2')
const keyValue = (t) => {
  const m = /^(-\s+)?([\w.-]+):(?:\s+(.*))?$/.exec(t)
  return m ? { dash: !!m[1], key: m[2], value: m[3] === undefined ? '' : m[3] } : null
}
const inlineList = (v) => (/^\[.*\]$/.test(v) ? v.slice(1, -1).split(',').map(unquote).filter(Boolean) : null)

/** The rows of a `strategy.matrix`: the axes' combinations, then `include` (GitHub's rules, simplified). */
function matrixRows(lines) {
  if (!lines.length) return []
  const top = lines[0].indent
  const axes = []
  const includes = []
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.indent !== top) continue
    const kv = keyValue(l.text)
    if (!kv) continue
    const deeper = []
    for (let k = i + 1; k < lines.length && lines[k].indent > top; k++) deeper.push(lines[k])
    if (kv.key === 'exclude') continue
    if (kv.key === 'include') {
      let row = null
      let rowIndent = -1
      for (const d of deeper) {
        if (d.text.startsWith('- ')) {
          row = {}
          includes.push(row)
          rowIndent = d.indent + 2
          const e = keyValue(d.text)
          if (e && e.value) row[e.key] = unquote(e.value)
        } else if (row && d.indent === rowIndent) {
          const e = keyValue(d.text)
          if (e && e.value && !/^[|>]/.test(e.value)) row[e.key] = unquote(e.value)
        }
      }
      continue
    }
    const values = inlineList(kv.value) ?? (kv.value ? [unquote(kv.value)] : deeper.filter((d) => d.text.startsWith('- ')).map((d) => unquote(d.text.slice(2))))
    if (values.length) axes.push([kv.key, values])
  }
  let rows = axes.length ? [{}] : []
  for (const [key, values] of axes) rows = rows.flatMap((r) => values.map((v) => ({ ...r, [key]: v })))
  const axisKeys = axes.map(([k]) => k)
  for (const inc of includes) {
    const fits = rows.filter((r) => axisKeys.every((k) => !(k in inc) || inc[k] === r[k]) && axisKeys.some((k) => k in inc))
    if (fits.length) for (const r of fits) Object.assign(r, inc)
    else rows.push({ ...inc })
  }
  return rows
}

/**
 * The check names a workflow's jobs report under, the way GitHub names them: the job's `name`, with
 * `${{ matrix.x }}` filled in for each matrix row, or the job id. A name this cannot work out (an
 * expression other than a matrix value, a matrix job without a name) is listed in `unresolved`, so the
 * caller knows the required set is incomplete instead of silently smaller.
 */
export function workflowCheckNames(text) {
  const lines = yamlLines(text)
  const j = lines.findIndex((l) => l.indent === 0 && l.text === 'jobs:')
  if (j < 0) return { names: [], unresolved: [] }
  const body = []
  for (let i = j + 1; i < lines.length && lines[i].indent > 0; i++) body.push(lines[i])
  if (!body.length) return { names: [], unresolved: [] }
  const jobIndent = body[0].indent
  const jobs = []
  for (const l of body) {
    if (l.indent === jobIndent) {
      const kv = keyValue(l.text)
      if (kv && !kv.dash) jobs.push({ id: kv.key, lines: [] })
    } else jobs.at(-1)?.lines.push(l)
  }
  const names = []
  const unresolved = []
  for (const job of jobs) {
    const inner = job.lines[0]?.indent
    let name = null
    let rows = []
    for (let i = 0; i < job.lines.length; i++) {
      const l = job.lines[i]
      if (l.indent !== inner) continue
      const kv = keyValue(l.text)
      if (kv?.key === 'name') name = unquote(kv.value)
      if (kv?.key === 'strategy') {
        const strategy = []
        for (let k = i + 1; k < job.lines.length && job.lines[k].indent > inner; k++) strategy.push(job.lines[k])
        const m = strategy.findIndex((s) => s.text === 'matrix:' && s.indent === strategy[0].indent)
        if (m >= 0) {
          const matrix = []
          for (let k = m + 1; k < strategy.length && strategy[k].indent > strategy[m].indent; k++) matrix.push(strategy[k])
          rows = matrixRows(matrix)
        }
      }
    }
    if (!name) {
      if (rows.length) unresolved.push(job.id)
      else names.push(job.id)
      continue
    }
    if (!name.includes('${{')) {
      if (rows.length) unresolved.push(job.id)
      else names.push(name)
      continue
    }
    if (!rows.length) {
      unresolved.push(job.id)
      continue
    }
    for (const row of rows) {
      let ok = true
      const filled = name.replace(/\$\{\{\s*matrix\.([\w-]+)\s*\}\}/g, (_, k) => {
        if (row[k] === undefined) ok = false
        return row[k] ?? ''
      })
      if (ok && !filled.includes('${{')) names.push(filled)
      else {
        unresolved.push(job.id)
        break
      }
    }
  }
  return { names: [...new Set(names)], unresolved: [...new Set(unresolved)] }
}

// --- What the reported checks add up to -----------------------------------------------------------

const PASSED = new Set(['success', 'neutral', 'skipped'])
const PENDING_STATUS = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending'])

/**
 * One reported check as passed, failed or pending. `kind` is `run` (a check run: status +
 * conclusion) or `status` (a commit status: state).
 */
export function checkState(c) {
  if (c.kind === 'status') {
    if (c.state === 'success') return 'passed'
    if (c.state === 'pending') return 'pending'
    return 'failed'
  }
  if (c.status !== 'completed' || PENDING_STATUS.has(c.status)) return 'pending'
  return PASSED.has(c.conclusion) ? 'passed' : 'failed'
}

/** Several reports of one name (a rerun, a run and a status): the newest one counts. */
function latestByName(reported) {
  const by = new Map()
  for (const c of reported) {
    const prev = by.get(c.name)
    if (!prev || String(c.at ?? '') > String(prev.at ?? '') || (String(c.at ?? '') === String(prev.at ?? '') && (c.id ?? 0) > (prev.id ?? 0))) by.set(c.name, c)
  }
  return by
}

/**
 * Adds up the checks of one commit against the required set.
 *
 * `required` is a list of check names, or null when no required set could be found; then every
 * reported check counts as required (and none reported means nothing to go on). Verdicts:
 * - `green`: every required check reported and passed;
 * - `failing`: a required check failed (whatever else is still running);
 * - `pending`: a required check is still running, or not reported yet;
 * - `none`: no check reported at all. Not green: CI may simply not have started (#380).
 * `alsoReported`: the required set is known to be incomplete (a job whose check name could not be
 * worked out), so every reported check counts as required too.
 */
export function evaluateChecks({ required, reported, alsoReported = false }) {
  const latest = latestByName(reported ?? [])
  const names = required && required.length ? [...new Set([...required, ...(alsoReported ? latest.keys() : [])])] : [...latest.keys()]
  const rows = names.map((name) => {
    const c = latest.get(name)
    return c ? { name, state: checkState(c), check: c } : { name, state: 'missing', check: null }
  })
  const others = [...latest.values()].filter((c) => !names.includes(c.name)).map((c) => ({ name: c.name, state: checkState(c), check: c }))
  const count = (s) => rows.filter((r) => r.state === s).length
  let verdict
  if (latest.size === 0) verdict = 'none'
  else if (!names.length) verdict = 'none'
  else if (count('failed')) verdict = 'failing'
  else if (count('pending') || count('missing')) verdict = 'pending'
  else verdict = 'green'
  return {
    verdict,
    rows,
    others,
    counts: { passed: count('passed'), failed: count('failed'), pending: count('pending'), missing: count('missing'), total: rows.length },
  }
}

// --- Whether to merge -----------------------------------------------------------------------------

/** Merging is the maintainer's act (#386): maintain or admin on the repository, as GitHub reports it. */
export const canMerge = (permissions) => permissions?.admin === true || permissions?.maintain === true

export const NO_PERMISSION = Object.freeze({
  action: 'refuse',
  kind: 'permission',
  reason:
    "The GitHub account gh is logged in as has no maintain or admin permission on this repository, and merging is the maintainer's act (#386). Mark the PR ready for review instead; the maintainer merges.",
})

/**
 * The merge decision, in order: who is asking, what state the PR is in, what CI says, whether GitHub
 * can merge it. `action` is `merge`, `wait` (try again later, or keep polling with `wait: true`) or
 * `refuse` (stop; `reason` says why).
 */
export function decideMerge({ permissions, pr, checks }) {
  if (!canMerge(permissions)) return NO_PERMISSION
  if (pr.state !== 'OPEN') return { action: 'refuse', kind: 'state', reason: `PR #${pr.number} is ${String(pr.state).toLowerCase()}, not open.` }
  if (pr.isDraft) return { action: 'refuse', kind: 'draft', reason: `PR #${pr.number} is a draft. Mark it ready for review first.` }
  if (checks.verdict === 'failing') return { action: 'refuse', kind: 'failing', reason: 'A required check failed.' }
  if (checks.verdict === 'none') return { action: 'wait', kind: 'none', reason: 'No checks are reported for its head commit yet, and no checks is not green.' }
  if (checks.verdict === 'pending') {
    const waiting = checks.rows.filter((r) => r.state === 'pending' || r.state === 'missing')
    const named = waiting.map((r) => `${r.name}${r.state === 'missing' ? ' (not reported yet)' : ''}`).join(', ')
    return { action: 'wait', kind: 'pending', reason: `Required checks still to pass: ${named}.` }
  }
  if (checks.verdict !== 'green') return { action: 'refuse', kind: 'internal', reason: `Unknown CI verdict ${checks.verdict}.` }
  if (pr.mergeable === 'CONFLICTING') return { action: 'refuse', kind: 'conflict', reason: `PR #${pr.number} has conflicts with ${pr.baseRefName}. Rebase it first.` }
  if (pr.mergeable !== 'MERGEABLE') return { action: 'wait', kind: 'mergeable', reason: 'GitHub has not worked out yet whether it can be merged.' }
  return { action: 'merge', kind: 'green', reason: 'Every required check is reported and passed, and GitHub can merge it.' }
}

// --- The squash commit's message ------------------------------------------------------------------

const ATTRIBUTION = [/^\s*co-authored-by\s*:/i, /^[^\p{L}\p{N}]*generated (?:with|by)\b/iu]

/** Drops attribution lines (Co-Authored-By trailers, "Generated with …" footers); docs/commit-conventions.md. */
export function stripAttribution(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((l) => !ATTRIBUTION.some((re) => re.test(l)))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The body of a squash commit when the caller gives none: the PR description's Why, What changed and
 * Closes sections (the template's, CONTRIBUTING.md), without the template's comments and without the
 * Verified / Not exercised notes, which are about the review. A description without those headings
 * is used whole.
 */
export function summarizeDescription(description) {
  const text = String(description ?? '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\r\n/g, '\n')
  const parts = text.split(/^##\s+(.+)$/m)
  if (parts.length < 3) return text.trim()
  const sections = new Map()
  for (let i = 1; i < parts.length; i += 2) sections.set(parts[i].trim().toLowerCase(), parts[i + 1].trim())
  const keep = ['why', 'what changed', 'closes'].map((k) => sections.get(k)).filter(Boolean)
  return keep.length ? keep.join('\n\n') : text.trim()
}

/** Subject `Title (#N)` (GitHub's squash default) and the body, both without attribution lines. */
export function squashMessage({ number, title, body, description }) {
  const subject = stripAttribution(`${String(title ?? '').trim()} (#${number})`).split('\n')[0]
  const text = body !== undefined && body !== null && String(body).trim() ? String(body) : summarizeDescription(description)
  return { subject, body: stripAttribution(text) }
}

// --- Reading a failed job's log -------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const STAMP = /^\uFEFF?\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/

/** A job log as plain lines: no colour codes, no timestamps. */
export const cleanLog = (text) =>
  String(text ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(ANSI, '').replace(STAMP, ''))

// The first line that names a failing test, by runner, in order of how much a line says.
const FAILS = [
  /^\s*FAIL\s+\S/, // vitest's summary ("FAIL  project  file > suite > test"), the keeper scripts ("FAIL title")
  /^\s*(?:×|✗|✘|❌)\s+\S/, // vitest and node:test while running
  /^\s*test\s+\S+\s+\.\.\.\s+FAILED\b/, // cargo test
  /^\s*\d+\)\s+\[[^\]]+\]\s+›/, // playwright
  /\berror\s+TS\d+:/, // tsc
  /^\s*\d+:\d+\s+error\s+/, // eslint
]
const ERROR = /^\s*(?:→\s+\S|(?:[A-Z]\w*)?Error\b:?|AssertionError|thread '.*' panicked|panicked at|Caused by:|expected\b)/

/**
 * The first failing test line in a job log and the error that follows it. A log with no test
 * failure (a build or install step failed) gives its first `##[error]` line instead.
 */
export function firstFailure(log) {
  const lines = cleanLog(log)
  for (const re of FAILS) {
    const at = lines.findIndex((l) => re.test(l))
    if (at < 0) continue
    const line = lines[at]
    let error = null
    const cargo = /^\s*test\s+(\S+)\s+\.\.\.\s+FAILED/.exec(line)
    if (cargo) {
      const p = lines.findIndex((l) => l.includes(`'${cargo[1]}'`) && /panicked/.test(l))
      if (p >= 0) error = [lines[p], lines[p + 1]].filter((x) => x && x.trim()).join(' ')
    } else {
      for (let k = at + 1; k < Math.min(lines.length, at + 60); k++) {
        if (ERROR.test(lines[k])) {
          error = lines[k]
          break
        }
      }
    }
    return { line: clip(line), error: error ? clip(error) : null }
  }
  const errors = lines.filter((l) => l.startsWith('##[error]')).map((l) => l.slice(9))
  const telling = errors.find((l) => !/^Process completed with exit code/.test(l)) ?? errors[0]
  return telling ? { line: null, error: clip(telling) } : { line: null, error: null }
}

// --- Known intermittent failures ------------------------------------------------------------------

const MIN_SIGNATURE = 20

/**
 * The failure texts an issue quotes (#368 lists the known intermittent failures): every line of its
 * code blocks and every inline code span, long enough to say something.
 */
export function flakeSignatures(issueText) {
  const text = String(issueText ?? '')
  const out = new Set()
  const add = (s) => {
    const t = s.replace(/\s+/g, ' ').trim()
    if (t.length >= MIN_SIGNATURE) out.add(t)
  }
  for (const m of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) for (const l of m[1].split('\n')) add(l)
  for (const m of text.replace(/```[\s\S]*?```/g, '').matchAll(/`([^`\n]+)`/g)) add(m[1])
  return [...out]
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * A signature as a pattern that survives what changes between runs: `…` or `...` match anything,
 * a temp-folder suffix (letters and digits mixed, such as `O0htlN`) matches any, numbers match any
 * number, and whitespace any whitespace.
 */
export function signaturePattern(sig) {
  const src = sig
    .split(/…|\.\.\./)
    .map((piece) =>
      piece
        .split(/([A-Za-z0-9]+)/)
        .map((tok, i) => {
          if (i % 2 === 0) return escape(tok).replace(/\s+/g, '\\s+')
          if (/\d/.test(tok) && /[A-Za-z]/.test(tok) && tok.length >= 5) return '[A-Za-z0-9]+'
          if (/^\d+$/.test(tok)) return '\\d+'
          return tok
        })
        .join(''),
    )
    .join('.*?')
  return new RegExp(src, 'i')
}

/** The test's own name in a failing line: without FAIL / × and vitest's project label. */
const testName = (line) =>
  String(line ?? '')
    .replace(/^\s*(?:FAIL|×|✗|✘|❌)\s+/, '')
    .replace(/^\S+\s{2,}(?=\S+\.(?:test|spec)\.)/, '')
    .replace(/^test\s+(\S+)\s+\.\.\.\s+FAILED.*$/, '$1')
    .replace(/\s+/g, ' ')
    .trim()

/**
 * Whether a failure is one the issue lists. Answers the matching quote (so the reader can judge it),
 * or null. Whether it really is that flake stays the reader's call (#386: judgement outside the app).
 */
export function matchKnownFailure(failure, issueText) {
  if (!failure || (!failure.line && !failure.error)) return null
  const candidates = [failure.line, failure.error].filter(Boolean)
  for (const sig of flakeSignatures(issueText)) {
    const re = signaturePattern(sig)
    if (candidates.some((c) => re.test(c))) return clip(sig, 160)
  }
  const name = testName(failure.line)
  const flat = String(issueText ?? '').replace(/\s+/g, ' ')
  if (name.length >= MIN_SIGNATURE && flat.toLowerCase().includes(name.toLowerCase())) return clip(name, 160)
  return null
}
