import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const ROOT = new URL('../', import.meta.url).pathname
const SCRIPT = join(ROOT, '.centralu/apps/project-board/bin/wait-checks.mjs')
let dir = ''

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = ''
})

function run(args: string[], conclusion = 'success', direct = false, pending = false) {
  dir = mkdtempSync(join(tmpdir(), 'cc-wait-checks-'))
  const bin = join(dir, 'bin')
  const node = join(dir, 'node')
  mkdirSync(bin)
  mkdirSync(node)
  symlinkSync(process.execPath, join(node, 'node'))
  writeFileSync(join(bin, 'gh'), String.raw`#!/usr/bin/env node
const fs = require('node:fs')
const a = process.argv.slice(2)
const log = process.env.FAKE_GH_LOG
const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : []
fs.appendFileSync(log, JSON.stringify(a) + '\n')
if (a[0] === 'pr') process.stdout.write(JSON.stringify({ headRefOid: 'abc' }))
else if (a[1].includes('/check-runs')) {
  const n = calls.filter(c => c[1].includes('/check-runs')).length
  const check = { status: 'completed', conclusion: process.env.FAKE_CONCLUSION }
  const checks = process.env.FAKE_PENDING && n === 0 ? [] : process.env.FAKE_PENDING && n === 1 ? [{ status: 'in_progress' }] : [check, check]
  process.stdout.write(JSON.stringify({ check_runs: checks }))
} else if (a[1].endsWith('/status')) process.stdout.write(JSON.stringify({ statuses: [] }))
else if (a[1].includes('/commits/')) process.stdout.write(JSON.stringify({ sha: 'abc' }))
else process.exit(2)
`)
  chmodSync(join(bin, 'gh'), 0o755)
  const result = spawnSync(direct ? SCRIPT : process.execPath, direct ? args : [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 15_000,
    env: { ...process.env, PATH: `${bin}:${node}`, PROJECT_BOARD_WAIT_POLL_MS: '1', FAKE_GH_LOG: join(dir, 'calls'), FAKE_CONCLUSION: conclusion, FAKE_PENDING: pending ? '1' : '' },
  })
  return { ...result, calls: () => readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]) }
}

describe.skipIf(process.platform === 'win32')('wait-checks', { timeout: 30_000 }, () => {
  it.each(['77', '#77', 'ijun17/centralu#77'])('keeps the pull request form %s', (pr) => {
    const r = run([pr])
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('ijun17/centralu#77: 2/2 checks passed.')
  })

  it('runs directly through its executable shebang', () => {
    const r = run(['77'], 'success', true)
    expect(r.error).toBeUndefined()
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('2/2 checks passed.')
  })

  it.each(['main', 'fix/cache-rate', '0123456789abcdef0123456789abcdef01234567'])('resolves --ref %s and checks its commit', (ref) => {
    const r = run(['--ref', ref])
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe(`ijun17/centralu@${ref}: 2/2 checks passed.`)
    expect(r.calls()).toContainEqual(['api', `repos/ijun17/centralu/commits/${encodeURIComponent(ref)}`])
    expect(r.calls()).toContainEqual(['api', 'repos/ijun17/centralu/commits/abc/check-runs?per_page=100'])
    expect(r.calls().some((a) => a[0] === 'pr')).toBe(false)
  })

  it('waits for absent and pending branch checks before reporting green', () => {
    const r = run(['--ref', 'main'], 'success', false, true)
    expect(r.status).toBe(0)
    expect(r.calls().filter((a) => a[1]?.includes('/check-runs'))).toHaveLength(3)
    expect(r.stdout.trim()).toBe('ijun17/centralu@main: 2/2 checks passed.')
  })

  it('returns failure for a settled failed ref', () => {
    const r = run(['--ref', 'main'], 'failure')
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('0/2 checks passed; 2 failed.')
  })

  it.each([[], ['--ref'], ['--ref', ''], ['--ref', '--bad'], ['77', '--ref', 'main'], ['--ref', 'main', 'extra']].map((args) => ({ args })))('rejects invalid arguments $args', ({ args }) => {
    const r = run(args)
    expect(r.status).toBe(2)
    expect(r.stderr).toContain('Usage:')
  })
})
