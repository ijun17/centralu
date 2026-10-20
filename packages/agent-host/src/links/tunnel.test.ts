import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawnSync, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import {
  pairLabel,
  hubKeyOf,
  parseRevoke,
  revokeCommand,
  autostartCommand,
  connectionCommand,
  detachCommand,
  lastLine,
  parseConnectionLine,
  hubNameForRemote,
  powershell,
  serveCommand,
  shimNames,
  SSH_COMMAND_TIMEOUT_MS,
  SSH_DETACH_TIMEOUT_MS,
  SSH_EXEC_TIMEOUT_MS,
  SshTunnel,
  stopCommand,
  type RemoteSpec,
  type SshTunnelOptions,
} from './tunnel.js'
import { fakeExe } from '../fake-exe.test-helpers.js'
import { SLOW, eventually } from '../../../../tooling/test-timing.js'
import { alive as isAlive } from '../process.test-helpers.js'
import { removeTree } from '../temp-dir.test-helpers.js'

/**
 * The ssh transport (#82, docs/plans/remote-hub.md §2) against a fake `ssh` on PATH: a Node script
 * that logs its arguments, answers the connection command the way `centralu serve --connection`
 * would, and for `-N -L` forwards the local port to the "remote" one on this machine, as ssh does.
 * What it decodes is what a real remote shell would run, so the PowerShell and WSL encodings are
 * checked end to end, not only built.
 */

const FAKE_SSH = String.raw`#!/usr/bin/env node
const fs = require('node:fs')
const net = require('node:net')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(args) + '\n')
// What a real remote shell would run: PowerShell's -EncodedCommand decoded, and a WSL script inside it
function decode(cmd) {
  const enc = 'powershell -NoProfile -NonInteractive -EncodedCommand '
  let shell = 'posix'
  if (cmd.startsWith(enc)) {
    cmd = Buffer.from(cmd.slice(enc.length), 'base64').toString('utf16le')
    shell = 'powershell'
    const w = /wsl\.exe -d '([^']+)' -- bash -lc 'echo ([A-Za-z0-9+/=]+) \| base64 -d \| bash -l'$/.exec(cmd)
    if (w) { shell = 'wsl:' + w[1]; cmd = Buffer.from(w[2], 'base64').toString('utf8') }
  }
  return { shell, cmd: cmd.replace(/^\[Console\]::OutputEncoding=[^\n]*\n(\$psmp=[^\n]*\n)?/, '') }
}
// FAKE_SSH_STATE, when set, is the remote host: running while the file exists
const state = process.env.FAKE_SSH_STATE
const running = () => (state ? fs.existsSync(state) : JSON.parse(process.env.FAKE_SSH_LINE).hostRunning)
const L = args.indexOf('-L')
if (L !== -1) {
  if (process.env.FAKE_SSH_FORWARD_FAIL) { process.stderr.write('bind [127.0.0.1]:1: Address already in use\n'); process.exit(255) }
  const [bind, lport, rhost, rport] = args[L + 1].split(':')
  // Remote and local are one machine here: a forward to its own port would connect to itself without
  // end and use up the machine's ephemeral ports. A real remote has nothing listening there yet
  const server = net.createServer((c) => { if (rport === lport) return c.destroy(); const r = net.connect(Number(rport), rhost); c.pipe(r); r.pipe(c); c.on('error', () => r.destroy()); r.on('error', () => c.destroy()) })
  server.listen(Number(lport), bind)
  // The remote host's log coming through the forward, then the session ending: megabytes of stderr, the reason last
  if (process.env.FAKE_SSH_NOISE) {
    setTimeout(() => {
      process.stderr.write('ssh: Permission denied (publickey), said once at the start\n')
      const junk = 'remote host log line '.padEnd(1000, '.') + '\n'
      for (let i = 0; i < 5000; i++) process.stderr.write(junk)
      process.stderr.write('ssh: connection reset by the remote, said last\n', () => process.exit(1))
    }, 400)
  }
  // A remote command after the target: a link-bound host runs in this session, and ends with it
  const remote = args[args.indexOf('--') + 2]
  if (remote && / serve($|[;} ])/.test(decode(remote).cmd)) {
    fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ hosting: decode(remote).shell, run: decode(remote).cmd, pid: process.pid }) + '\n')
    if (state) fs.writeFileSync(state, 'link-bound')
    process.on('SIGTERM', () => { if (state) fs.rmSync(state, { force: true }); process.exit(0) })
  }
  setInterval(() => {}, 1 << 30)
  return
}
if (process.env.FAKE_SSH_HANG) { fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ hanging: process.pid }) + '\n'); setInterval(() => {}, 1 << 30); return }
if (process.env.FAKE_SSH_FLOOD) { const chunk = 'x'.repeat(65536); setInterval(() => process.stdout.write(chunk), 1); process.stdout.on('error', () => process.exit(0)); return }
if (process.env.FAKE_SSH_SLOW_MS) { setTimeout(() => { process.stdout.write('slow ok\n'); process.exit(0) }, Number(process.env.FAKE_SSH_SLOW_MS)); return }
// A three-byte character cut in the middle between two writes, as a pipe may deliver it
if (process.env.FAKE_SSH_SPLIT) { const b = Buffer.from('한\n'); process.stdout.write(b.subarray(0, 2)); setTimeout(() => { process.stdout.write(b.subarray(2)); process.exit(0) }, 100); return }
if (process.env.FAKE_SSH_UNREACHABLE) { process.stderr.write('ssh: connect to host x port 22: Operation timed out\n'); process.exit(255) }
const { shell, cmd } = decode(args[args.length - 1])
fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ shell, run: cmd }) + '\n')
const has = (process.env.FAKE_SSH_HAS || '').split('|')
const line = (over) => JSON.stringify({ ...JSON.parse(process.env.FAKE_SSH_LINE), hostRunning: running(), ...over })
const answer = () => {
  // A serve from before #1405 refuses --pair, as it refuses any option it does not know
  // A remote updated meanwhile: refuses --pair only while this file exists, and prints no token without --pair
  if (process.env.FAKE_SSH_NO_PAIR_FILE && / --pair /.test(cmd) && fs.existsSync(process.env.FAKE_SSH_NO_PAIR_FILE)) { process.stderr.write('unknown option for serve: --pair' + String.fromCharCode(10)); process.exit(2) }
  if (process.env.FAKE_SSH_NO_PAIR_FILE && !/ --pair /.test(cmd) && !fs.existsSync(process.env.FAKE_SSH_NO_PAIR_FILE)) return process.stdout.write(line({ token: undefined, takes: ['from', 'window', 'pair'] }) + String.fromCharCode(10))
  if (process.env.FAKE_SSH_NO_PAIR && / --pair /.test(cmd)) { process.stderr.write('unknown option for serve: --pair' + String.fromCharCode(10)); process.exit(2) }
  // What centralu serve --detach answers, per FAKE_SSH_DETACH; anything else is --connection
  if (/ serve --detach/.test(cmd)) {
    const how = process.env.FAKE_SSH_DETACH
    if (how === 'old') { process.stderr.write('unknown option for serve: --detach\n'); process.exit(2) }
    if (how === 'blocked') return process.stdout.write(JSON.stringify({ v: 1, detach: { ok: false, how: 'wmi', reason: 'wmi_blocked', message: 'Windows did not start Centralu through WMI (returned 2).' } }) + '\n')
    if (how === 'old_node') return process.stdout.write(JSON.stringify({ v: 1, detach: { ok: false, how: null, reason: 'node_too_old', message: 'centralu serve needs Node 22.14.0 or newer and this is Node 22.12.0: update Node.', node: '22.12.0', floor: '22.14.0' } }) + '\n')
    if (how === 'crashed') return process.stdout.write(JSON.stringify({ v: 1, detach: { ok: false, how: 'setsid', reason: 'exited', message: 'centralu serve exited (3221225477) before its host answered' } }) + '\n')
    if (how === 'exited') return process.stdout.write(JSON.stringify({ v: 1, detach: { ok: false, how: 'setsid', reason: 'exited', message: 'centralu serve exited (1) before its host answered' } }) + '\n')
    if (state) fs.writeFileSync(state, 'detached')
    return process.stdout.write(line({ hostRunning: true, detach: { ok: true, how: 'setsid', already: false } }) + '\n')
  }
  process.stdout.write('some motd line\n' + line({}) + '\n')
}
// The lookup centralu, then the launcher, then the not-found word, as connectionCommand writes it
if (cmd.includes('CENTRALU-NOT-FOUND')) {
  const used = has.includes('centralu') ? 'centralu' : has.includes('launcher') ? 'launcher' : null
  fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ used }) + '\n')
  if (used) answer()
  else { process.stdout.write('CENTRALU-NOT-FOUND\n'); process.exit(shell === 'posix' ? 127 : 1) }
} else {
  const program = cmd.split(' serve --')[0]
  if (!has.includes(program)) { process.stderr.write(program + ': No such file or directory\n'); process.exit(shell === 'posix' ? 127 : 1) }
  answer()
}
`

let dir: string
let log: string
let remote: Server
let remotePort: number
const tunnels: SshTunnel[] = []

function line(over: Record<string, unknown> = {}) {
  return JSON.stringify({ v: 1, port: remotePort, token: 'tok', version: '0.1.0-beta.11', protocolVersion: 1, dataDir: '/home/me/.centralu', hostRunning: true, ...over })
}

function tunnel(env: Record<string, string>, remoteSpec?: RemoteSpec, extra: Partial<SshTunnelOptions> = {}) {
  const t = new SshTunnel({
    target: 'box',
    remote: remoteSpec,
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, FAKE_SSH_LOG: log, FAKE_SSH_LINE: line(), FAKE_SSH_HAS: 'centralu', ...env },
    forwardTimeoutMs: 5000,
    ...extra,
  })
  tunnels.push(t)
  return t
}

const logged = (): unknown[] =>
  readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))

/**
 * Waits for every fake ssh that said it hangs to be gone. A deadline ends the ssh without waiting for it, so a test that
 * stops at the rejection would leave its cleanup removing a folder the ssh is still being ended in.
 */
const hungGone = () =>
  eventually(() => logged().every((l) => !(typeof l === 'object' && l !== null && 'hanging' in l) || !isAlive((l as { hanging: number }).hanging)), 10_000)

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })

describe('the ssh transport, against a fake ssh (#82)', () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-fake-ssh-'))
    log = join(dir, 'log.jsonl')
    writeFileSync(log, '')
    // A real ssh.exe-shaped program on Windows, the script itself elsewhere (fake-exe.test-helpers.ts)
    fakeExe(dir, 'ssh', FAKE_SSH)
    /*
     * The "remote host": an echo server, which is enough to see bytes cross a forward. Remote and
     * local are one machine here, so its port is taken locally and the tunnel picks another for
     * the local end; a test that needs the same number on both ends names a free port instead.
     */
    remote = createServer((c) => {
      /*
       * A forward ssh that ends resets the connections it holds here. On Windows it always does: the
       * fake ssh is a launcher in a job object (fake-exe.test-helpers.ts), and ending it terminates the
       * script, whose sockets close abortively. With no listener the reset reached the test's worker as
       * an uncaught `read ECONNRESET` and failed the run. The remote's side of a connection is not what
       * these tests look at, so a reset only ends that connection.
       */
      c.on('error', () => c.destroy())
      c.pipe(c)
    })
    await new Promise<void>((r) => remote.listen(0, '127.0.0.1', () => r()))
    remotePort = (remote.address() as { port: number }).port
  })

  afterEach(async () => {
    await Promise.all(tunnels.splice(0).map((t) => t.close()))
    await new Promise<void>((r) => remote.close(() => r()))
    // Without blocking: a sync rmSync's retries hold the event loop while a just-stopped fake ssh lets go of the
    // folder, and on a loaded Windows machine that once held the worker for 128 s (#845)
    await removeTree(dir)
  })

  it('asks the remote for its connection line in batch mode, then forwards on loopback only', async () => {
    const t = tunnel({})
    const ep = await t.open()
    expect(ep.token).toBe('tok')
    expect(ep.line).toMatchObject({ port: remotePort, version: '0.1.0-beta.11', hostRunning: true })
    const [ask, forward] = (logged() as unknown[]).filter((x): x is string[] => Array.isArray(x))
    expect(ask!.slice(0, -1)).toEqual(['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', 'box'])
    expect(ask!.at(-1)).toMatch(/^sh -c 'd=.*; m=.*; if \[ -x "\$m" \]; then .*elif command -v centralu .* serve --connection --pair hub:[A-Za-z0-9._-]+; .*CENTRALU-NOT-FOUND; exit 127; fi'$/)
    expect(forward).toContain('-N')
    for (const opt of ['BatchMode=yes', 'ExitOnForwardFailure=yes', 'ServerAliveInterval=15', 'GatewayPorts=no']) expect(forward).toContain(opt)
    const spec = forward![forward!.indexOf('-L') + 1]!
    // Both ends on loopback: never 0.0.0.0, never a bare port (which ssh binds per GatewayPorts)
    expect(spec).toMatch(/^127\.0\.0\.1:\d+:127\.0\.0\.1:\d+$/)
    expect(spec.endsWith(`:127.0.0.1:${remotePort}`)).toBe(true)
    expect(forward!.at(-1)).toBe('box')
    expect(forward!.at(-2)).toBe('--')
    // The forward carries bytes to the remote's port
    const { createConnection } = await import('node:net')
    const echoed = await new Promise<string>((resolve, reject) => {
      const c = createConnection(ep.localPort, '127.0.0.1', () => c.write('ping'))
      c.on('error', reject)
      c.on('data', (d) => {
        resolve(String(d))
        c.destroy()
      })
    })
    expect(echoed).toBe('ping')
    expect(ep.url).toBe(`ws://127.0.0.1:${ep.localPort}`)
  })

  // What a forward ssh ended on Windows does to the remote's side of a connection; on macOS and Linux only a reset does it
  it('the fake remote takes a reset connection and goes on answering', async () => {
    const { createConnection } = await import('node:net')
    const reset = createConnection(remotePort, '127.0.0.1')
    await new Promise<void>((r) => reset.once('connect', () => r()))
    reset.resetAndDestroy()
    await new Promise<void>((r) => reset.once('close', () => r()))
    const echoed = await new Promise<string>((resolve, reject) => {
      const c = createConnection(remotePort, '127.0.0.1', () => c.write('still here'))
      c.on('error', reject)
      c.on('data', (d) => {
        resolve(String(d))
        c.destroy()
      })
    })
    expect(echoed).toBe('still here')
  })

  it('uses the same port number here when it is free, and another one when it is taken', async () => {
    // The remote port is taken on this machine (by the fake remote itself), so the tunnel falls back
    const ep = await tunnel({}).open()
    expect(ep.localPort).not.toBe(remotePort)
    // A remote port that is free here is used as is
    const free = await freePort()
    const ep2 = await tunnel({ FAKE_SSH_LINE: line({ port: free }) }).open()
    expect(ep2.localPort).toBe(free)
  })

  it('falls back, on the remote, to the launcher serve keeps when centralu is not on the ssh shell’s PATH', async () => {
    const ep = await tunnel({ FAKE_SSH_HAS: 'launcher' }).open()
    expect(ep.token).toBe('tok')
    // One ssh round trip, whatever the shell: the remote decided
    expect((logged() as { used?: string }[]).filter((x) => 'used' in x)).toEqual([{ used: 'launcher' }])
  })

  it('says Centralu is not installed when neither answers, whatever exit code the shell passed on, and that ssh failed when it cannot connect', async () => {
    await expect(tunnel({ FAKE_SSH_HAS: '' }).open()).rejects.toThrow(/not installed on box/)
    // PowerShell turns the 127 into 1 (measured); the word on stdout still says it
    await expect(tunnel({ FAKE_SSH_HAS: '' }, { shell: 'powershell' }).open()).rejects.toThrow(/not installed on box/)
    await expect(tunnel({ FAKE_SSH_HAS: '' }, { shell: 'wsl', wslDistro: 'Ubuntu-24.04' }).open()).rejects.toThrow('not installed in WSL (Ubuntu-24.04) on box')
    await expect(tunnel({ FAKE_SSH_UNREACHABLE: '1' }).open()).rejects.toThrow(/ssh could not reach box: .*timed out/)
  })

  it('opens no forward while the remote host is not running', async () => {
    const ep = await tunnel({ FAKE_SSH_LINE: line({ hostRunning: false }) }).open()
    expect(ep.line.hostRunning).toBe(false)
    expect((logged() as string[][]).filter((a) => Array.isArray(a) && a.includes('-L'))).toEqual([])
  })

  it('reports the forward going down when ssh exits', async () => {
    const t = tunnel({ FAKE_SSH_LINE: line({ port: await freePort() }) })
    const down = new Promise<string>((r) => t.onDown(r))
    await t.open()
    // The ssh process dies under it, as on a dropped network
    ;(t as unknown as { child: { kill(s: string): void } }).child.kill('SIGKILL')
    expect(await down).toMatch(/ssh exited/)
  })

  it('reopening a live link ends the old forward without reporting the link down, so the link does not reconnect without end', async () => {
    const t = tunnel({ FAKE_SSH_LINE: line({ port: await freePort() }) })
    /*
     * What a link does on down (linked-machine-connection.ts `transportDown`): opens again a little later. Reopening
     * ends the forward it holds, so a reopen reported as down came back as another reopen, which
     * ended the new forward, and so on: the reconnect churn of a refused token's quick retry, a
     * `machines.reconnect` or the versions poll.
     */
    const downs: string[] = []
    // One open at a time, as a link runs them
    let opening = Promise.resolve()
    const reopen = () => (opening = opening.then(() => t.open()).then(() => undefined, () => undefined))
    t.onDown((reason) => {
      downs.push(reason)
      setTimeout(reopen, 50)
    })
    const forwards = () => (logged() as string[][]).filter((a) => Array.isArray(a) && a.includes('-L')).length
    await reopen()
    const first = (t as unknown as { child: ChildProcess }).child
    await reopen()
    /*
     * The first forward's exit is where a down would be reported, by its own exit listener, so once it has exited
     * there is nothing more to wait for (#845); a fixed sleep could end first on a loaded machine
     */
    await eventually(() => first.exitCode !== null || first.signalCode !== null)
    expect(downs).toEqual([])
    expect(forwards()).toBe(2)
  })

  it('a close while open() ends the old forward stays closed: nothing is started after it', async () => {
    const t = tunnel({ FAKE_SSH_LINE: line({ port: await freePort() }) })
    await t.open()
    const asked = logged().length
    const reopening = t.open()
    reopening.catch(() => {})
    // open() is now waiting for the old forward to exit
    await t.close()
    await expect(reopening).rejects.toThrow(/was closed/)
    expect(logged().length).toBe(asked)
  })

  it('feeds a command\'s stdin to ssh and closes it, for scripts too long for one Windows command line', async () => {
    // A stand-in ssh that echoes back what reached its stdin, and the command it was given
    const echo = fakeExe(dir, 'echo-ssh', `let b='';process.stdin.on('data',(d)=>b+=d);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({cmd:process.argv.at(-1),stdin:b}))})\n`)
    const t = new SshTunnel({ target: 'box', ssh: echo, env: process.env })
    tunnels.push(t)
    const big = 'A'.repeat(50_000)
    const r = await t.exec({ command: 'run-it', stdin: big })
    expect(JSON.parse(r.stdout)).toEqual({ cmd: 'run-it', stdin: big })
  })

  describe('bounds on what an asking ssh may do', () => {
    it('stops an ssh that never stops printing, and rejects instead of holding its output', async () => {
      const t = tunnel({ FAKE_SSH_FLOOD: '1' })
      await expect(t.exec('true')).rejects.toThrow(/printed more than 1 MiB/)
      expect((t as unknown as { asking: Set<unknown> }).asking.size).toBe(0)
    })

    it('stops an ssh that does not finish when starting the host, at that deadline', async () => {
      // A few seconds: the fake has to be running, and have said so, before the deadline can mean anything
      const t = tunnel({ FAKE_SSH_HANG: '1' }, undefined, { detachTimeoutMs: 5000 })
      const starting = t.startHost()
      starting.catch(() => {})
      let pid = 0
      for (let i = 0; i < 400 && !pid; i++) {
        pid = (logged().find((l) => typeof l === 'object' && l !== null && 'hanging' in l) as { hanging: number } | undefined)?.hanging ?? 0
        if (!pid) await new Promise((r) => setTimeout(r, 10))
      }
      expect(pid).toBeGreaterThan(0)
      await expect(starting).rejects.toThrow(/did not finish within 5 seconds/)
      // The ssh itself is gone, not only the wait for it
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10_000 * SLOW })
    }, 30_000 * SLOW)

    it('puts the deadline on asking for the connection line too', async () => {
      const t = tunnel({ FAKE_SSH_HANG: '1', FAKE_SSH_LINE: line({ port: await freePort() }) }, undefined, { commandTimeoutMs: 300 })
      await expect(t.open()).rejects.toThrow(/did not finish within/)
      await hungGone()
    })

    it('stops an exec step that does not finish, at the step deadline', async () => {
      const t = tunnel({ FAKE_SSH_HANG: '1' }, undefined, { execTimeoutMs: 300 })
      await expect(t.exec('true')).rejects.toThrow(/did not finish within/)
      await hungGone()
    })

    it('gives an installer step far longer than a short question: a slow download is not cut short', async () => {
      expect(SSH_COMMAND_TIMEOUT_MS).toBeLessThanOrEqual(60_000)
      expect(SSH_DETACH_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000)
      expect(SSH_EXEC_TIMEOUT_MS).toBeGreaterThanOrEqual(15 * 60_000)
      /*
       * The same slow remote. It takes longer than the deadline of starting a host, however late its
       * process begins, and far less than the step's, so nothing here depends on how fast a process starts.
       */
      const slow = { FAKE_SSH_SLOW_MS: '4000' }
      const limits = { detachTimeoutMs: 1500, execTimeoutMs: 60_000 }
      await expect(tunnel(slow, undefined, limits).startHost()).rejects.toThrow(/did not finish within/)
      expect((await tunnel(slow, undefined, limits).exec('true')).stdout).toBe('slow ok\n')
    }, 30_000 * SLOW)

    it('reads a character that arrives in two pieces as one character', async () => {
      const r = await tunnel({ FAKE_SSH_SPLIT: '1' }).exec('true')
      expect(r.stdout).toBe('한\n')
    })
  })

  describe('what the forward keeps of its ssh stderr', () => {
    it('keeps only the end of megabytes of stderr, and the reason the link ended is its last line', async () => {
      const t = tunnel({ FAKE_SSH_LINE: line({ port: await freePort() }), FAKE_SSH_NOISE: '1' })
      const down = new Promise<string>((r) => t.onDown(r))
      await t.open()
      const reason = await down
      expect(reason).toMatch(/ssh exited \(1\)/)
      expect(reason).toContain('connection reset by the remote, said last')
      // The first line is long gone: it was about 5 MB ago, and only the end is kept
      expect(reason).not.toContain('Permission denied')
    })
  })

  it('forgets an ssh that could not be started', async () => {
    const t = new SshTunnel({ target: 'box', ssh: join(dir, 'no-such-ssh'), env: process.env })
    tunnels.push(t)
    await expect(t.exec('true')).rejects.toThrow(/ENOENT/)
    expect((t as unknown as { asking: Set<unknown> }).asking.size).toBe(0)
  })

  it('closing while the remote is still being asked ends that ssh, and starts no forward after it', async () => {
    const t = tunnel({ FAKE_SSH_LINE: line({ port: await freePort() }), FAKE_SSH_HANG: '1' })
    const opening = t.open()
    opening.catch(() => {})
    let pid = 0
    for (let i = 0; i < 250 && !pid; i++) {
      pid = (logged().find((l) => typeof l === 'object' && l !== null && 'hanging' in l) as { hanging: number } | undefined)?.hanging ?? 0
      if (!pid) await new Promise((r) => setTimeout(r, 20))
    }
    expect(pid).toBeGreaterThan(0)
    await t.close()
    await expect(opening).rejects.toThrow(/was closed/)
    const alive = () => isAlive(pid)
    for (let i = 0; i < 250 && alive(); i++) await new Promise((r) => setTimeout(r, 20))
    expect(alive()).toBe(false)
    expect((logged() as string[][]).filter((a) => Array.isArray(a) && a.includes('-L'))).toEqual([])
  })

  it('tells the person to update a Centralu that prints no connection line with the npm their shell runs (#688)', async () => {
    // A Centralu there from before `serve`: it answers, with no line of ours
    const old = { FAKE_SSH_LINE: '{}', FAKE_SSH_HAS: 'centralu' }
    await expect(tunnel(old, { shell: 'powershell' }).open()).rejects.toThrow('may predate `centralu.cmd serve` (update it there: npm.cmd i -g centralu)')
    await expect(tunnel(old).open()).rejects.toThrow('may predate `centralu serve` (update it there: npm i -g centralu)')
  })

  it('a forward ssh refuses fails the open with ssh’s reason', async () => {
    await expect(tunnel({ FAKE_SSH_LINE: line({ port: await freePort() }), FAKE_SSH_FORWARD_FAIL: '1' }).open()).rejects.toThrow(/Address already in use/)
  })

  it('reaches a Windows remote through PowerShell, and a WSL distro through wsl.exe, decoded as the remote would', async () => {
    await tunnel({ FAKE_SSH_LINE: line({ port: await freePort() }) }, { shell: 'powershell' }).open()
    await tunnel({ FAKE_SSH_LINE: line({ port: await freePort() }) }, { shell: 'wsl', wslDistro: 'Ubuntu-24.04' }).open()
    const runs = (logged() as { shell?: string; run?: string }[]).filter((x) => x.shell)
    expect(runs[0]!.shell).toBe('powershell')
    // A full credential of its own is asked for at each link (#1405): `--pair hub:<this computer>`
    expect(runs[0]!.run).toMatch(/elseif \(Get-Command centralu\.cmd -ErrorAction SilentlyContinue\) \{ & centralu\.cmd serve --connection --pair hub:[A-Za-z0-9._-]+ \} else \{ \$l = Join-Path \$d 'bin\\centralu\.cmd'/)
    expect(runs[1]!.shell).toBe('wsl:Ubuntu-24.04')
    // Windows' drives are off PATH inside the distro: its npm shim must not answer for the distro
    expect(runs[1]!.run).toMatch(/^PATH=\$\(printf %s "\$PATH" \| tr : '\\n' \| grep -v '\^\/mnt\/' \| paste -sd: -\); d=.*; m=.*; if \[ -x "\$m" \]; then .*elif command -v centralu/)
    // The WSL forward holds a process in the distro, so WSL does not stop it under the link
    const forwards = (logged() as string[][]).filter((a) => Array.isArray(a) && a.includes('-L'))
    expect(forwards[0]).toContain('-N')
    expect(forwards[1]!.at(-1)).toBe('wsl.exe -d Ubuntu-24.04 --exec sleep infinity')
    expect(forwards[1]).not.toContain('-N')
  })

  it('pairs for a credential of its own, and asks a serve from before pairing as before, once (#1405)', async () => {
    const t = tunnel({ FAKE_SSH_NO_PAIR: '1' })
    await expect(t.open()).resolves.toMatchObject({ token: 'tok' })
    const runs = (logged() as { run?: string }[]).filter((x) => x.run).map((x) => x.run!)
    expect(runs.map((r) => / --pair hub:/.test(r))).toEqual([true, false])
    // The refusal is remembered for this link: the next open asks without --pair at once
    await t.close()
    await expect(t.open()).resolves.toMatchObject({ token: 'tok' })
    const after = (logged() as { run?: string }[]).filter((x) => x.run).map((x) => x.run!)
    expect(after.slice(2).map((r) => / --pair hub:/.test(r))).toEqual([false])
  })

  it('asks with --pair again once a remote that refused it was updated, rather than linking with no credential (#1405 review)', async () => {
    const flag = join(dir, `no-pair-${Date.now()}`)
    writeFileSync(flag, '')
    const t = tunnel({ FAKE_SSH_NO_PAIR_FILE: flag })
    await expect(t.open()).resolves.toMatchObject({ token: 'tok' })
    await t.close()
    // Updated there: it takes --pair now, and prints no token without it
    rmSync(flag, { force: true })
    await expect(t.open()).resolves.toMatchObject({ token: 'tok' })
    const runs = (logged() as { run?: string }[]).filter((x) => x.run).map((x) => / --pair hub:/.test(x.run!))
    expect(runs).toEqual([true, false, false, true])
  })

  it('pairs under a label of its own: its name, and a key that tells it from a hub of the same name', () => {
    expect(pairLabel('Mac-mini', hubKeyOf('hub-0123abcd'))).toBe('hub:Mac-mini-0123abcd')
    // Two hubs of one computer name are two labels by their own random ids, whatever their data folders' paths
    expect(pairLabel('Mac-mini', hubKeyOf('hub-0123abcd'))).not.toBe(pairLabel('Mac-mini', hubKeyOf('hub-89abcdef')))
    expect(hubKeyOf('not an id')).toMatch(/^[0-9a-f]{8}$/)
    // Never past what --pair takes (80 characters)
    expect(pairLabel('x'.repeat(64), hubKeyOf('/d')).length).toBeLessThanOrEqual(80)
  })

  it('runs the person’s own command in place of centralu, with no fallback', async () => {
    const cmd = 'CC_DATA_DIR=/tmp/x node /src/packaging/npm/centralu/bin/centralu.mjs'
    await expect(tunnel({ FAKE_SSH_HAS: 'launcher' }, { shell: 'posix', command: cmd }).open()).rejects.toThrow(/No such file or directory/)
    const runs = (logged() as { run?: string }[]).filter((x) => x.run).map((x) => x.run)
    expect(runs).toEqual([expect.stringMatching(/^CC_DATA_DIR=\/tmp\/x node \/src\/packaging\/npm\/centralu\/bin\/centralu\.mjs serve --connection --pair hub:[A-Za-z0-9._-]+$/)])
    await expect(tunnel({ FAKE_SSH_HAS: cmd }, { shell: 'posix', command: cmd }).open()).resolves.toMatchObject({ token: 'tok' })
  })

  describe('starting a remote host it finds not running (remote-hub.md §10.9, decision 7)', () => {
    const stateFile = () => join(dir, 'host-running')
    const runs = () => (logged() as { shell?: string; run?: string }[]).filter((x) => x.run)

    it('starts it with `centralu serve --detach` through the same lookup, in every shell, and then forwards to it', async () => {
      for (const spec of [{ shell: 'posix' }, { shell: 'powershell' }, { shell: 'wsl', wslDistro: 'Ubuntu-24.04' }] as RemoteSpec[]) {
        rmSync(stateFile(), { force: true })
        const t = tunnel({ FAKE_SSH_STATE: stateFile(), FAKE_SSH_DETACH: 'ok', FAKE_SSH_LINE: line({ port: await freePort() }) }, spec)
        expect((await t.open()).line.hostRunning).toBe(false)
        await expect(t.startHost()).resolves.toEqual({ how: 'detached', note: null })
        const ep = await t.open()
        expect(ep.line.hostRunning).toBe(true)
        expect(ep.localPort).toBeGreaterThan(0)
      }
      const detaches = runs().filter((r) => r.run!.includes('serve --detach'))
      expect(detaches.map((r) => r.shell)).toEqual(['posix', 'powershell', 'wsl:Ubuntu-24.04'])
      expect(detaches[0]!.run).toMatch(/^sh -c .d=.*; m=.*if \[ -x "\$m" \]; then exec "\$m" serve --detach; elif command -v centralu .*then exec centralu serve --detach; elif .* exec "\$d\/bin\/centralu" serve --detach; else echo CENTRALU-NOT-FOUND/)
      expect(detaches[1]!.run).toContain('{ & centralu.cmd serve --detach }')
      // A detached host needs nothing from the forward: a plain -N (and the distro keep-alive for WSL)
      const forwards = (logged() as string[][]).filter((a) => Array.isArray(a) && a.includes('-L'))
      expect(forwards[0]).toContain('-N')
      expect(forwards.at(-1)!.at(-1)).toBe('wsl.exe -d Ubuntu-24.04 --exec sleep infinity')
    }, 30_000 * SLOW)

    /*
     * #1223: the host a link starts writes the hub's name to its host.lock, so a Centralu window on that machine that
     * finds the folder held can say whose link holds it. Only a remote whose line says it takes `--from` is sent one:
     * an older serve answers an option it does not know with an error, and would never start
     */
    it('names this computer to a remote that takes --from, cleaned for its command line, and to no other', async () => {
      for (const takes of [['from'], undefined]) {
        rmSync(stateFile(), { force: true })
        const t = tunnel(
          { FAKE_SSH_STATE: stateFile(), FAKE_SSH_DETACH: 'ok', FAKE_SSH_LINE: line({ port: await freePort(), ...(takes ? { takes } : {}) }) },
          { shell: 'powershell' },
          { hubName: 'Jun’s MacBook Pro.local' },
        )
        expect((await t.open()).line.takes).toEqual(takes)
        await expect(t.startHost()).resolves.toEqual({ how: 'detached', note: null })
      }
      const detaches = runs().filter((r) => r.run!.includes('serve --detach'))
      expect(detaches[0]!.run).toContain('{ & centralu.cmd serve --detach --from Jun-s-MacBook-Pro.local }')
      expect(detaches[1]!.run).toContain('{ & centralu.cmd serve --detach }')
      expect(hubNameForRemote('---')).toBeNull()
      expect(hubNameForRemote('a'.repeat(80))).toHaveLength(64)
    }, 30_000 * SLOW)

    it('where WMI is blocked, runs the host in the forward’s own session instead, and it ends with the link', async () => {
      const t = tunnel({ FAKE_SSH_STATE: stateFile(), FAKE_SSH_DETACH: 'blocked', FAKE_SSH_LINE: line({ port: await freePort() }) }, { shell: 'powershell' })
      expect((await t.open()).line.hostRunning).toBe(false)
      const started = await t.startHost()
      expect(started.how).toBe('link_bound')
      expect(started.note).toMatch(/did not start Centralu through WMI/)
      const ep = await t.open()
      expect(ep.line.hostRunning).toBe(true)
      const hosting = (logged() as { hosting?: string; run?: string; pid?: number }[]).filter((x) => x.hosting)
      expect(hosting).toHaveLength(1)
      expect(hosting[0]!.hosting).toBe('powershell')
      expect(hosting[0]!.run).toContain('{ & centralu.cmd serve }')
      const forward = (logged() as string[][]).filter((a) => Array.isArray(a) && a.includes('-L')).at(-1)!
      expect(forward).toContain('-T')
      expect(forward).not.toContain('-N')
      await t.close()
      // The host is the ssh session's process: it is gone with the link. Windows ends ssh outright,
      // with no SIGTERM for the fake to clean up its marker file on, so the process is what shows it there.
      const pid = hosting[0]!.pid!
      await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 10_000 * SLOW })
      if (process.platform !== 'win32') expect(existsSync(stateFile())).toBe(false)
    }, 30_000 * SLOW)

    it('says why a start failed, and that a remote too old for --detach has to be started there', async () => {
      const at = async (how: string) => {
        const t = tunnel({ FAKE_SSH_STATE: stateFile(), FAKE_SSH_DETACH: how, FAKE_SSH_LINE: line({ port: await freePort() }) })
        return t.startHost()
      }
      await expect(at('exited')).rejects.toThrow(/exited \(1\) before its host answered/)
      await expect(at('old')).rejects.toThrow(/too old to be started from here: run `centralu serve` there/)
      await expect(tunnel({ FAKE_SSH_HAS: '' }).startHost()).rejects.toThrow(/not installed on box/)
    }, 30_000 * SLOW)

    it('tells a Node below the floor from other failures: the launcher’s refusal, and a host that crashed at startup (#699)', async () => {
      const at = async (how: string) => {
        const t = tunnel({ FAKE_SSH_STATE: stateFile(), FAKE_SSH_DETACH: how, FAKE_SSH_LINE: line({ port: await freePort() }) })
        return t.startHost().catch((e: unknown) => e)
      }
      expect(await at('old_node')).toMatchObject({ name: 'NodeTooOld', kind: 'refused', found: '22.12.0', message: expect.stringContaining('needs Node 22.14.0 or newer') })
      expect(await at('crashed')).toMatchObject({ name: 'NodeTooOld', kind: 'crashed', found: null })
      // Any other exit stays an ordinary failure
      expect(await at('exited')).not.toMatchObject({ name: 'NodeTooOld' })
    }, 30_000 * SLOW)
  })
})

describe('the remote command per shell (#82)', () => {
  const decode = (cmd: string) => Buffer.from(cmd.split('-EncodedCommand ')[1]!, 'base64').toString('utf16le')

  it('a POSIX remote runs the lookup under sh, so a login shell like fish runs it too; the person’s own command runs as given', () => {
    const cmd = connectionCommand({ shell: 'posix' })
    expect(cmd.startsWith("sh -c '")).toBe(true)
    // Nothing inside closes the single quotes early
    expect(cmd.slice("sh -c '".length, -1)).not.toContain("'")
    expect(connectionCommand({ shell: 'posix', command: 'x' })).toBe('x serve --connection')
  })

  // Run by a real sh, as a POSIX remote would: the order is the shell's, not a string's. Skipped on
  // Windows because the script is the remote's, and a Windows machine has no /bin/sh of its own to be that remote.
  it.skipIf(process.platform === 'win32')('runs the managed launcher before centralu on PATH and before the launcher serve keeps (plan §10.1)', () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-lookup-'))
    try {
      const put = (file: string, word: string) => {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, `#!/bin/sh\necho ${word} "$@"\n`)
        chmodSync(file, 0o755)
      }
      const run = (env: Record<string, string> = {}) =>
        execFileSync('/bin/sh', ['-c', connectionCommand({ shell: 'posix' })], { env: { HOME: home, PATH: `${join(home, 'path')}:/usr/bin:/bin`, ...env }, encoding: 'utf8' }).trim()
      put(join(home, '.centralu', 'bin', 'centralu'), 'npm-launcher')
      expect(run()).toBe('npm-launcher serve --connection')
      put(join(home, 'path', 'centralu'), 'on-path')
      expect(run()).toBe('on-path serve --connection')
      put(join(home, '.centralu', 'remote', 'bin', 'centralu'), 'managed')
      expect(run()).toBe('managed serve --connection')
      // Under CC_DATA_DIR the managed launcher is looked for there, as serve and the installer put it
      put(join(home, 'data', 'remote', 'bin', 'centralu'), 'managed-data')
      expect(run({ CC_DATA_DIR: join(home, 'data') })).toBe('managed-data serve --connection')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('looks for the launcher serve keeps under CC_DATA_DIR too, where serve writes it, not only under ~/.centralu', () => {
    const home = mkdtempSync(join(tmpdir(), 'cc-lookup-'))
    try {
      // `centralu` only on an interactive PATH (nvm): the ssh command finds serve's launcher alone, in the data folder
      const file = join(home, 'data', 'bin', 'centralu')
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, '#!/bin/sh\necho serve-data "$@"\n')
      chmodSync(file, 0o755)
      const out = execFileSync('/bin/sh', ['-c', connectionCommand({ shell: 'posix' })], { env: { HOME: home, PATH: '/usr/bin:/bin', CC_DATA_DIR: join(home, 'data') }, encoding: 'utf8' }).trim()
      expect(out).toBe('serve-data serve --connection')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('a Windows remote tries the managed launcher before centralu on PATH too', () => {
    const ps = decode(connectionCommand({ shell: 'powershell' }))
    const managed = ps.indexOf("$m = Join-Path $d 'remote\\bin\\centralu.cmd'; if (Test-Path $m) { & $m serve --connection }")
    expect(managed).toBeGreaterThan(-1)
    expect(ps.indexOf('elseif (Get-Command centralu.cmd')).toBeGreaterThan(managed)
    expect(ps).toContain("$d = if ($env:CC_DATA_DIR) { $env:CC_DATA_DIR } else { Join-Path $env:USERPROFILE '.centralu' }")
    // The launcher serve keeps is in the same data folder (serve-install.mjs), CC_DATA_DIR included
    expect(ps).toContain("$l = Join-Path $d 'bin\\centralu.cmd'")
    expect(ps).not.toContain("'.centralu\\bin")
  })

  it('a Windows remote never runs a bare centralu: PowerShell would resolve it to the .ps1 shim a default execution policy blocks (#688)', () => {
    for (const cmd of [connectionCommand, detachCommand, (s: RemoteSpec) => stopCommand(s, { forUpdate: true }), serveCommand, (s: RemoteSpec) => autostartCommand(s, 'on'), (s: RemoteSpec) => autostartCommand(s, 'status')]) {
      const ps = decode(cmd({ shell: 'powershell' }))
      expect(ps).not.toMatch(/(?:&|Get-Command)\s+centralu(?!\.cmd)\b/)
      expect(ps).toMatch(/& centralu\.cmd /)
    }
    // posix and wsl keep the bare name, which is the right one there
    expect(connectionCommand({ shell: 'posix' })).toContain('exec centralu serve --connection')
    expect(decode(connectionCommand({ shell: 'wsl', wslDistro: 'Ubuntu' }))).not.toContain('centralu.cmd')
  })

  it('tells a Windows person to type the .cmd shims, and anyone else the plain names', () => {
    expect(shimNames({ shell: 'powershell' })).toEqual({ npm: 'npm.cmd', centralu: 'centralu.cmd' })
    expect(shimNames({ shell: 'posix' })).toEqual({ npm: 'npm', centralu: 'centralu' })
    expect(shimNames({ shell: 'wsl', wslDistro: 'Ubuntu' })).toEqual({ npm: 'npm', centralu: 'centralu' })
  })

  it('nothing that is not base64 crosses PowerShell, so no quote is re-parsed on the way', () => {
    for (const spec of [{ shell: 'powershell' }, { shell: 'wsl', wslDistro: 'Ubuntu-24.04', command: `A="x y" node '/s p/c.mjs'` }] as RemoteSpec[]) {
      const cmd = connectionCommand(spec)
      expect(cmd).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/)
    }
    const wsl = decode(connectionCommand({ shell: 'wsl', wslDistro: 'Ubuntu-24.04', command: `A="x y" node '/s p/c.mjs'` }))
    const inner = /echo ([A-Za-z0-9+/=]+) \|/.exec(wsl)![1]!
    expect(Buffer.from(inner, 'base64').toString('utf8')).toBe(`A="x y" node '/s p/c.mjs' serve --connection`)
  })

  it('refuses a WSL distro name that could break out of its quotes', () => {
    expect(() => connectionCommand({ shell: 'wsl', wslDistro: "x'; rm -rf ~" })).toThrow(/Not a WSL distro name/)
    expect(() => connectionCommand({ shell: 'wsl' })).toThrow(/Not a WSL distro name/)
  })

  // #1143: the person's stop there, which keeps the hub from starting a host by itself; an older serve says nothing
  it('reads the person’s stop from the line, as words it can be, and nothing from a line without it', () => {
    const base = { v: 1, port: 17175, token: 't', protocolVersion: 1, hostRunning: false }
    expect(parseConnectionLine(JSON.stringify({ ...base, stopped: { by: 'quit', at: 5 } })).stopped).toEqual({ by: 'quit', at: 5 })
    expect(parseConnectionLine(JSON.stringify({ ...base, stopped: { by: '`rm -rf`', at: 'soon' } })).stopped).toEqual({ by: 'stop', at: null })
    expect(parseConnectionLine(JSON.stringify(base))).not.toHaveProperty('stopped')
    expect(parseConnectionLine(JSON.stringify({ ...base, stopped: true }))).not.toHaveProperty('stopped')
  })

  it('says it is the hub’s own stop to serve --stop in every shell, so serve leaves no mark of the person’s stop', () => {
    const decode = (cmd: string) => Buffer.from(cmd.split('-EncodedCommand ')[1]!, 'base64').toString('utf16le')
    const stop = { forUpdate: false }
    expect(stopCommand({ shell: 'posix' }, stop)).toMatch(/^sh -c 'CENTRALU_STOP_BY=hub; export CENTRALU_STOP_BY; d=/)
    expect(decode(stopCommand({ shell: 'powershell' }, stop))).toContain("$env:CENTRALU_STOP_BY = 'hub'; $d = ")
    const wsl = decode(stopCommand({ shell: 'wsl', wslDistro: 'Ubuntu' }, stop))
    const script = Buffer.from(/echo ([A-Za-z0-9+/=]+) \| base64/.exec(wsl)![1]!, 'base64').toString('utf8')
    expect(script).toContain('; CENTRALU_STOP_BY=hub; export CENTRALU_STOP_BY; d=')
    // An uninstall's stop: no host starts after it, so none lists the turns it ends (#1618)
    for (const cmd of [stopCommand({ shell: 'posix' }, stop), decode(stopCommand({ shell: 'powershell' }, stop)), script]) expect(cmd).not.toContain('CENTRALU_STOP_FOR')
    // Only the stop says it
    for (const cmd of [connectionCommand, detachCommand, serveCommand]) {
      expect(cmd({ shell: 'posix' })).not.toContain('CENTRALU_STOP_BY')
      expect(decode(cmd({ shell: 'powershell' }))).not.toContain('CENTRALU_STOP_BY')
    }
  })

  it('says a stop a host starts again after is for an update, in every shell, so the host lists the turns it ends (#1618)', () => {
    const decode = (cmd: string) => Buffer.from(cmd.split('-EncodedCommand ')[1]!, 'base64').toString('utf16le')
    const update = { forUpdate: true }
    expect(stopCommand({ shell: 'posix' }, update)).toMatch(/^sh -c 'CENTRALU_STOP_BY=hub; export CENTRALU_STOP_BY; CENTRALU_STOP_FOR=update; export CENTRALU_STOP_FOR; d=/)
    expect(decode(stopCommand({ shell: 'powershell' }, update))).toContain("$env:CENTRALU_STOP_BY = 'hub'; $env:CENTRALU_STOP_FOR = 'update'; $d = ")
    const wsl = decode(stopCommand({ shell: 'wsl', wslDistro: 'Ubuntu' }, update))
    const script = Buffer.from(/echo ([A-Za-z0-9+/=]+) \| base64/.exec(wsl)![1]!, 'base64').toString('utf8')
    expect(script).toContain('; CENTRALU_STOP_BY=hub; export CENTRALU_STOP_BY; CENTRALU_STOP_FOR=update; export CENTRALU_STOP_FOR; d=')
  })

  it('reads the connection line past anything else the remote shell printed', () => {
    expect(parseConnectionLine('Welcome!\r\n{"v":1,"port":17175,"token":"t","version":"0.1.0","protocolVersion":1,"dataDir":"/d","hostRunning":true}\r\n')).toMatchObject({ port: 17175, token: 't' })
    expect(() => parseConnectionLine('{"v":2}')).toThrow(/connection format 2/)
    expect(() => parseConnectionLine('nothing here')).toThrow(/did not print a connection line/)
  })

  /*
   * The line another release's `serve` prints (#384): an older remote's line lacks what was added since and reads with
   * its defaults, a newer one's extra fields are not this build's to read, and a line missing what a connection needs
   * is an error that says so, never a connection made on a guess.
   */
  it("reads an older remote's line with defaults, ignores a newer one's extra fields, and refuses one without what it needs", () => {
    expect(parseConnectionLine('{"v":1,"port":17175,"token":"t","protocolVersion":1}')).toEqual({
      v: 1, port: 17175, token: 't', version: 'unknown', protocolVersion: 1, dataDir: '', hostRunning: false,
    })
    const newer = parseConnectionLine('{"v":1,"port":17175,"token":"t","protocolVersion":2,"version":"9.0.0","laterField":{"a":1},"hostRunning":"yes"}')
    expect(newer).toEqual({ v: 1, port: 17175, token: 't', version: '9.0.0', protocolVersion: 2, dataDir: '', hostRunning: false })
    for (const line of ['{"v":1,"token":"t","protocolVersion":1}', '{"v":1,"port":"17175","token":"t","protocolVersion":1}', '{"v":1,"port":17175,"protocolVersion":1}', '{"v":1,"port":17175,"token":"t"}']) {
      expect(() => parseConnectionLine(line)).toThrow('The remote answered with an incomplete connection line')
    }
  })

  it('reads the reason out of what ssh, PowerShell and Node print around it (measured on Windows)', () => {
    const pq = '** WARNING: connection is not using a post-quantum key exchange algorithm.\n** This session may be vulnerable to "store now, decrypt later" attacks.\n'
    expect(lastLine(`${pq}ssh: connect to host 192.0.2.24 port 22: Operation timed out\n`)).toBe('ssh: connect to host 192.0.2.24 port 22: Operation timed out')
    expect(lastLine("node:internal/modules/cjs/loader:1386\nError: Cannot find module '/var/tmp/x.mjs'\n    at Module._resolveFilename (node:internal)\n\nNode.js v22.23.3\n")).toBe(
      "Error: Cannot find module '/var/tmp/x.mjs'",
    )
    // An error record is PowerShell's way of saying what went wrong: its text is read, not dropped with the XML (#1081)
    expect(lastLine('#< CLIXML\n<Objs Version="1.1.0.1"><S S="Error">Cloning into x</S></Objs>')).toBe('Cloning into x')
    // The kept tail can begin after the header, inside the XML: up to its end the XML is dropped, a record cut in two too
    expect(lastLine('ssh: connect to host x port 22: Connection refused\nrest of the message_x000D__x000A_</S><S S="Error">Cloning into x</S></Objs>')).toBe('ssh: connect to host x port 22: Connection refused')
    expect(lastLine('Cloning into x_x000D__x000A_</S></Objs>')).toBe('')
    expect(lastLine('some error text that was cut_x000D__x000A_')).toBe('')
    expect(lastLine('<S S="Error">Cloning into x</S></Objs>')).toBe('Cloning into x')
  })

  /*
   * #1081: Windows PowerShell writes its `#< CLIXML` header before its first progress record, so what a command it runs
   * writes to stderr after that comes after the header, and its own error records are inside the XML. Both were dropped
   * with everything from the header on. Measured with Windows PowerShell 5.1 on Windows 11 (2026-10-18), on a machine
   * whose display language is Korean: the first progress record is PowerShell's own "Preparing modules for first use".
   */
  it("keeps what a command wrote after PowerShell's CLIXML header, and the text of its error records (measured)", () => {
    const progress =
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>처음 사용하기 위해 모듈을 준비하는 중입니다.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj><Obj S="progress" RefId="1"><TNRef RefId="0" /><MS><I64 N="SourceId">0</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Processing</T><SR>-1</SR><SD> </SD></PR></MS></Obj></Objs>'
    expect(lastLine(`#< CLIXML\r\nstand-in failure on stop\n${progress}`)).toBe('stand-in failure on stop')
    // `throw 'download node'` under $ErrorActionPreference = 'Stop': the message, not PowerShell's position and category lines
    const thrown =
      '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><S S="Error">download node_x000D__x000A_</S><S S="Error">At line:4 char:1_x000D__x000A_</S><S S="Error">+ throw \'download node\'_x000D__x000A_</S><S S="Error">+ ~~~~~~~~~~~~~~~~~~~~~_x000D__x000A_</S><S S="Error">    + CategoryInfo          : OperationStopped: (download node:String) [], RuntimeException_x000D__x000A_</S><S S="Error">    + FullyQualifiedErrorId : download node_x000D__x000A_</S><S S="Error"> _x000D__x000A_</S></Objs>'
    expect(lastLine(thrown)).toBe('download node')
    // The position line is in the machine's language (measured on the same machine, through the hub's PS_PREAMBLE)
    expect(lastLine(thrown.replace('At line:4 char:1', '위치 줄:4 문자:1'))).toBe('download node')
    // The XML's escapes are read back, and text around and between blocks is kept
    expect(lastLine('#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">the &lt;thing&gt; &amp; _x005F_its file could not be read_x000D__x000A_</S></Objs>')).toBe('the <thing> & _its file could not be read')
    expect(lastLine(`before\n#< CLIXML\r\n${progress}\nafter the progress\n#< CLIXML\r\n${progress}`)).toBe('after the progress')
    // A position line is known by its whole shape: a message that only ends like one is the message (review of #1116)
    expect(lastLine('#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">could not write b.log:12 col:5_x000D__x000A_</S></Objs>')).toBe('could not write b.log:12 col:5')
    expect(lastLine('#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">download node_x000D__x000A_</S><S S="Error">At C:\\Program Files\\x\\install.ps1:12 char:5_x000D__x000A_</S></Objs>')).toBe('download node')
    // A stream that ends inside the XML keeps its whole records and drops the rest
    expect(lastLine('#< CLIXML\r\nnot found: x\n<Objs Version="1.1.0.1"><S S="Error">Access is denied_x000D__x000A_</S><Obj S="progress" RefId="0"><TN')).toBe('Access is denied')
  })

  /*
   * #849: ssh writes the bytes of its messages it does not print as octal escapes, and Windows' OpenSSH has a system
   * error's text in the ANSI code page: on a Korean machine the reason reached the person as `\276\313\267\301…`
   * (measured with OpenSSH_for_Windows 9.5p2, code page 949).
   */
  it("puts ssh's octal escapes back as text, in UTF-8 or the machine's ANSI code page", () => {
    const cp949 = (bytes: Buffer) => new TextDecoder('euc-kr', { fatal: true }).decode(bytes)
    const measured = 'ssh: Could not resolve hostname x.invalid: \\276\\313\\267\\301\\301\\370 \\310\\243\\275\\272\\306\\256\\260\\241 \\276\\370\\275\\300\\264\\317\\264\\331.\r\n'
    expect(lastLine(measured, cp949)).toBe('ssh: Could not resolve hostname x.invalid: 알려진 호스트가 없습니다.')
    // UTF-8 needs no code page
    expect(lastLine('ssh: x: \\354\\227\\260\\352\\262\\260 \\352\\261\\260\\353\\266\\200\n', () => null)).toBe('ssh: x: 연결 거부')
    // Escapes of ASCII are never ssh's (it prints ASCII as it is): a Windows path keeps its backslashes
    expect(lastLine('Could not open C:\\123\\101 file\n', cp949)).toBe('Could not open C:\\123\\101 file')
    // Bytes that are text in neither stay as they came
    expect(lastLine('error: \\377\\377\n', () => null)).toBe('error: \\377\\377')
  })

  it.runIf(process.platform === 'win32' && existsSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')))(
    "on Windows, the reason Windows' own ssh gives has no octal escapes left in it",
    () => {
      const ssh = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe')
      const run = spawnSync(ssh, ['-F', 'none', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', 'cc-no-such-host.invalid', 'true'], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
      const why = lastLine(run.stderr)
      expect(why).toMatch(/cc-no-such-host\.invalid/)
      expect(why).not.toMatch(/\\[0-7]{3}/)
    },
    40_000 * SLOW,
  )

  /*
   * Review of #1116: PowerShell 7 (a Windows machine whose OpenSSH shell is pwsh) writes an error in its ConciseView, the
   * place in the script as a gutter around the message, and colours it with terminal escapes, which CLIXML carries as
   * `_x001B_`. Not measured here (no PowerShell 7 on this PC): the shape is ConciseView's as documented.
   */
  it("reads PowerShell 7's ConciseView error: the message out of its gutter, without its colour", () => {
    const esc = (s: string) => s.replaceAll('\x1b', '_x001B_').replace(/\n/g, '_x000D__x000A_')
    const concise = '\x1b[31;1mException: \x1b[0m\n\x1b[31;1mLine |\x1b[0m\n\x1b[31;1m   4 | \x1b[0m throw \'download node\'\n\x1b[31;1m     | \x1b[31;1m ~~~~~~~~~~~~~~~~~~~~~\x1b[0m\n\x1b[31;1m\x1b[31;1m     | download node\x1b[0m\n'
    expect(lastLine(`#< CLIXML\r\n<Objs Version="1.1.0.1"><S S="Error">${esc(concise)}</S></Objs>`)).toBe('download node')
    // Escapes a command wrote around the XML are not text either
    expect(lastLine('\x1b[31merror: the disk is full\x1b[0m\n')).toBe('error: the disk is full')
    // A tail that starts inside a record that only shows an ESC escape is still XML that was cut
    expect(lastLine('the last plain line\nthe end of a record that was cut_x001B_[0m')).toBe('the last plain line')
  })

  /*
   * #1081 for real: the hub's own `powershell -EncodedCommand`, through cmd.exe as Windows OpenSSH runs it, with a
   * progress record first (as "Preparing modules for first use" is on a cold machine) and a Node script that fails on
   * stderr after it, as the stand-in `serve --stop` of #845 did.
   */
  it.runIf(process.platform === 'win32')(
    "on Windows, the reason a command gives after PowerShell's CLIXML header reaches the person",
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'cc-clixml-'))
      try {
        const js = join(dir, 'fail.js')
        writeFileSync(js, "process.stderr.write('stand-in failure on stop\\n'); process.exit(1)\n")
        const script = `Write-Progress -Activity 'Preparing modules for first use.' -Status ' '\n& '${process.execPath}' '${js}'\nexit $LASTEXITCODE`
        const cmd = process.env.ComSpec ?? 'cmd.exe'
        const run = spawnSync(cmd, ['/d', '/s', '/c', powershell(script)], { encoding: 'utf8', windowsHide: true, windowsVerbatimArguments: true, timeout: 60_000 * SLOW })
        expect(run.status).toBe(1)
        expect(run.stderr).toContain('#< CLIXML')
        expect(lastLine(run.stderr)).toBe('stand-in failure on stop')
        const thrown = spawnSync(cmd, ['/d', '/s', '/c', powershell("$ErrorActionPreference = 'Stop'\nthrow 'download node'")], {
          encoding: 'utf8',
          windowsHide: true,
          windowsVerbatimArguments: true,
          timeout: 60_000 * SLOW,
        })
        expect(thrown.stderr).toContain('<S S="Error">')
        expect(lastLine(thrown.stderr)).toBe('download node')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    150_000 * SLOW,
  )
})

// The line says the running host can prove it holds the token (#838); only `true` counts, anything else is absent
describe('the proof field of the connection line', () => {
  it('is read only when it is exactly true', () => {
    const base = { v: 1, port: 17175, token: 't', version: '1', protocolVersion: 1, dataDir: '/d', hostRunning: true }
    expect(parseConnectionLine(JSON.stringify({ ...base, proof: true })).proof).toBe(true)
    for (const proof of [undefined, false, 'true', 1]) expect(parseConnectionLine(JSON.stringify({ ...base, proof })).proof).toBeUndefined()
  })
})

describe('serve --revoke over ssh (#1405)', () => {
  it('names one credential by its id, and reads whether there was one', () => {
    expect(revokeCommand({ shell: 'posix', command: 'x' }, 'abcd1234')).toBe('x serve --revoke abcd1234')
    expect(() => revokeCommand({ shell: 'posix' }, 'abcd; rm -rf ~')).toThrow(/8 hex characters/)
    expect(parseRevoke(['motd', '{"v":1,"revoked":true,"id":"abcd1234"}', ''].join('\n'))).toBe(true)
    expect(parseRevoke('{"v":1,"revoked":false,"id":"abcd1234"}')).toBe(false)
    // An older serve refuses the option and prints no line
    expect(parseRevoke('')).toBeNull()
  })
})
