// What `pnpm pre-pr` (scripts/pre-pr.mjs) reads in its tools' answers: vitest's JSON report, dependency-cruiser's, and the
// last lines of a tool's output.
import { relFile, testKey } from './pre-pr-stop-reporter.mjs'

/** The last `lines` lines of a tool's output, trimmed. */
export const tail = (text, lines = 25) => String(text ?? '').trim().split('\n').slice(-lines).join('\n')

/** dependency-cruiser's JSON: the files no-orphans names, whatever severity the config gives it. */
export function orphansOf(cruise) {
  return [...new Set((cruise?.summary?.violations ?? []).filter((v) => v?.rule?.name === 'no-orphans').map((v) => v.from))].sort()
}

/** dependency-cruiser's JSON: the error-severity violations other than no-orphans, one sentence each. */
export function depErrorsOf(cruise) {
  const lines = (cruise?.summary?.violations ?? [])
    .filter((v) => v?.rule?.severity === 'error' && v.rule.name !== 'no-orphans')
    .map((v) => {
      const path = v.cycle?.length ? [v.from, ...v.cycle.map((c) => c.name ?? c)].join(' -> ') : `${v.from}${v.to ? ` -> ${v.to}` : ''}`
      return `${path} breaks ${v.rule.name} (tooling/dependency-cruiser.cjs)`
    })
  return [...new Set(lines)].sort()
}

/** vitest's JSON reporter: every test as `{ file, name, status }`, the file relative to `root` with `/`. */
export function vitestTests(report, root) {
  return (report?.testResults ?? []).flatMap((f) =>
    (f.assertionResults ?? []).map((t) => ({
      file: relFile(root, f.name),
      name: [...(t.ancestorTitles ?? []), t.title].join(' > '),
      status: t.status,
    })),
  )
}

/** Why a vitest pass left no report: it was stopped at the limit it was given (`timedOut`, from how it ended), or it did not start or crashed. */
export const noReport = (timedOut, limitMs) =>
  timedOut ? `vitest was stopped after ${Math.round(limitMs / 1000)} s, the most it was given, before it had finished` : 'vitest gave no report (it did not start, or crashed)'

/**
 * How long the slowest of a report's `files` took on its own; 0 when it holds none of them. The guards run in one vitest pass,
 * files side by side, so that is the least one pass takes. The span from the first starting to the last ending would count
 * everything that ran between them in the shared pass.
 */
export function filesRunMs(report, root, files) {
  return Math.max(0, ...(report?.testResults ?? []).filter((f) => files.includes(relFile(root, f.name))).map((f) => f.endTime - f.startTime || 0))
}

/** The tests that pass with the source changes reverted and were not in the base's version of their file. */
export function passingNewTests({ reverted, base }) {
  const before = new Set(base.map((t) => testKey(t.file, t.name)))
  return reverted.filter((t) => t.status === 'passed' && !before.has(testKey(t.file, t.name)))
}

// vitest colours its messages: the escape character is what is stripped
// eslint-disable-next-line no-control-regex
const stripAnsi = (t) => String(t ?? '').replace(/\u001b\[[0-9;]*m/g, '')

/** How many lines of a failure's message a finding keeps: a guard's message names what it found, the stack does not. */
const DETAIL_LINES = 20

/**
 * The failures of a vitest JSON report as `{ file, name, line, detail }`: `line` the first line of the message, `detail` its
 * lines up to the stack, at most DETAIL_LINES. The JSON report carries no diff of what was expected and received: a failure says
 * what its assertion's message says (a guard names there what it found) and vitest's one line of what it expected.
 */
export function failuresOf(report, root) {
  const of = (m) => {
    const lines = stripAnsi(m).split('\n').map((l) => l.trimEnd())
    const end = lines.findIndex((l) => /^\s+at /.test(l))
    const detail = (end < 0 ? lines : lines.slice(0, end)).filter((l) => l.trim()).slice(0, DETAIL_LINES)
    return { line: detail[0]?.trim() ?? 'failed', detail }
  }
  return (report?.testResults ?? []).flatMap((f) => {
    const file = relFile(root, f.name)
    const tests = (f.assertionResults ?? []).filter((t) => t.status === 'failed')
    if (tests.length) return tests.map((t) => ({ file, name: [...(t.ancestorTitles ?? []), t.title].join(' > '), ...of(t.failureMessages?.[0]) }))
    // A file that did not load (or timed out) has no test of its own to fail
    return f.status === 'failed' ? [{ file, name: '', ...of(f.message) }] : []
  })
}

/** Whether the test named `name` (as {@link vitestTests} names it) is one of the guard `g`'s: its pattern read as vitest's `-t` reads it */
export const isGuardTest = (g, name) => new RegExp(g.tests).test(name.replaceAll(' > ', ' '))

/** A failure of {@link failuresOf} as a line names it: its file, and its test when it has one. */
export const failureLabel = (f) => `${f.file}${f.name ? ` > ${f.name}` : ''}`
