/**
 * The host's start and ending, run for real: `main.ts` started as the keeper and the window start
 * it, with a login shell of the test's own as the first child it spawns (docs/runtime-lessons.md
 * ST16, HO3, HO7). These are the rules a unit test of one module cannot see, because they are about
 * the order `main.ts` takes its steps in.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireInstanceLock } from '../dev-services/instance-lock.js'
import { LAUNCH_VARIABLES } from './launch-env.js'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const MAIN = 'packages/agent-host/src/main.ts'
const posix = process.platform !== 'win32'

const started: ChildProcess[] = []
afterEach(() => {
  for (const p of started.splice(0)) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL')
})

/**
 * A data folder, and a login shell that writes the environment it was given to `probe-env` and
 * answers the PATH probe with a folder of its own: the host's first child, spawned by the PATH step.
 */
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'cc-lifecycle-'))
  const shell = join(dir, 'login-shell')
  const tools = join(dir, 'tools')
  writeFileSync(shell, `#!/bin/sh\nenv > "${join(dir, 'probe-env')}"\necho "__CC_PATH__:${tools}"\n`)
  chmodSync(shell, 0o755)
  return {
    dir,
    db: join(dir, 'store.db'),
    shell,
    probeEnv: () => readFileSync(join(dir, 'probe-env'), 'utf8'),
    log: () => (existsSync(join(dir, 'host.log')) ? readFileSync(join(dir, 'host.log'), 'utf8') : ''),
  }
}

function env(s: ReturnType<typeof setup>, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, CC_DATA_DIR: s.dir, SHELL: s.shell, CI: '1', ...extra }
}

/** Starts the host and resolves once its ready line is out */
function startHost(s: ReturnType<typeof setup>, args: string[], extra: Record<string, string> = {}) {
  const p = spawn(process.execPath, ['--import', 'tsx', MAIN, '--db', s.db, '--port', '0', ...args], {
    cwd: ROOT,
    env: env(s, extra),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  started.push(p)
  let out = ''
  let err = ''
  p.stderr!.on('data', (d: Buffer) => (err += String(d)))
  const exited = new Promise<number | null>((resolve) => p.once('exit', (code) => resolve(code)))
  const ready = new Promise<void>((resolve, reject) => {
    p.stdout!.on('data', (d: Buffer) => {
      out += String(d)
      if (out.includes('"ready":true')) resolve()
    })
    void exited.then((code) => reject(new Error(`the host exited (${code}) before its ready line:\n${err}`)))
  })
  return { p, ready, exited }
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!posix)('the host process, started for real', () => {
  it("the first child the host spawns sees none of the launcher's variables, the token least of all (ST16)", async () => {
    const s = setup()
    const host = startHost(s, [], {
      CC_HOST_TOKEN: 'launcher-token-not-for-children',
      CC_HOST_SOURCE: 'content',
      CC_FRONT_DOOR: 'ws://127.0.0.1:1',
      CC_SERVE: '1',
    })
    await host.ready
    // Compared by name: a failure must not print the test runner's own environment
    const probe = s.probeEnv()
    const names = probe.split('\n').map((line) => line.split('=')[0])
    expect(names.filter((n) => (LAUNCH_VARIABLES as readonly string[]).includes(n!))).toEqual([])
    expect(probe.includes('launcher-token-not-for-children')).toBe(false)
    host.p.kill('SIGTERM')
    expect(await host.exited).toBe(0)
  }, 60_000)

  it('the log is on before PATH and the lock: a refused start says why in host.log, after the banner (HO3)', () => {
    const s = setup()
    const owner = acquireInstanceLock(s.db)
    expect(owner.ok).toBe(true)
    try {
      const r = spawnSync(process.execPath, ['--import', 'tsx', MAIN, '--db', s.db, '--port', '0'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        env: env(s),
      })
      expect(r.status).toBe(1)
      const log = s.log()
      const banner = log.indexOf('[agent-host] started')
      expect(banner).toBeGreaterThanOrEqual(0)
      expect(log.indexOf('PATH augmented (login shell)')).toBeGreaterThan(banner)
      expect(log.indexOf('Another Centralu is already using this data')).toBeGreaterThan(banner)
    } finally {
      if (owner.ok) owner.release()
    }
  }, 60_000)

  it('without --watch-parent the end of stdin means nothing, and a signal still shuts it down (HO7)', async () => {
    const s = setup()
    const host = startHost(s, [])
    await host.ready
    host.p.stdin!.end()
    await settle(1500)
    expect(host.p.exitCode).toBeNull()
    host.p.kill('SIGTERM')
    expect(await host.exited).toBe(0)
    expect(s.log()).toContain('[agent-host] shutting down (pid')
  }, 60_000)

  it('with --watch-parent the end of stdin is the parent gone, and the host shuts down (HO7)', async () => {
    const s = setup()
    const host = startHost(s, ['--watch-parent'])
    await host.ready
    host.p.stdin!.end()
    expect(await host.exited).toBe(0)
    expect(s.log()).toContain('parent process exited; shutting down')
  }, 60_000)
})
