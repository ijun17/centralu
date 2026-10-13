#!/usr/bin/env node
// Wait outside an MCP call: agents can start this in the background and keep working.
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'

const args = process.argv.slice(2)
const ref = args[0] === '--ref' && args.length === 2 && args[1] && !args[1].startsWith('-') ? args[1] : null
const match = args.length === 1 ? /^(?:([\w.-]+\/[\w.-]+))?#?(\d+)$/.exec(args[0]) : null
if (!ref && !match) {
  console.error('Usage: node .centralu/apps/project-board/bin/wait-checks.mjs <pr|owner/repo#pr> | --ref <branch|sha>')
  process.exit(2)
}
const config = JSON.parse(await readFile(new URL('../project.json', import.meta.url), 'utf8'))
const repo = match?.[1] ?? config.repository
const number = match ? Number(match[2]) : null
const label = ref ? `${repo}@${ref}` : `${repo}#${number}`
const every = Math.max(1_000, Number(process.env.PROJECT_BOARD_WAIT_POLL_MS) || 30_000)
const gh = (args) =>
  new Promise((resolve, reject) =>
    execFile('gh', args, { env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_PAGER: '' }, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) =>
      error ? reject(new Error(String(stderr || error.message).trim())) : resolve(stdout),
    ),
  )
const pause = () => new Promise((resolve) => setTimeout(resolve, every))

for (;;) {
  try {
    const sha = ref
      ? JSON.parse(await gh(['api', `repos/${repo}/commits/${encodeURIComponent(ref)}`])).sha
      : JSON.parse(await gh(['pr', 'view', String(number), '-R', repo, '--json', 'headRefOid'])).headRefOid
    const [runs, statuses] = await Promise.all([
      gh(['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`]).then(JSON.parse),
      gh(['api', `repos/${repo}/commits/${sha}/status`]).then(JSON.parse),
    ])
    const checks = [...(runs.check_runs ?? []), ...(statuses.statuses ?? [])]
    if (!checks.length) {
      await pause()
      continue
    }
    const pending = checks.filter((c) => !['completed', 'success', 'failure', 'cancelled', 'timed_out', 'neutral', 'skipped', 'error'].includes(c.status ?? c.state))
    if (pending.length) {
      await pause()
      continue
    }
    const failed = checks.filter((c) => !['success', 'neutral', 'skipped'].includes(c.conclusion ?? c.state))
    console.log(`${label}: ${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `; ${failed.length} failed` : ''}.`)
    process.exit(failed.length ? 1 : 0)
  } catch (error) {
    console.error(`${label}: ${error.message}`)
    process.exit(2)
  }
}
