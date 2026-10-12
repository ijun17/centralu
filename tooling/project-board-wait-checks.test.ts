import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
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

describe.skipIf(process.platform === 'win32')('wait-checks', () => {
  it('waits outside MCP and prints one settled check summary from fake gh', () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-wait-checks-'))
    const bin = join(dir, 'bin')
    const node = join(dir, 'node')
    mkdirSync(bin)
    mkdirSync(node)
    symlinkSync(process.execPath, join(node, 'node'))
    const fake = String.raw`#!/usr/bin/env node
const a = process.argv.slice(2)
if (a[0] === 'pr') process.stdout.write(JSON.stringify({ headRefOid: 'abc' }))
else if (a[1].includes('/check-runs')) process.stdout.write(JSON.stringify({ check_runs: [{ status: 'completed', conclusion: 'success' }, { status: 'completed', conclusion: 'success' }] }))
else if (a[1].includes('/status')) process.stdout.write(JSON.stringify({ statuses: [] }))
else process.exit(2)
`
    writeFileSync(join(bin, 'gh'), fake)
    chmodSync(join(bin, 'gh'), 0o755)
    const r = spawnSync(process.execPath, [SCRIPT, '77'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${node}`, PROJECT_BOARD_WAIT_POLL_MS: '1' } })
    expect(r.status).toBe(0)
    expect(r.stdout.trim()).toBe('ijun17/centralu#77: 2/2 checks passed.')
  })
})
