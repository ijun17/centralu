import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTree } from '../packages/agent-host/src/temp-dir.test-helpers.js'
import { SLOW } from './test-timing.js'

const posix = (p: string) => p.replace(/\\/g, '/')
const script = posix(new URL('../.github/scripts/apt-install.sh', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
// The script is the Linux runner's (its apt): `timeout` and `env` are coreutils'. Windows runs it only when a person asks, in Git's bash.
const hasCoreutils = (process.platform !== 'win32' || process.env.APT_INSTALL_TEST_BASH === '1') && spawnSync('bash', ['-c', 'timeout --version']).status === 0

/*
 * 2026-11-05: `keeper e2e (linux)` waited in `apt-get update && apt-get install` until its job limit, twice, and the job
 * was cancelled. The install is a script now: each try limited, one retry. The stand-in `apt-get` is a script in a folder
 * of its own at the front of PATH; nothing of the machine's apt runs (`SUDO` empty, `RECOVER` ours).
 */
describe.skipIf(!hasCoreutils)('apt-install.sh: a stuck mirror costs a retry, not the job', { timeout: 60_000 * SLOW }, () => {
  const folders: string[] = []
  afterEach(async () => {
    for (const dir of folders.splice(0)) await removeTree(dir)
  })

  /** A folder with an `apt-get` that does `behaviour(n)` (shell) on its n-th `install` and logs every call */
  function standIn(behaviour: (n: number) => string): { dir: string; log: string } {
    const dir = mkdtempSync(join(tmpdir(), 'apt-install-'))
    folders.push(dir)
    const log = posix(join(dir, 'calls.log'))
    const installs = posix(join(dir, 'installs'))
    const cases = [1, 2, 3].map((n) => `${n}) ${behaviour(n)} ;;`).join('\n')
    writeFileSync(
      join(dir, 'apt-get'),
      ['#!/bin/sh', `echo "apt-get $*" >> "${log}"`, 'for a in "$@"; do [ "$a" = install ] && install=1; done', '[ -n "$install" ] || exit 0', `echo x >> "${installs}"`, `n=$(wc -l < "${installs}" | tr -d ' ')`, 'case "$n" in', cases, '*) exit 0 ;;', 'esac', ''].join('\n'),
    )
    chmodSync(join(dir, 'apt-get'), 0o755)
    return { dir: posix(dir), log }
  }

  const run = (dir: string, log: string, packages: string[] = ['libfoo-dev', 'libbar-dev']) =>
    new Promise<{ status: number | null; out: string }>((resolve) => {
      const child = spawn('bash', [script, ...packages], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SUDO: '', TRY_SECONDS: '2', RECOVER: `echo recovered >> "${log}"` },
      })
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (out += d))
      child.on('close', (status) => resolve({ status, out }))
    })
  const calls = (log: string) => readFileSync(log, 'utf8').trim().split('\n')
  const installs = (log: string) => calls(log).filter((l) => /^apt-get .*install -y/.test(l))

  it('updates, then installs the packages, once when the mirror answers', async () => {
    const { dir, log } = standIn(() => 'exit 0')
    const r = await run(dir, log)
    expect(r.status).toBe(0)
    const lines = calls(log)
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatch(/^apt-get .*update$/)
    expect(lines[1]).toMatch(/^apt-get .*install -y libfoo-dev libbar-dev$/)
    // apt gives up on a connection that is silent, and retries a download
    expect(lines[1]).toContain('Acquire::http::Timeout=30')
    expect(lines[1]).toContain('Acquire::Retries=2')
  })

  it('stops a try that hits its limit, puts the machine right, and tries once more', async () => {
    const { dir, log } = standIn((n) => (n === 1 ? 'sleep 30' : 'exit 0'))
    const t = Date.now()
    const r = await run(dir, log)
    expect(r.status, r.out).toBe(0)
    // The first try was ended by its limit (2 s), not waited for (30 s)
    expect(Date.now() - t).toBeLessThan(25_000)
    const lines = calls(log)
    expect(installs(log)).toHaveLength(2)
    // Between the two tries, and only there
    expect(lines.indexOf('recovered')).toBeGreaterThan(lines.findIndex((l) => /install -y/.test(l)))
    expect(lines.indexOf('recovered')).toBeLessThan(lines.findLastIndex((l) => /install -y/.test(l)))
    expect(lines.filter((l) => l === 'recovered')).toHaveLength(1)
    expect(r.out).toContain('::warning::apt try 1 of 2 failed or hit its 2s limit')
    expect(r.out).toContain('Installed in')
  })

  it('retries a try that fails, and fails the step when both do, saying why and keeping to its tries', async () => {
    const retried = standIn((n) => (n === 1 ? 'exit 100' : 'exit 0'))
    expect((await run(retried.dir, retried.log)).status).toBe(0)
    const failing = standIn(() => 'exit 100')
    const r = await run(failing.dir, failing.log)
    expect(r.status).toBe(1)
    expect(installs(failing.log)).toHaveLength(2)
    expect(r.out).toContain('::error::the packages could not be installed in 2 tries of 2s')
  })

  it('refuses to install nothing', async () => {
    const { dir, log } = standIn(() => 'exit 0')
    const r = await run(dir, log, [])
    expect(r.status).toBe(2)
    expect(r.out).toContain('usage:')
  })
})
