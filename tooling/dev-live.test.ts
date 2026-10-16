import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DEFAULT_PORT, dataDir, keeperSocketPath, readHostDoor, run, servePort, type Launch } from '../scripts/dev-live.mjs'

// The keeper is a unix socket: there is none on Windows, and a fake one cannot be made there (listen EACCES).
const unixIt = it.skipIf(process.platform === 'win32')
const TOKEN = 'secret-token-0123456789abcdef'
const cleanups: (() => void)[] = []
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c() })

/** A temporary data folder holding a fake keeper socket that answers every request line with `reply(request)`. */
async function fakeKeeper(reply: (request: any) => unknown | undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'cc-live-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const requests: any[] = []
  const server = net.createServer((conn) => {
    let buf = ''
    conn.on('data', (d) => {
      buf += d
      const i = buf.indexOf('\n')
      if (i < 0) return
      const request = JSON.parse(buf.slice(0, i))
      requests.push(request)
      const answer = reply(request)
      if (answer !== undefined) conn.write(`${JSON.stringify(answer)}\n`)
    })
    conn.on('error', () => {})
  })
  await new Promise<void>((ok) => server.listen(join(dir, 'keeper.sock'), ok))
  cleanups.push(() => server.close())
  return { dir, requests, env: { CC_DATA_DIR: dir } as Record<string, string | undefined> }
}

const ready = (port = 41234, token = TOKEN) => ({ ok: true, view: { keeper: { pid: 1 }, status: { state: 'ready', port, token }, background: false } })
const view = (status: unknown) => ({ ok: true, view: { status } })

/** A port nobody listens on, and a held one. */
async function heldPort() {
  const holder = net.createServer()
  await new Promise<void>((ok) => holder.listen(0, '127.0.0.1', ok))
  cleanups.push(() => holder.close())
  return (holder.address() as net.AddressInfo).port
}

function recorder() {
  const out: string[] = []
  const errs: string[] = []
  const launches: Launch[] = []
  return {
    out, errs, launches,
    deps: {
      log: (l: string) => out.push(l),
      err: (l: string) => errs.push(l),
      startVite: async (l: Launch) => { launches.push(l); return 0 },
    },
  }
}

describe('dev:live: where the keeper is', () => {
  it('uses CC_DATA_DIR, else ~/.centralu, and ~/.centralu-dev under CC_DEV=1', () => {
    expect(keeperSocketPath({ CC_DATA_DIR: '/tmp/x' }, '/home/u')).toBe(join('/tmp/x', 'keeper.sock'))
    expect(dataDir({}, '/home/u')).toBe(join('/home/u', '.centralu'))
    expect(dataDir({ CC_DATA_DIR: '  ' }, '/home/u')).toBe(join('/home/u', '.centralu'))
    expect(dataDir({ CC_DEV: '1' }, '/home/u')).toBe(join('/home/u', '.centralu-dev'))
  })

  it('picks the port: 5173 by default, PORT to choose, anything else is refused', () => {
    expect(servePort({})).toBe(DEFAULT_PORT)
    expect(DEFAULT_PORT).toBe(5173)
    expect(servePort({ PORT: '5174' })).toBe(5174)
    expect(() => servePort({ PORT: 'abc' })).toThrow(/PORT must be/)
    expect(() => servePort({ PORT: '70000' })).toThrow(/PORT must be/)
  })
})

describe('dev:live: reading the keeper', () => {
  unixIt('asks for `status` and returns the front door\'s port and token', async () => {
    const k = await fakeKeeper(() => ready(41234))
    await expect(readHostDoor(k.env, { platform: 'darwin' })).resolves.toEqual({ port: 41234, token: TOKEN })
    expect(k.requests).toEqual([{ op: 'status' }])
  })

  unixIt('says no app is running when there is no keeper socket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-live-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    await expect(readHostDoor({ CC_DATA_DIR: dir }, { platform: 'darwin' })).rejects.toThrow(/No Centralu app is running: no keeper socket/)
    expect(readdirSync(dir)).toEqual([]) // read only: nothing was written to the data folder
  })

  unixIt('says no app is running for a leftover socket nobody listens on', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-live-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    // A keeper killed hard leaves its socket file behind: the connect is refused rather than missing.
    const bind = "require('node:net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))"
    spawnSync(process.execPath, ['-e', bind, join(dir, 'keeper.sock')])
    expect(readdirSync(dir)).toEqual(['keeper.sock'])
    await expect(readHostDoor({ CC_DATA_DIR: dir }, { platform: 'darwin' })).rejects.toThrow(/No Centralu app is running: nothing answers/)
  })

  unixIt.each([
    [{ state: 'starting' }, /no host yet \(starting\)/],
    [{ state: 'restarting', attempt: 2 }, /no host yet \(restarting\)/],
    [{ state: 'failed', message: 'node missing' }, /gave up starting it \(node missing\)/],
  ])('says the keeper has no host for %j', async (status, message) => {
    const k = await fakeKeeper(() => view(status))
    await expect(readHostDoor(k.env, { platform: 'darwin' })).rejects.toThrow(message)
  })

  unixIt('reports a refusal and a silent keeper in one line, without a token', async () => {
    const refusing = await fakeKeeper(() => ({ ok: false, error: 'the keeper is handing over to a new build; try again in a moment' }))
    await expect(readHostDoor(refusing.env, { platform: 'darwin' })).rejects.toThrow(/refused the status request: the keeper is handing over/)
    const silent = await fakeKeeper(() => undefined)
    await expect(readHostDoor(silent.env, { platform: 'darwin', timeoutMs: 100 })).rejects.toThrow(/did not answer in time; it may be updating/)
  })

  it('does not look for a pipe on Windows, where there is no keeper', async () => {
    await expect(readHostDoor({ CC_DATA_DIR: tmpdir() }, { platform: 'win32' })).rejects.toThrow(/Windows has no keeper/)
  })
})

describe('dev:live: the command', () => {
  unixIt('starts Vite on 127.0.0.1 with the host in the child\'s env only, and never prints the token', async () => {
    const k = await fakeKeeper(() => ready(41234))
    const port = await freePort()
    const r = recorder()
    const code = await run({ ...k.env, PORT: String(port) }, { ...r.deps, platform: 'darwin' })
    expect(code).toBe(0)
    expect(r.launches).toHaveLength(1)
    const launch = r.launches[0]!
    expect(launch.args).toEqual(['--config', 'vite.config.ts', '--host', '127.0.0.1', '--port', String(port), '--strictPort'])
    expect(launch.cwd).toMatch(/apps[\\/]web$/)
    expect(launch.env.VITE_HOST_URL).toBe('ws://127.0.0.1:41234')
    expect(launch.env.VITE_HOST_TOKEN).toBe(TOKEN)
    expect(r.out.join('\n')).toContain(`http://127.0.0.1:${port}/`)
    expect(r.out.join('\n')).toMatch(/single-user machine only/)
    expect(r.out.join('\n')).toMatch(/token stays the same until the app is fully quit and opened again/)
    expect([...r.out, ...r.errs, ...launch.args].join('\n')).not.toContain(TOKEN)
    expect(process.env.VITE_HOST_TOKEN).toBeUndefined()
  })

  unixIt('stops with one line when no app is running, and starts no Vite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-live-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const r = recorder()
    expect(await run({ CC_DATA_DIR: dir }, { ...r.deps, platform: 'darwin' })).toBe(1)
    expect(r.launches).toEqual([])
    expect(r.errs).toHaveLength(1)
    expect(r.errs[0]).toMatch(/^dev:live: No Centralu app is running/)
  })

  unixIt('stops with one line when the keeper has no host yet, and starts no Vite', async () => {
    const k = await fakeKeeper(() => view({ state: 'starting' }))
    const r = recorder()
    expect(await run(k.env, { ...r.deps, platform: 'darwin' })).toBe(1)
    expect(r.launches).toEqual([])
    expect(r.errs).toEqual([expect.stringMatching(/^dev:live: The keeper has no host yet/)])
  })

  unixIt('stops with one line when the port is taken, and starts no Vite', async () => {
    const k = await fakeKeeper(() => ready())
    const held = await heldPort()
    const r = recorder()
    expect(await run({ ...k.env, PORT: String(held) }, { ...r.deps, platform: 'darwin' })).toBe(1)
    expect(r.launches).toEqual([])
    expect(r.errs).toEqual([expect.stringContaining(`Port ${held} on 127.0.0.1 is already in use`)])
    expect(r.errs.join('\n')).not.toContain(TOKEN)
  })
})

async function freePort(): Promise<number> {
  const probe = net.createServer()
  await new Promise<void>((ok) => probe.listen(0, '127.0.0.1', ok))
  const port = (probe.address() as net.AddressInfo).port
  await new Promise<void>((ok) => probe.close(() => ok()))
  return port
}

/**
 * The real launch path, in a child process that plays the command: a driver imports `launchVite` and
 * points it at a fake Vite entry, which records what it got and stops only when a signal reaches it.
 *
 * Not on Windows: `dev:live` stops there before it starts Vite (no keeper to ask), and the test is about
 * POSIX signals, which Windows does not have.
 */
describe.skipIf(process.platform === 'win32')('dev:live: launching Vite', () => {
  const ROOT = resolve(import.meta.dirname, '..')

  async function drive() {
    const dir = mkdtempSync(join(tmpdir(), 'cc-live-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const record = join(dir, 'record.json')
    const fake = join(dir, 'fake-vite.mjs')
    // Records the env and arguments it was started with, then waits. On a signal it records which one
    // and dies of that same signal, so the exit code the command reports is the shell's 128 + signal.
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs'
      const record = ${JSON.stringify(record)}
      const write = (extra = {}) => writeFileSync(record, JSON.stringify({ pid: process.pid, token: process.env.VITE_HOST_TOKEN, url: process.env.VITE_HOST_URL, args: process.argv.slice(2), ...extra }))
      write()
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        process.on(sig, () => { write({ signal: sig }); process.removeAllListeners(sig); process.kill(process.pid, sig) })
      }
      setInterval(() => {}, 1000)
    `)
    const driver = join(dir, 'driver.mts')
    writeFileSync(driver, `
      import { launchVite } from ${JSON.stringify(pathToFileURL(join(ROOT, 'scripts/dev-live.mts')).href)}
      const code = await launchVite({ args: ['--port', '1'], cwd: ${JSON.stringify(dir)}, env: { ...process.env, VITE_HOST_URL: 'ws://127.0.0.1:41234', VITE_HOST_TOKEN: ${JSON.stringify(TOKEN)} } }, ${JSON.stringify(fake)})
      console.log('EXIT ' + code + ' PARENT_TOKEN ' + String(process.env.VITE_HOST_TOKEN))
    `)
    const child = spawn(process.execPath, ['--import', 'tsx', driver], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    cleanups.push(() => { child.kill('SIGKILL') })
    let output = ''
    child.stdout.on('data', (d) => { output += d })
    child.stderr.on('data', (d) => { output += d })
    const exited = new Promise<number | null>((ok) => child.on('exit', (code, signal) => ok(code ?? (signal ? -1 : null))))
    // Wait for the fake Vite to be up (the file exists), not for a fixed time.
    for (let i = 0; i < 400 && !existsSync(record); i++) await new Promise((ok) => setTimeout(ok, 50))
    expect(existsSync(record)).toBe(true)
    // If forwarding is broken the fake Vite outlives its parent: stop that one process (ours) afterwards.
    const fakePid = (JSON.parse(readFileSync(record, 'utf8')) as { pid: number }).pid
    cleanups.push(() => { try { process.kill(fakePid, 'SIGKILL') } catch { /* already gone */ } })
    return { child, exited, output: () => output, read: () => JSON.parse(readFileSync(record, 'utf8')) as Record<string, unknown> }
  }

  it('gives the token to the child only and keeps it out of the command\'s own env and output', async () => {
    const d = await drive()
    const got = d.read()
    expect(got.token).toBe(TOKEN)
    expect(got.url).toBe('ws://127.0.0.1:41234')
    expect(got.args).toEqual(['--port', '1'])
    d.child.kill('SIGTERM')
    await d.exited
    expect(d.output()).toContain('PARENT_TOKEN undefined')
    expect(d.output()).not.toContain(TOKEN)
  }, 30_000)

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ] as const)('passes %s on to Vite and exits with 128 + the signal when Vite dies of it', async (signal, code) => {
    const d = await drive()
    d.child.kill(signal)
    await d.exited
    expect(d.read().signal).toBe(signal)
    expect(d.output()).toContain(`EXIT ${code} `)
  }, 30_000)
})
