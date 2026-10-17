/**
 * The host's start and ending, run for real: `main.ts` started as the keeper and the window start
 * it, with a login shell of the test's own as the first child it spawns (docs/runtime-lessons.md
 * ST16, HO3, HO7); on Windows, which asks no login shell, an agent CLI of the test's own that the
 * host runs when asked which agents are installed. These are the rules a unit test of one module
 * cannot see, because they are about the order `main.ts` takes its steps in.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { PROTOCOL_VERSION } from '@cc/protocol'
import { acquireInstanceLock } from '../dev-services/instance-lock.js'
import { LAUNCH_VARIABLES } from './launch-env.js'
import { SLOW } from '../../../../tooling/test-timing.js'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url))
const MAIN = 'packages/agent-host/src/main.ts'
const posix = process.platform !== 'win32'

const started: ChildProcess[] = []
const dirs: string[] = []
afterEach(async () => {
  // Each host ends before its folder goes: Windows will not delete a folder a live process still has open
  for (const p of started.splice(0)) {
    if (p.exitCode !== null || p.signalCode !== null) continue
    const exited = new Promise((r) => p.once('exit', r))
    p.kill('SIGKILL')
    await exited
  }
  for (const d of dirs.splice(0)) await removeTree(d)
})

/**
 * A data folder, and a login shell that writes the environment it was given to `probe-env` and
 * answers the PATH probe with a folder of its own: the host's first child, spawned by the PATH step.
 *
 * Windows asks no login shell (PA6). Its PATH step adds the folders the tools' installers write to,
 * so one of them is made to exist (`%APPDATA%\npm`) for the step to have something to say.
 */
function setup() {
  const dir = tempRoot('cc-lifecycle-')
  dirs.push(dir)
  const shell = join(dir, 'login-shell')
  const tools = join(dir, 'tools')
  writeFileSync(shell, `#!/bin/sh\nenv > "${join(dir, 'probe-env')}"\necho "__CC_PATH__:${tools}"\n`)
  chmodSync(shell, 0o755)
  const appData = join(dir, 'appdata')
  mkdirSync(join(appData, 'npm'), { recursive: true })
  return {
    dir,
    db: join(dir, 'store.db'),
    shell,
    appData,
    probeEnv: () => readFileSync(join(dir, 'probe-env'), 'utf8'),
    log: () => (existsSync(join(dir, 'host.log')) ? readFileSync(join(dir, 'host.log'), 'utf8') : ''),
  }
}

function env(s: ReturnType<typeof setup>, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...withoutPath(process.env), PATH: process.env.PATH, CC_DATA_DIR: s.dir, SHELL: s.shell, APPDATA: s.appData, CI: '1', ...extra }
}

/**
 * The environment without its PATH, so one can be set: on Windows a copy of `process.env` keeps the
 * spelling Windows stored (`Path`), and a `PATH` added beside it makes two, of which the child sees
 * either.
 */
function withoutPath(e: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(e).filter(([k]) => k.toUpperCase() !== 'PATH'))
}

/** Starts the host and resolves with its port once its ready line is out */
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
  const ready = new Promise<number>((resolve, reject) => {
    p.stdout!.on('data', (d: Buffer) => {
      out += String(d)
      const line = out
        .split('\n')
        .map((l) => l.trim())
        .find((l) => l.includes('"ready":true') && l.endsWith('}'))
      if (line) resolve((JSON.parse(line) as { port: number }).port)
    })
    void exited.then((code) => reject(new Error(`the host exited (${code}) before its ready line:\n${err}`)))
  })
  return { p, ready, exited }
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * An agent CLI as `npm i -g` installs it on Windows, a `.cmd` shim beside its script, that writes
 * the arguments and environment it was given to `<out>/<name>-<pid>.json` and answers `--version`.
 */
function fakeCliOnPath(dir: string, name: string): string {
  const bin = join(dir, 'bin')
  const out = join(dir, 'cli-runs')
  mkdirSync(join(bin, 'node_modules'), { recursive: true })
  mkdirSync(out, { recursive: true })
  writeFileSync(
    join(bin, 'node_modules', `${name}.js`),
    `require('node:fs').writeFileSync(${JSON.stringify(join(out, name))} + '-' + process.pid + '.json', JSON.stringify({ argv: process.argv.slice(2), env: process.env }))\nconsole.log('1.0.0')\n`,
  )
  writeFileSync(join(bin, `${name}.cmd`), `@ECHO off\r\nnode  "%~dp0\\node_modules\\${name}.js" %*\r\n`)
  return bin
}

/** Asks a running host one RPC over its WebSocket, as a window does */
async function rpc(port: number, token: string, method: string, params: unknown): Promise<unknown> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  try {
    return await new Promise((resolve, reject) => {
      ws.on('error', reject)
      ws.on('open', () => ws.send(JSON.stringify({ kind: 'hello', token, protocolVersion: PROTOCOL_VERSION })))
      ws.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as { kind: string; id?: string; ok?: boolean; result?: unknown; error?: unknown }
        if (msg.kind === 'hello_ok') ws.send(JSON.stringify({ kind: 'rpc', id: '1', method, params }))
        else if (msg.kind === 'res' && msg.id === '1') {
          if (msg.ok) resolve(msg.result)
          else reject(new Error(JSON.stringify(msg.error)))
        }
      })
    })
  } finally {
    ws.close()
  }
}

/** What a hello with `token` gets: `hello_ok`, or the close code it was refused with */
function hello(port: number, token: string): Promise<string> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`)
  return new Promise((resolve, reject) => {
    ws.on('error', reject)
    ws.on('open', () => ws.send(JSON.stringify({ kind: 'hello', token, protocolVersion: PROTOCOL_VERSION })))
    ws.on('message', (raw) => {
      if ((JSON.parse(String(raw)) as { kind: string }).kind === 'hello_ok') resolve('hello_ok')
      ws.close()
    })
    ws.on('close', (code) => resolve(`closed ${code}`))
  })
}

describe('the host process, started for real', () => {
  // Windows asks no login shell (PA6), so the host spawns nothing of its own at start; the test below asks it to
  it.skipIf(!posix)("the first child the host spawns sees none of the launcher's variables, the token least of all (ST16)", async () => {
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
  }, 60_000 * SLOW)

  /*
   * #538: the keeper and `centralu serve` no longer put the token in the host's environment, which every process of
   * this user can read for as long as the host runs (#502). They write it as the first line on stdin, and the host
   * reads it before the control channel and the parent watch, which see only what follows.
   */
  it('takes the token from the first line on stdin, and stdin still watches the parent after it (#538)', async () => {
    const s = setup()
    const token = 'token-handed-on-stdin-0123456789'
    const host = startHost(s, ['--watch-parent'], { CC_HOST_TOKEN_ON_STDIN: '1' })
    host.p.stdin!.write(`${JSON.stringify({ token })}\n`)
    const port = await host.ready
    expect(await hello(port, token)).toBe('hello_ok')
    expect(Array.isArray(await rpc(port, token, 'projects.list', {}))).toBe(true)
    expect(await hello(port, 'some-other-token')).toBe('closed 4001')
    host.p.stdin!.end()
    expect(await host.exited).toBe(0)
  }, 60_000 * SLOW)

  it('ends the start, saying why, when the token line the launcher promised is not one', async () => {
    const s = setup()
    const host = startHost(s, ['--watch-parent'], { CC_HOST_TOKEN_ON_STDIN: '1' })
    host.p.stdin!.write('not json\n')
    await expect(host.ready).rejects.toThrow(/did not hand over the token: the token line on stdin is not JSON/)
    expect(await host.exited).toBe(1)
  }, 60_000 * SLOW)

  it.runIf(!posix)("Windows: an agent CLI the host runs, from an npm .cmd shim, sees none of the launcher's variables (ST16)", async () => {
    const s = setup()
    const token = 'launcher-token-not-for-children'
    const bin = fakeCliOnPath(s.dir, 'claude')
    // How the window starts it on Windows: the variables, and stdin as the line to the parent
    const host = startHost(s, ['--watch-parent'], {
      PATH: `${bin};${process.env.PATH}`,
      CC_HOST_TOKEN: token,
      CC_HOST_SOURCE: 'content',
      CC_FRONT_DOOR: 'ws://127.0.0.1:1',
      CC_SERVE: '1',
    })
    const port = await host.ready
    // The window's question "which agents are installed": the host runs `claude --version` and its sign-in check
    const detected = (await rpc(port, token, 'agents.detect', {})) as { name: string; installed: boolean }[]
    expect(detected.find((t) => t.name === 'claude')?.installed).toBe(true)
    const runs = readdirSync(join(s.dir, 'cli-runs'))
    expect(runs.length).toBeGreaterThan(0)
    for (const run of runs) {
      const seen = JSON.parse(readFileSync(join(s.dir, 'cli-runs', run), 'utf8')) as { env: Record<string, string> }
      // Compared by name: a failure must not print the test runner's own environment
      expect(Object.keys(seen.env).filter((n) => (LAUNCH_VARIABLES as readonly string[]).includes(n.toUpperCase()))).toEqual([])
      expect(Object.values(seen.env).some((v) => v.includes(token))).toBe(false)
    }
    host.p.stdin!.end()
    expect(await host.exited).toBe(0)
  }, 60_000 * SLOW)

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
      expect(log.indexOf(`PATH augmented (${posix ? 'login shell' : 'default candidates'})`)).toBeGreaterThan(banner)
      expect(log.indexOf('Another Centralu is already using this data')).toBeGreaterThan(banner)
    } finally {
      if (owner.ok) owner.release()
    }
  }, 60_000 * SLOW)

  it('without --watch-parent the end of stdin means nothing, and a signal still shuts it down (HO7)', async () => {
    const s = setup()
    const host = startHost(s, [])
    await host.ready
    host.p.stdin!.end()
    await settle(1500)
    expect(host.p.exitCode).toBeNull()
    // Windows has no signal to send: Node's kill there is TerminateProcess, which no handler sees
    if (!posix) return
    host.p.kill('SIGTERM')
    expect(await host.exited).toBe(0)
    expect(s.log()).toContain('[agent-host] shutting down (pid')
  }, 60_000 * SLOW)

  it('with --watch-parent the end of stdin is the parent gone, and the host shuts down (HO7)', async () => {
    const s = setup()
    const host = startHost(s, ['--watch-parent'])
    await host.ready
    host.p.stdin!.end()
    expect(await host.exited).toBe(0)
    expect(s.log()).toContain('parent process exited; shutting down')
  }, 60_000 * SLOW)
})
