import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { FullConfig, Reporter, TestCase, TestResult } from '@playwright/test/reporter'
import { compareReports, formatReport, makeReport, type PendingTask, type Report, type TaskResult } from './klm.js'

/**
 * Collects every task's result into one report (#518): a JSON file (`UX_REPORT`, by default
 * `test-results/ux-report.json`), the table on stdout, and in GitHub Actions the same table in the
 * job's summary. With `UX_BASELINE` set to an earlier report, it also prints the comparison.
 *
 * The results travel as test attachments, not files a test writes, so they survive sharding and
 * a blob merge like any other attachment.
 */
export default class UxReporter implements Reporter {
  private readonly tasks: TaskResult[] = []
  private readonly pending: PendingTask[] = []
  private engine = 'unknown'

  onBegin(config: FullConfig): void {
    this.engine = String(config.projects[0]?.use.browserName ?? 'chromium')
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    for (const a of result.attachments) {
      if (a.name === 'ux-task' && a.body) this.tasks.push(JSON.parse(a.body.toString('utf8')) as TaskResult)
    }
    for (const a of test.annotations) {
      if (a.type === 'ux-pending' && a.description) this.pending.push(JSON.parse(a.description) as PendingTask)
    }
  }

  onEnd(): void {
    // A retry would report the same task twice; the last one counts
    const tasks = [...new Map(this.tasks.map((t) => [t.id, t])).values()]
    const pending = [...new Map(this.pending.map((p) => [p.id, p])).values()]
    const report = makeReport(this.engine, tasks, pending)
    const out = resolve(process.env.UX_REPORT ?? 'test-results/ux-report.json')
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)

    const sections = [`## Task cost (KLM, ${this.engine})`, '', formatReport(report)]
    const baselinePath = process.env.UX_BASELINE
    if (baselinePath) {
      const baseline = JSON.parse(readFileSync(resolve(baselinePath), 'utf8')) as Report
      sections.push('', `### Against ${baselinePath}`, '', compareReports(baseline, report))
    }
    const text = sections.join('\n')
    console.log(`\n${text}\n\nWritten to ${out}`)
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`)
  }

  printsToStdio(): boolean {
    return false
  }
}
