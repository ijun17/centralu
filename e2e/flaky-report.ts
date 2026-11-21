import { appendFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import type { FullResult, Reporter, Suite, TestCase } from '@playwright/test/reporter'
import { errorMessage } from '@cc/protocol'

/**
 * Names every test that failed and then passed on Playwright's retry (playwright.config.ts `retries`, CI only).
 *
 * Such a test leaves its shard green, so nothing else in the run points at it, and a retry that hides it is how a
 * flaky test stays flaky. So it is told three ways on GitHub Actions: a `::warning::` annotation at the test, a table
 * in the job's summary, and `flaky=true` on the step's outputs, which makes build.yml's `e2e report` job merge the
 * shards' reports (its HTML report has a Flaky filter, with the failed attempt's trace). Elsewhere, plain lines.
 * The same reporter runs in `e2e report` over one engine's merged shards with `E2E_FLAKY_LABEL` set to the engine:
 * there it writes the summary's table alone, under that name, since the shards have annotated each test already.
 * A local run with failures also says which of them the known intermittent failures issue lists (#2373).
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

export interface FlakyTest {
  /** The spec file, relative to the repository */
  file: string
  line: number
  /** Project and describe titles down to the test's own, as Playwright's list reporter shows them */
  title: string
  /** The first line of the first failed attempt's error */
  error: string
}

/** A failed test, with the line Playwright's list reporter names it by: `[project] › file:line:column › titles`, as CI's log has it */
export interface FailedTest extends FlakyTest {
  heading: string
}

/** A test of a finished run as a `FlakyTest`, with the first failed attempt's error */
function asFlakyTest(t: TestCase, cwd: string): FlakyTest {
  const failed = t.results.find((r) => r.status !== 'passed' && r.status !== 'skipped')
  const message = failed?.error?.message ?? failed?.errors[0]?.message ?? `the first attempt ended ${failed?.status ?? 'without passing'}`
  return {
    file: relative(cwd, t.location.file).split('\\').join('/'),
    line: t.location.line,
    title: t.titlePath().filter(Boolean).join(' › '),
    error: stripVTControlCharacters(message).split('\n').find((l) => l.trim())?.trim() ?? '',
  }
}

/** The flaky tests of a finished run, from Playwright's own verdict (`outcome() === 'flaky'`) */
export const flakyTests = (tests: TestCase[], cwd = process.cwd()): FlakyTest[] => tests.filter((t) => t.outcome() === 'flaky').map((t) => asFlakyTest(t, cwd))

/** The tests of a finished run that failed (`outcome() === 'unexpected'`) */
export function failedTests(tests: TestCase[], cwd = process.cwd()): FailedTest[] {
  return tests
    .filter((t) => t.outcome() === 'unexpected')
    .map((t) => {
      const f = asFlakyTest(t, cwd)
      // titlePath: the root's empty title, the project, the file, then the describe titles and the test's own
      const [, project = '', , ...titles] = t.titlePath()
      return { ...f, heading: [`[${project}]`, `${f.file}:${f.line}:${t.location.column}`, ...titles].join(' › ') }
    })
}

const KNOWN_FAILURES = join(ROOT, '.centralu/apps/project-board/known-failures.mjs')

/** The known intermittent failures issue's word on a run's failures: the issue, whether it is closed, a quote or null for each; or why there is none */
export type KnownFailures = { issue: number; closed: boolean; quotes: (string | null)[] } | { why: string }

/** The board's answer (`knownFailureQuotes`) for `n` failures, checked: the board is plain JavaScript without types (the app rules) */
function knownFailuresOf(answer: unknown, n: number): KnownFailures {
  if (typeof answer !== 'object' || answer === null) return { why: 'the board answered nothing' }
  if ('why' in answer && typeof answer.why === 'string') return { why: answer.why }
  const quotes: unknown[] = 'quotes' in answer && Array.isArray(answer.quotes) ? answer.quotes : []
  const checked = quotes.filter((q): q is string | null => q === null || typeof q === 'string')
  const issue = 'issue' in answer ? answer.issue : null
  const closed = 'closed' in answer ? answer.closed : null
  if (typeof issue !== 'number' || typeof closed !== 'boolean' || quotes.length !== n || checked.length !== n) return { why: 'the board answered something else' }
  return { issue, closed, quotes: checked }
}

/**
 * Which of `failed` the known intermittent failures issue quotes, asked of the board app (known-failures.mjs): the issue and
 * the matcher ci_status judges CI's failures by, so a local run and CI set apart the same ones. Each failure is named by its
 * heading, as CI's log names it. `module` is for the tests.
 */
export async function knownFailures(failed: FailedTest[], module = KNOWN_FAILURES): Promise<KnownFailures> {
  try {
    const board: unknown = await import(pathToFileURL(module).href)
    const ask = typeof board === 'object' && board !== null && 'knownFailureQuotes' in board ? board.knownFailureQuotes : null
    if (typeof ask !== 'function') return { why: `${basename(module)} exports no knownFailureQuotes` }
    const answer: unknown = await Reflect.apply(ask, undefined, [failed.map((t) => ({ line: t.heading, error: t.error }))])
    return knownFailuresOf(answer, failed.length)
  } catch (e) {
    return { why: `the board's known-failures reader failed (${errorMessage(e)})` }
  }
}

/**
 * What a local run prints about its failures: the ones the known intermittent failures issue lists, set apart (each with the
 * quote it matched), so a run's own breakage is not read past. A failure stays a failure either way.
 */
export function knownFailureLines(failed: FailedTest[], known: KnownFailures): string[] {
  if (!failed.length) return []
  if ('why' in known) return [`[e2e] known-failures list unavailable: ${known.why}; no failure is set apart`]
  const issue = `#${known.issue}${known.closed ? ', closed' : ''}`
  const matched = failed.flatMap((t, i) => {
    const quote = known.quotes[i]
    return quote ? [{ t, quote }] : []
  })
  if (!matched.length) return [`[e2e] none of the ${failed.length} failure(s) is a known intermittent one (${issue})`]
  return [`[e2e] ${matched.length} of ${failed.length} failure(s) are known intermittent ones (${issue}):`, ...matched.map(({ t, quote }) => `[e2e]   ${t.file}:${t.line} ${t.title}: matches "${quote}"`)]
}

/** What the runner prints: an annotation per test on GitHub Actions, plain lines elsewhere */
export function flakyLines(tests: FlakyTest[], github: boolean): string[] {
  if (!tests.length) return []
  if (github) {
    // Annotation properties end at a comma or a colon, and the message at a newline (GitHub's workflow commands)
    const prop = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C')
    const msg = (s: string) => s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')
    return tests.map((t) => `::warning file=${prop(t.file)},line=${t.line},title=${prop('flaky e2e test')}::${msg(`${t.title} failed, then passed on retry: fix it. First attempt: ${t.error}`)}`)
  }
  return [`[e2e] ${tests.length} test(s) failed, then passed on retry (flaky): fix them`, ...tests.map((t) => `[e2e]   ${t.file}:${t.line} ${t.title}: ${t.error}`)]
}

/** The job summary's table (Markdown), or nothing for a run without a flaky test. `label` names the engine. */
export function flakySummary(tests: FlakyTest[], label?: string): string {
  if (!tests.length) return ''
  const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  return [
    `### ${tests.length} e2e test(s) passed only on retry${label ? ` (${label})` : ''}`,
    '',
    'Each failed once and passed on the retry: a test to fix, not a pass. The `e2e report` artifact has the failed attempt with its trace (filter: Flaky).',
    '',
    '| Test | Where | First attempt |',
    '| --- | --- | --- |',
    ...tests.map((t) => `| ${cell(t.title)} | \`${t.file}:${t.line}\` | ${cell(t.error)} |`),
    '',
  ].join('\n')
}

export default class FlakyReporter implements Reporter {
  private suite: Suite | undefined

  onBegin(_config: unknown, suite: Suite): void {
    this.suite = suite
  }

  async onEnd(_result: FullResult): Promise<void> {
    const all = this.suite?.allTests() ?? []
    const tests = flakyTests(all)
    const github = process.env.GITHUB_ACTIONS === 'true'
    const label = process.env.E2E_FLAKY_LABEL || undefined
    if (!label) for (const line of flakyLines(tests, github)) console.log(line)
    // CI's own check run is matched against the issue by the board (ci_status); a local run has no such reader
    const failed = github ? [] : failedTests(all)
    if (failed.length) for (const line of knownFailureLines(failed, await knownFailures(failed))) console.log(line)
    if (!tests.length || !github) return
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${flakySummary(tests, label)}\n`)
    if (!label && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'flaky=true\n')
  }

  printsToStdio(): boolean {
    return false
  }
}
