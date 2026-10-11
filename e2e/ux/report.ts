import { readFileSync } from 'node:fs'
import { compareReports, formatReport, type Report } from './klm.js'

/**
 * Reads task-cost reports (#518, docs/ux-metrics.md).
 *
 *   pnpm ux:report <report.json>                  the table
 *   pnpm ux:report --compare <a.json> <b.json>    a against b, task by task
 */
const args = process.argv.slice(2)
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as Report

if (args[0] === '--compare' && args.length === 3) {
  console.log(compareReports(read(args[1]!), read(args[2]!)))
} else if (args.length === 1 && !args[0]!.startsWith('--')) {
  console.log(formatReport(read(args[0]!)))
} else {
  console.error('usage: pnpm ux:report <report.json> | pnpm ux:report --compare <a.json> <b.json>')
  process.exit(2)
}
