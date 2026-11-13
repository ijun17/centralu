#!/usr/bin/env node
// Wait outside an MCP call: agents can start this in the background and keep working.
import { readFile } from 'node:fs/promises'
import { runProgram } from '../system.mjs'
import { DEFAULT_TIMEOUT_MS, waitForChecks } from '../wait-checks.mjs'

const args = process.argv.slice(2)
const timeoutAt = args.indexOf('--timeout-minutes')
let timeoutMs = DEFAULT_TIMEOUT_MS
let validTimeout = true
if (timeoutAt >= 0) {
  const minutes = Number(args[timeoutAt + 1])
  validTimeout = Number.isFinite(minutes) && minutes > 0 && minutes * 60_000 <= Number.MAX_SAFE_INTEGER
  timeoutMs = minutes * 60_000
  args.splice(timeoutAt, 2)
}
const ref = args[0] === '--ref' && args.length === 2 && args[1] && !args[1].startsWith('-') ? args[1] : null
const config = JSON.parse(await readFile(new URL('../project.json', import.meta.url), 'utf8'))
// A pull request's checks are a watch the host keeps: mail(action="watch", to="#123")
if (!validTimeout || !ref) {
  console.error('Usage: node .centralu/apps/project-board/bin/wait-checks.mjs --ref <branch|sha> [--timeout-minutes <minutes>]')
  process.exit(2)
}
const gh = (args, { timeoutMs }) =>
  runProgram('gh', args, {
    env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_PAGER: '' },
    maxBuffer: 16 * 1024 * 1024,
    timeoutMs: Math.max(1, Math.ceil(timeoutMs)), // 0 would mean no limit
    killSignal: 'SIGKILL',
  }).then(
    (r) => r.stdout,
    (e) => {
      throw new Error(String(e.stderr || e.message).trim())
    },
  )
const result = await waitForChecks({
  repo: config.repository,
  ref,
  timeoutMs,
  pollMs: Math.max(1_000, Number(process.env.PROJECT_BOARD_WAIT_POLL_MS) || 30_000),
}, { gh, onRetry: (message) => console.error(message) })
if (result.code === 2) console.error(result.message)
else console.log(result.message)
process.exit(result.code)
