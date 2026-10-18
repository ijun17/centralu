import { appendFileSync } from 'node:fs'
import { relative } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import type { FullResult, Reporter, Suite, TestCase } from '@playwright/test/reporter'

/**
 * Names every test that failed and then passed on Playwright's retry (playwright.config.ts `retries`, CI only).
 *
 * Such a test leaves its shard green, so nothing else in the run points at it, and a retry that hides it is how a
 * flaky test stays flaky. So it is told three ways on GitHub Actions: a `::warning::` annotation at the test, a table
 * in the job's summary, and `flaky=true` on the step's outputs, which makes build.yml's `e2e report` job merge the
 * shards' reports (its HTML report has a Flaky filter, with the failed attempt's trace). Elsewhere, plain lines.
 * The same reporter runs in `e2e report` over one engine's merged shards with `E2E_FLAKY_LABEL` set to the engine:
 * there it writes the summary's table alone, under that name, since the shards have annotated each test already.
 */

export interface FlakyTest {
  /** The spec file, relative to the repository */
  file: string
  line: number
  /** Project and describe titles down to the test's own, as Playwright's list reporter shows them */
  title: string
  /** The first line of the first failed attempt's error */
  error: string
}

/** The flaky tests of a finished run, from Playwright's own verdict (`outcome() === 'flaky'`) */
export function flakyTests(tests: TestCase[], cwd = process.cwd()): FlakyTest[] {
  return tests
    .filter((t) => t.outcome() === 'flaky')
    .map((t) => {
      const failed = t.results.find((r) => r.status !== 'passed' && r.status !== 'skipped')
      const message = failed?.error?.message ?? failed?.errors[0]?.message ?? `the first attempt ended ${failed?.status ?? 'without passing'}`
      return {
        file: relative(cwd, t.location.file).split('\\').join('/'),
        line: t.location.line,
        title: t.titlePath().filter(Boolean).join(' › '),
        error: stripVTControlCharacters(message).split('\n').find((l) => l.trim())?.trim() ?? '',
      }
    })
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

  onEnd(_result: FullResult): void {
    const tests = flakyTests(this.suite?.allTests() ?? [])
    const github = process.env.GITHUB_ACTIONS === 'true'
    const label = process.env.E2E_FLAKY_LABEL || undefined
    if (!label) for (const line of flakyLines(tests, github)) console.log(line)
    if (!tests.length || !github) return
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${flakySummary(tests, label)}\n`)
    if (!label && process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, 'flaky=true\n')
  }

  printsToStdio(): boolean {
    return false
  }
}
