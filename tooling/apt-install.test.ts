import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTree } from '../packages/agent-host/src/temp-dir.test-helpers.js'
import { SLOW } from './test-timing.js'

const posix = (p: string) => p.replace(/\\/g, '/')
const script = posix(new URL('../.github/scripts/apt-install.sh', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const fallbackScript = script.replace('apt-install.sh', 'apt-fallback-mirror.sh')
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
  function standIn(behaviour: (n: number) => string): { dir: string; log: string; etc: string } {
    const dir = mkdtempSync(join(tmpdir(), 'apt-install-'))
    folders.push(dir)
    const log = posix(join(dir, 'calls.log'))
    const installs = posix(join(dir, 'installs'))
    const etc = posix(join(dir, 'etc'))
    const cases = [1, 2, 3].map((n) => `${n}) ${behaviour(n)} ;;`).join('\n')
    writeFileSync(
      join(dir, 'apt-get'),
      ['#!/bin/sh', `echo "apt-get $*" >> "${log}"`, `[ -e "${etc}/apt.conf.d/99fallback-mirror" ] && echo "  sees: $(head -1 "${etc}/fallback-mirror.list")" >> "${log}"`, 'for a in "$@"; do [ "$a" = install ] && install=1; done', '[ -n "$install" ] || exit 0', `echo x >> "${installs}"`, `n=$(wc -l < "${installs}" | tr -d ' ')`, 'case "$n" in', cases, '*) exit 0 ;;', 'esac', ''].join('\n'),
    )
    chmodSync(join(dir, 'apt-get'), 0o755)
    return { dir: posix(dir), log, etc }
  }

  const run = (dir: string, log: string, etc: string, packages: string[] = ['libfoo-dev', 'libbar-dev'], machine: Record<string, string> = {}) =>
    new Promise<{ status: number | null; out: string }>((resolve) => {
      const child = spawn('bash', [script, ...packages], {
        env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, SUDO: '', TRY_SECONDS: '10', RECOVER: `echo recovered >> "${log}"`, APT_ETC: etc, ARCH: 'amd64', CODENAME: 'noble', ...machine },
      })
      let out = ''
      child.stdout.on('data', (d) => (out += d))
      child.stderr.on('data', (d) => (out += d))
      child.on('close', (status) => resolve({ status, out }))
    })
  const calls = (log: string) => readFileSync(log, 'utf8').trim().split('\n')
  const installs = (log: string) => calls(log).filter((l) => /^apt-get .*install -y/.test(l))

  it('updates, then installs the packages, once when the mirror answers', async () => {
    const { dir, log, etc } = standIn(() => 'exit 0')
    const r = await run(dir, log, etc)
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
    const { dir, log, etc } = standIn((n) => (n === 1 ? 'sleep 300' : 'exit 0'))
    const t = Date.now()
    const r = await run(dir, log, etc)
    expect(r.status, r.out).toBe(0)
    // The first try was ended by its limit (10 s), not waited for (300 s)
    expect(Date.now() - t).toBeLessThan(120_000)
    const lines = calls(log)
    expect(installs(log)).toHaveLength(2)
    // Between the two tries, and only there
    expect(lines.indexOf('recovered')).toBeGreaterThan(lines.findIndex((l) => /install -y/.test(l)))
    expect(lines.indexOf('recovered')).toBeLessThan(lines.findLastIndex((l) => /install -y/.test(l)))
    expect(lines.filter((l) => l === 'recovered')).toHaveLength(1)
    expect(r.out).toContain('::warning::apt try 1 of 2 failed or hit its 10s limit')
    expect(r.out).toContain('Installed in')
  })

  it('retries a try that fails, and fails the step when both do, saying why and keeping to its tries', async () => {
    const retried = standIn((n) => (n === 1 ? 'exit 100' : 'exit 0'))
    expect((await run(retried.dir, retried.log, retried.etc)).status).toBe(0)
    const failing = standIn(() => 'exit 100')
    const r = await run(failing.dir, failing.log, failing.etc)
    expect(r.status).toBe(1)
    expect(installs(failing.log)).toHaveLength(2)
    expect(r.out).toContain('::error::the packages could not be installed in 2 tries of 10s')
  })

  // #2198: 2026-11-11, from about 14:39 to 17:00 UTC, Canonical's mirrors timed out and both tries of every install failed on them
  it.each([
    ['amd64', 'ubuntu'],
    ['arm64', 'ubuntu-ports'],
  ])('asks mirrors outside Canonical on the second try and not on the first (%s)', async (arch, archive) => {
    const { dir, log, etc } = standIn((n) => (n === 1 ? 'exit 100' : 'exit 0'))
    const r = await run(dir, log, etc, undefined, { ARCH: arch, MIRRORS: 'https://one.example https://two.example' })
    expect(r.status, r.out).toBe(0)
    const lines = calls(log)
    const [first, second] = [lines.findIndex((l) => /install -y/.test(l)), lines.findLastIndex((l) => /install -y/.test(l))]
    // Nothing of the fallback before the first try has ended, and every apt-get after it sees it: the update and the install
    expect(lines.slice(0, first + 1).some((l) => l.includes('sees:'))).toBe(false)
    expect(lines.slice(first + 1, second).filter((l) => l.startsWith('  sees:'))).toHaveLength(1)
    expect(lines[second + 1]).toBe(`  sees: deb [signed-by=/usr/share/keyrings/ubuntu-archive-keyring.gpg] mirror+file:${etc}/fallback-mirrors.txt noble main restricted universe multiverse`)
    // The mirrors in the order given, one after the other when one does not answer; the four pockets; the machine's own sources are left out
    expect(readFileSync(join(etc, 'fallback-mirrors.txt'), 'utf8')).toBe(`https://one.example/${archive}/\nhttps://two.example/${archive}/\n`)
    const list = readFileSync(join(etc, 'fallback-mirror.list'), 'utf8').trim().split('\n')
    expect(list.map((l) => l.split(' ')[3])).toEqual(['noble', 'noble-updates', 'noble-backports', 'noble-security'])
    expect(readFileSync(join(etc, 'apt.conf.d', '99fallback-mirror'), 'utf8')).toContain('Dir::Etc::sourceparts "-";')
  })

  it('names Berkeley, MIT and Leaseweb when no mirrors are given', async () => {
    const { dir, log, etc } = standIn((n) => (n === 1 ? 'exit 100' : 'exit 0'))
    expect((await run(dir, log, etc)).status).toBe(0)
    expect(readFileSync(join(etc, 'fallback-mirrors.txt'), 'utf8')).toBe('https://mirrors.ocf.berkeley.edu/ubuntu/\nhttps://mirrors.mit.edu/ubuntu/\nhttps://mirror.leaseweb.com/ubuntu/\n')
  })

  it('does not touch the mirrors when the first try works', async () => {
    const { dir, log, etc } = standIn(() => 'exit 0')
    expect((await run(dir, log, etc)).status).toBe(0)
    expect(existsSync(join(etc, 'fallback-mirror.list'))).toBe(false)
  })

  // The three build.yml second-try steps run the script under `bash -e`, before the install that is their work
  it('never fails its step: a setting it cannot write is a warning, and the same mirrors are tried again', async () => {
    const { dir, log, etc } = standIn((n) => (n === 1 ? 'exit 100' : 'exit 0'))
    // A file where the folder should be: nothing can be made under it
    writeFileSync(join(dir, 'blocked'), '')
    const blocked = `${dir}/blocked/etc`
    const direct = spawnSync('bash', [fallbackScript], { env: { ...process.env, SUDO: '', APT_ETC: blocked, ARCH: 'amd64', CODENAME: 'noble' }, encoding: 'utf8' })
    expect(direct.status).toBe(0)
    expect(direct.stdout).toContain('::warning::the mirror setting could not be written')
    const r = await run(dir, log, etc, undefined, { APT_ETC: blocked })
    expect(r.status, r.out).toBe(0)
    expect(r.out).toContain('::warning::the mirror setting could not be written')
    expect(installs(log)).toHaveLength(2)
  })

  it('fails the step with the same error line when the fallback mirror fails too, and tries the same mirrors again on an architecture it has no fallback for', async () => {
    const failing = standIn(() => 'exit 100')
    const r = await run(failing.dir, failing.log, failing.etc)
    expect(r.status).toBe(1)
    expect(calls(failing.log).some((l) => l.startsWith('  sees:'))).toBe(true)
    expect(r.out).toContain('::error::the packages could not be installed in 2 tries of 10s: the package mirror is slow or down')
    const other = standIn((n) => (n === 1 ? 'exit 100' : 'exit 0'))
    const o = await run(other.dir, other.log, other.etc, undefined, { ARCH: 's390x' })
    expect(o.status, o.out).toBe(0)
    expect(o.out).toContain('::warning::no fallback mirror for the architecture s390x')
    expect(calls(other.log).some((l) => l.startsWith('  sees:'))).toBe(false)
  })

  it('refuses to install nothing', async () => {
    const { dir, log, etc } = standIn(() => 'exit 0')
    const r = await run(dir, log, etc, [])
    expect(r.status).toBe(2)
    expect(r.out).toContain('usage:')
  })
})
