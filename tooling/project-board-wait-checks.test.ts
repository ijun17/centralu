import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { fakeExe, linkNode, rmFakeDir } from '../packages/agent-host/src/fake-exe.test-helpers.js'
import { SLOW } from './test-timing.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SCRIPT = join(ROOT, '.centralu/apps/project-board/bin/wait-checks.mjs')
const SHA = 'abc1234' + '0'.repeat(33)
let dir = ''

afterEach(() => {
  if (dir) rmFakeDir(dir)
  dir = ''
})

function run(args: string[], conclusion = 'success', direct = false, pending = false, scenario = '') {
  dir = mkdtempSync(join(tmpdir(), 'cc-wait-checks-'))
  const bin = join(dir, 'bin')
  const node = join(dir, 'node')
  mkdirSync(bin)
  linkNode(node)
  fakeExe(bin, 'gh', String.raw`#!/usr/bin/env node
const fs = require('node:fs')
const a = process.argv.slice(2)
const log = process.env.FAKE_GH_LOG
const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []
fs.appendFileSync(log, JSON.stringify(a) + '\n')
const scenario = process.env.FAKE_SCENARIO
if (scenario === 'hung') setInterval(() => {}, 1_000)
const workflowPolls = calls.filter(c => c[1].includes('/actions/runs?')).length
if (a[0] === 'pr') process.stdout.write(JSON.stringify({ headRefOid: process.env.FAKE_SHA }))
else if (a[1].includes('/actions/runs?')) {
  const done = { status: 'completed' }
  let pages = [{ workflow_runs: [done] }]
  if (scenario === 'missing' && workflowPolls === 0) pages = [{ workflow_runs: [] }]
  if (scenario === 'cancelled') pages = [{ workflow_runs: [done, { status: workflowPolls === 0 ? 'in_progress' : 'completed' }] }]
  if (scenario === 'late') pages = [
    { workflow_runs: Array.from({ length: 100 }, () => done) },
    { workflow_runs: [{ status: workflowPolls === 0 ? 'queued' : 'completed' }] },
  ]
  process.stdout.write(JSON.stringify(pages))
} else if (a[1].includes('/check-runs')) {
  const n = calls.filter(c => c[1].includes('/check-runs')).length
  const conclusion = scenario === 'late' && workflowPolls >= 2 ? 'failure'
    : (scenario === 'cancelled' && workflowPolls < 2) || a[1].includes('/def5678/') ? 'cancelled'
    : process.env.FAKE_CONCLUSION
  const check = { status: 'completed', conclusion }
  const checks = scenario === 'moving' && n === 0 ? [{ status: 'in_progress' }] : process.env.FAKE_PENDING && n === 0 ? [] : process.env.FAKE_PENDING && n === 1 ? [{ status: 'in_progress' }] : [check, check]
  process.stdout.write(JSON.stringify({ check_runs: checks }))
} else if (a[1].endsWith('/status')) process.stdout.write(JSON.stringify({ statuses: [] }))
else if (a[1].includes('/commits/')) {
  const resolved = calls.some(c => c[1] === a[1])
  process.stdout.write(JSON.stringify({ sha: scenario === 'moving' && resolved ? 'def5678' : process.env.FAKE_SHA }))
} else process.exit(2)
`)
  const result = spawnSync(direct ? SCRIPT : process.execPath, direct ? args : [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 25_000,
    env: { ...process.env, PATH: `${bin}${delimiter}${node}`, PROJECT_BOARD_WAIT_POLL_MS: '1', FAKE_GH_LOG: join(dir, 'calls'), FAKE_CONCLUSION: conclusion, FAKE_SHA: SHA, FAKE_SCENARIO: scenario, FAKE_PENDING: pending ? '1' : '' },
  })
  return { ...result, calls: () => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]) }
}

describe('wait-checks', { timeout: 30_000 * SLOW }, () => {
  it.each(['77', '#77', 'ijun17/centralu#77'])('keeps the pull request form %s', (pr) => {
    const r = run([pr])
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('ijun17/centralu#77: 2/2 checks passed.')
  })

  // The tools' own reading of a pull request (parseItemRef): a missing # used to be read as part of
  // the name, so owner/name77 waited on owner/name7#7
  it('reads a pull request as the board tools do, and refuses a reference without its #', () => {
    expect(run(['https://github.com/ijun17/centralu/pull/77']).stdout.trim()).toBe('ijun17/centralu#77: 2/2 checks passed.')
    const r = run(['ijun17/centralu77'])
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Usage:')
    expect(r.calls).toThrow()
  })

  // Windows starts no program through a `#!` line, so there is no direct run to check there
  it.skipIf(process.platform === 'win32')('runs directly through its executable shebang', () => {
    const r = run(['77'], 'success', true)
    expect(r.error).toBeUndefined()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('2/2 checks passed.')
  })

  it.each(['main', 'fix/cache-rate', '0123456789abcdef0123456789abcdef01234567'])('resolves --ref %s and checks its commit', (ref) => {
    const r = run(['--ref', ref])
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(`ijun17/centralu@${ref} (abc1234): 2/2 checks passed.`)
    expect(r.calls()).toContainEqual(['api', `repos/ijun17/centralu/commits/${encodeURIComponent(ref)}`])
    expect(r.calls()).toContainEqual(['api', `repos/ijun17/centralu/commits/${SHA}/check-runs?per_page=100`])
    expect(r.calls().some((a) => a[0] === 'pr')).toBe(false)
  })

  it('waits for absent and pending branch checks before reporting green', () => {
    const r = run(['--ref', 'main'], 'success', false, true)
    expect(r.status).toBe(0)
    expect(r.calls().filter((a) => a[1]?.includes('/check-runs'))).toHaveLength(3)
    expect(r.stdout.trim()).toBe('ijun17/centralu@main (abc1234): 2/2 checks passed.')
  })

  it('pins a moving branch once and reports the original SHA', () => {
    const r = run(['--ref', 'main'], 'success', false, false, 'moving')
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('ijun17/centralu@main (abc1234): 2/2 checks passed.')
    expect(r.calls().filter((a) => a[1] === 'repos/ijun17/centralu/commits/main')).toHaveLength(1)
    expect(r.calls().some((a) => a[1]?.includes('def5678'))).toBe(false)
  })

  it('waits for a late-registering workflow on the next page before reporting its failure', () => {
    const r = run(['--ref', 'main'], 'success', false, false, 'late')
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('0/2 checks passed; 2 failed.')
    const polls = r.calls().filter((a) => a[1]?.includes('/actions/runs?'))
    expect(polls).toHaveLength(2)
    expect(polls[0]).toEqual(['api', `repos/ijun17/centralu/actions/runs?head_sha=${SHA}&per_page=100`, '--paginate', '--slurp'])
  })

  it('does not read a cancelled check while its replacement workflow is running', () => {
    const r = run(['--ref', 'main'], 'success', false, false, 'cancelled')
    expect(r.status).toBe(0)
    const calls = r.calls()
    const firstCheck = calls.findIndex((a) => a[1]?.includes('/check-runs'))
    expect(calls.slice(0, firstCheck).filter((a) => a[1]?.includes('/actions/runs?'))).toHaveLength(2)
  })

  it('waits for workflow runs to be registered even when checks are already green', () => {
    const r = run(['--ref', 'main'], 'success', false, false, 'missing')
    expect(r.status).toBe(0)
    expect(r.calls().filter((a) => a[1]?.includes('/actions/runs?'))).toHaveLength(2)
  })

  it.each([
    ['--ref', 'main', '--timeout-minutes', '1'],
    ['--timeout-minutes', '1', '77'],
  ])('accepts a deadline with ref and pull request arguments: %j', (...args) => {
    expect(run(args).status).toBe(0)
  })

  it('enforces the CLI deadline even when a gh subprocess never exits', () => {
    const r = run(['--ref', 'main', '--timeout-minutes', '0.01'], 'success', false, false, 'hung')
    expect(r.error).toBeUndefined()
    expect(r.status).toBe(6)
    expect(r.stdout).toContain('timed out after 0.01 minutes')
  })

  it('returns failure for a settled failed ref', () => {
    const r = run(['--ref', 'main'], 'failure')
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('0/2 checks passed; 2 failed.')
  })

  it.each([[], ['--ref'], ['--ref', ''], ['--ref', '--bad'], ['77', '--ref', 'main'], ['--ref', 'main', 'extra'], ['77', '--timeout-minutes'], ['77', '--timeout-minutes', '0'], ['77', '--timeout-minutes', '-1'], ['77', '--timeout-minutes', 'NaN'], ['77', '--timeout-minutes', 'Infinity'], ['77', '--timeout-minutes', '1', '--timeout-minutes', '2']].map((args) => ({ args })))('rejects invalid arguments $args', ({ args }) => {
    const r = run(args)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Usage:')
  })
})
