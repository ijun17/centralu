/**
 * The host's start and ending, run for real: `main.ts` started as the keeper and the window start
 * it, with a login shell of the test's own as the first child it spawns
 * (docs/runtime-lessons/who-starts-what.md ST16, docs/runtime-lessons/host-contract.md HO3, HO7); on Windows, which
 * asks no login shell, an agent CLI of the test's own that the host runs when asked which agents are installed.
 * These are the rules a unit test of one module cannot see, because they are about the order `main.ts` takes its steps in.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { PROTOCOL_VERSION, sessionLiveDefaults } from '@cc/protocol'
import { acquireInstanceLock } from '../dev-services/instance-lock.js'
import { Store } from '../dev-services/store.js'
import { SYSTEM_END_FILE } from './system-end.js'
import { LAUNCH_VARIABLES } from './launch-env.js'
import { SLOW } from '../../../../tooling/test-timing.js'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { alive, pidIn } from '../process.test-helpers.js'

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

  /*
   * #1895 step 4 PR 5: only a keeper of an earlier build starts a host with `--standby`, to swap the host it runs to this
   * build. This build swaps nothing: it exits before it writes anything in the data folder, so that keeper's swap fails
   * and its running host, which holds the folder, is untouched.
   */
  it('a host started to stand by for a swap exits 1 before it touches the data folder', () => {
    const s = setup()
    const r = spawnSync(process.execPath, ['--import', 'tsx', MAIN, '--db', s.db, '--port', '0', '--standby'], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 60_000,
      env: env(s, { CC_KEEPER: '1' }),
    })
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('not standing by: this build does not swap hosts')
    // stdout too: an earlier keeper shows a standby's last plain lines as the reason its swap failed
    expect(r.stdout).toContain('quit Centralu completely')
    for (const f of ['host.log', 'host.lock', 'store.db']) expect(existsSync(join(s.dir, f)), f).toBe(false)
  }, 60_000 * SLOW)

  /*
   * #1223: on a linked Windows machine the folder is often held by the host a hub's link started. host.lock says who
   * started it and from where, and a second host on the folder (the desktop window's) says so instead of "close the
   * running window", which sent the person looking for a window that was not there.
   */
  it('says in host.lock that centralu serve started it for a hub, and a second host names that link in its refusal', async () => {
    const s = setup()
    const token = 'token-handed-on-stdin-0123456789'
    const host = startHost(s, ['--watch-parent'], {
      CC_HOST_TOKEN_ON_STDIN: '1',
      CC_SERVE: '1',
      CC_SERVE_FROM: JSON.stringify({ hub: 'Mac-mini', ssh: '192.168.0.5' }),
    })
    host.p.stdin!.write(`${JSON.stringify({ token })}\n`)
    await host.ready
    try {
      const lock = JSON.parse(readFileSync(join(dirname(s.db), 'host.lock'), 'utf8')) as Record<string, unknown>
      expect(lock).toMatchObject({ pid: host.p.pid, by: 'serve', from: { hub: 'Mac-mini', ssh: '192.168.0.5' } })
      expect(typeof lock.at).toBe('number')
      const second = spawnSync(process.execPath, ['--import', 'tsx', MAIN, '--db', s.db, '--port', '0'], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 60_000,
        env: env(s, { CC_STARTED_BY: 'app' }),
      })
      expect(second.status).toBe(1)
      expect(second.stdout).toContain('Another Centralu is already using this data: the host `centralu serve` runs for the link from Mac-mini')
      expect(second.stdout).toContain('the link from Mac-mini loses this computer until it reconnects')
    } finally {
      host.p.stdin!.end()
    }
    expect(await host.exited).toBe(0)
  }, 60_000 * SLOW)

  /*
   * #1902: an update's stop ends every terminal and Run command; the host that starts next on the data folder opens the terminals
   * again and starts the commands again. Which stop lists them, and that the start brings them back before it listens, are about
   * the order main.ts takes its steps in, so it is asked of real hosts: a plain stop must bring back nothing. The stop for an update
   * comes the ways a host is stopped in order: `host.stop { forUpdate }` over the socket, from a linked hub through `centralu
   * serve`, and, from the desktop window that is the host's parent (#1895), a line on the host's stdin, since that window speaks no
   * WebSocket and `host.stop` is refused to a host the app runs.
   */
  type Running = { p: ChildProcess; port: number }
  const stops = {
    hub: {
      env: { CC_SERVE: '1' },
      update: async (h: Running, token: string) => expect(await rpc(h.port, token, 'host.stop', { forUpdate: true })).toMatchObject({ ok: true }),
      plain: async (h: Running, token: string) => expect(await rpc(h.port, token, 'host.stop', {})).toMatchObject({ ok: true }),
    },
    window: {
      env: { CC_STARTED_BY: 'app' },
      update: async (h: Running) => void h.p.stdin!.write(`${JSON.stringify({ op: 'stop', forUpdate: true })}\n`),
      // The window quitting: its end of the pipe closes
      plain: async (h: Running) => void h.p.stdin!.end(),
    },
    // The keeper that holds no children (#1895 step 3): "Apply now" stops the host for an update by its line, "Quit completely" by a plain one
    keeper: {
      env: { CC_KEEPER: '1' },
      update: async (h: Running) => void h.p.stdin!.write(`${JSON.stringify({ op: 'stop', forUpdate: true })}\n`),
      plain: async (h: Running) => void h.p.stdin!.write(`${JSON.stringify({ op: 'stop' })}\n`),
    },
  }
  // An update stop that never reaches the host is a failure in seconds, not the runner's timeout
  const exitsSoon = (h: { exited: Promise<number | null> }) => Promise.race([h.exited, settle(30_000 * SLOW).then(() => 'still running')])
  const bringsBack = async (how: (typeof stops)[keyof typeof stops]) => {
    const s = setup()
    const token = 'token-handed-on-stdin-0123456789'
    const project = join(s.dir, 'project')
    mkdirSync(project)
    // A command that stays running. `sleep` is on every login shell's PATH (node is not, on a runner that installs it elsewhere)
    const run = posix ? 'sleep 600' : 'node -e "setInterval(() => {}, 1000)"'
    const boot = async () => {
      // The host runs a Run command through `$SHELL -lc`: setup()'s SHELL is a script that only answers the PATH probe and ends,
      // so a command run through it ends at once and is not one the stop can list. A real shell, as a person's is
      const host = startHost(s, ['--watch-parent'], { CC_HOST_TOKEN_ON_STDIN: '1', ...how.env, ...(posix ? { SHELL: '/bin/sh' } : {}) })
      host.p.stdin.write(`${JSON.stringify({ token })}
`)
      return { ...host, port: await host.ready }
    }
    const state = async (port: number, projectId: string) => ({
      terminals: ((await rpc(port, token, 'terminal.list', { projectId })) as { terminals: { title: string; history: string }[] }).terminals,
      runs: ((await rpc(port, token, 'commands.state', { projectId })) as { runs: { command: string; running: boolean }[] }).runs,
    })

    const first = await boot()
    const { id } = (await rpc(first.port, token, 'projects.add', { path: project })) as { id: string }
    await rpc(first.port, token, 'terminal.create', { projectId: id, cols: 90, rows: 20 })
    await rpc(first.port, token, 'commands.run', { projectId: id, command: run })
    // It is running when the stop comes: what the stop lists is what is running
    expect((await state(first.port, id)).runs).toEqual([expect.objectContaining({ command: run, running: true })])
    await how.update(first, token)
    expect(await exitsSoon(first)).toBe(0)

    // The update's stop listed them: the next host has a terminal with nothing in it but its own start, and the command running again
    const second = await boot()
    const back = await state(second.port, id)
    expect(back.terminals.map((t) => t.title)).toEqual(['Terminal 1'])
    expect(back.runs).toEqual([expect.objectContaining({ command: run, running: true })])
    const log = (await rpc(second.port, token, 'commands.log', { projectId: id, command: run })) as { run: { history: string } | null }
    expect(log.run?.history.startsWith('Started again after the update.')).toBe(true)

    // A plain stop, then a start: nothing comes back, and no list was left behind
    await how.plain(second, token)
    expect(await second.exited).toBe(0)
    expect(readdirSync(s.dir).filter((n) => n.startsWith('update-resume.'))).toEqual([])
    const third = await boot()
    expect(await state(third.port, id)).toEqual({ terminals: [], runs: [] })
    await how.plain(third, token)
    expect(await third.exited).toBe(0)
  }
  it('an update stop brings the terminals and Run commands back at the next start, and a plain stop does not (#1902)', () => bringsBack(stops.hub), 180_000 * SLOW)
  it("the same for the window's stop line on the host's stdin (#1895)", () => bringsBack(stops.window), 180_000 * SLOW)
  it("the same for the keeper's stop line, which a keeper with no child service sends (#1895 step 3)", () => bringsBack(stops.keeper), 180_000 * SLOW)

  /*
   * #2141 re-check: on Windows a stop of a terminal or a Run command reads the process table before it ends the tree, and the host used to exit
   * (its stdin closed, as the keeper's stop does) while that was still going: what the shell had started in a window of its own was
   * never ended. The shutdown waits for the stops it started (`stopsSettled`).
   */
  it.runIf(!posix)('Windows: a stop of the host ends what two terminals started hidden, before the host is gone (#2141)', async () => {
    const s = setup()
    const project = join(s.dir, 'project')
    mkdirSync(project)
    const idle = join(s.dir, 'idle.js')
    writeFileSync(idle, "require('node:fs').writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000)")
    const pidFiles = [join(s.dir, 'hidden-1.pid'), join(s.dir, 'hidden-2.pid')]
    const host = startHost(s, ['--watch-parent'], { CC_HOST_TOKEN_ON_STDIN: '1', CC_KEEPER: '1' })
    host.p.stdin.write(JSON.stringify({ token }) + String.fromCharCode(10))
    const port = await host.ready
    let hidden: number[] = []
    try {
      const { id } = (await rpc(port, token, 'projects.add', { path: project })) as { id: string }
      // Terminals, as the person's: each shell is a pty child, and the line is typed to it
      const terminals = await Promise.all(pidFiles.map(() => rpc(port, token, 'terminal.create', { projectId: id, cols: 500, rows: 20 }) as Promise<{ terminalId: string }>))
      await settle(4000) // the shells are up before they are typed to
      await Promise.all(
        terminals.map((t, i) => rpc(port, token, 'terminal.input', { terminalId: t.terminalId, data: `Start-Process -WindowStyle Hidden -FilePath node -ArgumentList '${idle}','${pidFiles[i]!}'` + String.fromCharCode(13) })),
      )
      hidden = await Promise.all(pidFiles.map((file) => pidIn(file, 30_000 * SLOW)))
      host.p.stdin.end()
      expect(await exitsSoon(host)).toBe(0)
      expect(hidden.filter(alive)).toEqual([])
    } finally {
      for (const pid of hidden) if (alive(pid)) process.kill(pid)
    }
  }, 180_000 * SLOW)

  /*
   * #1143 under a keeper that holds no children (#1895 step 3): its stop for good came as `stop` on the child service, which said the
   * person quit. With no service it comes as a plain line on stdin, and must still leave the mark; its stop for an update must not
   */
  it("the keeper's plain stop line notes that the person quit, and its stop for an update does not", async () => {
    for (const [line, quit] of [[{ op: 'stop' }, true], [{ op: 'stop', forUpdate: true }, false]] as const) {
      const s = setup()
      const host = startHost(s, ['--watch-parent'], { CC_KEEPER: '1' })
      await host.ready
      host.p.stdin.write(`${JSON.stringify(line)}\n`)
      expect(await exitsSoon(host)).toBe(0)
      expect(s.log()).toContain(`asked to stop (the keeper${quit ? '' : ', for an update'})`)
      const mark = join(s.dir, 'stopped.json')
      expect(existsSync(mark) && readFileSync(mark, 'utf8').includes('"quit"'), JSON.stringify(line)).toBe(quit)
    }
  }, 120_000 * SLOW)

  it("the window's stop line that comes while the host is still starting is not lost (#1895)", async () => {
    const s = setup()
    const host = startHost(s, ['--watch-parent'], { CC_HOST_TOKEN_ON_STDIN: '1', CC_STARTED_BY: 'app' })
    // The token and the stop in one go: the host reads the first, and has not wired its endings when the second arrives
    host.p.stdin.write(`${JSON.stringify({ token: 'token-handed-on-stdin-0123456789' })}\n${JSON.stringify({ op: 'stop', forUpdate: true })}\n`)
    expect(await exitsSoon(host)).toBe(0)
    expect(s.log()).toContain('asked to stop (the window, for an update)')
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

  // #1942: the close that comes while the host is still starting is seen, as the one after the ready line is
  it('with --watch-parent a close of stdin while the host is still starting ends it too (#1942)', async () => {
    const s = setup()
    const host = startHost(s, ['--watch-parent'], { CC_HOST_TOKEN_ON_STDIN: '1' })
    // The token, then the end at once: the host takes a second or more to start, and wires its parent watch at the end of it
    host.p.stdin.end(`${JSON.stringify({ token: 'token-handed-on-stdin-0123456789' })}
`)
    expect(await exitsSoon(host)).toBe(0)
    expect(s.log()).toContain('parent process exited; shutting down')
  }, 60_000 * SLOW)

  /*
   * #1397: a host writes that the system is ending when it is told so (system-end.ts), and the next start reads that alone. Asked of
   * real hosts: the notice, the leave that waits for systemd's answer, and the start that reads it are steps main.ts takes in order.
   */
  const token = 'token-handed-on-stdin-0123456789'
  const asWindow = (s: ReturnType<typeof setup>, extra: Record<string, string> = {}) => {
    const host = startHost(s, ['--watch-parent'], { CC_HOST_TOKEN_ON_STDIN: '1', CC_STARTED_BY: 'app', ...extra })
    host.p.stdin.write(`${JSON.stringify({ token })}\n`)
    return host
  }
  const noticeOf = (s: ReturnType<typeof setup>) => (existsSync(join(s.dir, SYSTEM_END_FILE)) ? readFileSync(join(s.dir, SYSTEM_END_FILE), 'utf8') : null)
  /** A session the last host left in a turn, as a killed agent leaves it */
  const leftInTurn = (s: ReturnType<typeof setup>) => {
    const store = new Store(s.db)
    try {
      const path = join(s.dir, 'project')
      mkdirSync(path, { recursive: true })
      store.projects.addProject({ id: 'p1', path, name: 'project' })
      store.sessions.upsertSession({
        id: 's1', projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: 'a long job', autoNamed: false, state: 'working',
        lastReadSeq: 0, lastSeq: 0, createdAt: Date.now(), waitingSince: null, live: false, model: null, effort: null,
        verbosity: null, serviceTier: null, permissionPreset: 'safe', importedFrom: null, worktree: null,
        parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
      })
    } finally {
      store.close()
    }
  }
  /** The reason the next start gives the session `leftInTurn` left */
  const nextStartSays = async (s: ReturnType<typeof setup>) => {
    leftInTurn(s)
    const next = asWindow(s)
    await next.ready
    next.p.stdin.end()
    expect(await exitsSoon(next)).toBe(0)
    const store = new Store(s.db)
    try {
      return store.sessions.listSessions().find((x) => x.id === 's1')?.interruption?.reason ?? null
    } finally {
      store.close()
    }
  }
  /** A `systemctl` that answers `word` to `is-system-running`, first on the host's PATH (and the login shell's answer, setup's `tools`) */
  const systemctl = (s: ReturnType<typeof setup>, word: string) => {
    const tools = join(s.dir, 'tools')
    mkdirSync(tools, { recursive: true })
    writeFileSync(join(tools, 'systemctl'), `#!/bin/sh\necho ${word}\nexit 1\n`)
    chmodSync(join(tools, 'systemctl'), 0o755)
    return { PATH: `${tools}:${process.env.PATH ?? ''}` }
  }

  it('a window that quits leaves no notice, and the next start finds a quit (#1397 review finding 1)', async () => {
    const s = setup()
    const first = asWindow(s)
    await first.ready
    // The window quitting in direct mode: its end of the pipe closes, and no stopped.json is written
    first.p.stdin.end()
    expect(await exitsSoon(first)).toBe(0)
    expect(noticeOf(s)).toBeNull()
    expect(await nextStartSays(s)).toBe('quit')
  }, 120_000 * SLOW)

  it("the window's line that the system is ending makes the turn its leave cuts the system's (#1397)", async () => {
    const s = setup()
    const first = asWindow(s)
    await first.ready
    // As the window says it at Windows' end-session question, then goes with the session
    first.p.stdin.write(`${JSON.stringify({ op: 'system-ending' })}\n`)
    await settle(300)
    first.p.stdin.end()
    expect(await exitsSoon(first)).toBe(0)
    expect(noticeOf(s)).toMatch(/^\{"v":1,"at":\d+\}/)
    expect(await nextStartSays(s)).toBe('shutdown')
    expect(s.log()).toContain('[agent-host] the last host was told the system was ending, at ')
  }, 120_000 * SLOW)

  // systemd is asked only on Linux (os.ts `systemStoppingQueries`)
  const linux = process.platform === 'linux'
  it.skipIf(!linux)('on Linux the parent going while systemd is stopping waits for its answer, and the next start finds a shutdown (#1397 deep review 1)', async () => {
    const s = setup()
    const first = asWindow(s, systemctl(s, 'stopping'))
    await first.ready
    first.p.stdin.end()
    expect(await exitsSoon(first)).toBe(0)
    expect(s.log()).toContain('[agent-host] leaving as the system is stopping')
    expect(noticeOf(s)).toMatch(/^\{"v":1,"at":\d+\}/)
    systemctl(s, 'running')
    expect(await nextStartSays(s)).toBe('shutdown')
  }, 120_000 * SLOW)

  it.skipIf(!linux)('on Linux a SIGTERM is the system’s when systemd says it is stopping, and only then (#1397 deep review 1)', async () => {
    for (const [word, noticed] of [['running', false], ['stopping', true]] as const) {
      const s = setup()
      const host = startHost(s, [], systemctl(s, word))
      await host.ready
      host.p.kill('SIGTERM')
      expect(await exitsSoon(host)).toBe(0)
      expect(noticeOf(s) !== null).toBe(noticed)
    }
  }, 120_000 * SLOW)
})
