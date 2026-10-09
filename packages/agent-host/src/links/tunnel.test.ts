import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { connectionCommand, lastLine, parseConnectionLine, SshTunnel, type RemoteSpec } from './tunnel.js'

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
  return { shell, cmd: cmd.replace('[Console]::OutputEncoding=[Text.Encoding]::UTF8\n', '') }
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
  // A remote command after the target: a link-bound host runs in this session, and ends with it
  const remote = args[args.indexOf('--') + 2]
  if (remote && / serve($|[;} ])/.test(decode(remote).cmd)) {
    fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ hosting: decode(remote).shell, run: decode(remote).cmd }) + '\n')
    if (state) fs.writeFileSync(state, 'link-bound')
    process.on('SIGTERM', () => { if (state) fs.rmSync(state, { force: true }); process.exit(0) })
  }
  setInterval(() => {}, 1 << 30)
  return
}
if (process.env.FAKE_SSH_HANG) { fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ hanging: process.pid }) + '\n'); setInterval(() => {}, 1 << 30); return }
if (process.env.FAKE_SSH_UNREACHABLE) { process.stderr.write('ssh: connect to host x port 22: Operation timed out\n'); process.exit(255) }
const { shell, cmd } = decode(args[args.length - 1])
fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ shell, run: cmd }) + '\n')
const has = (process.env.FAKE_SSH_HAS || '').split('|')
const line = (over) => JSON.stringify({ ...JSON.parse(process.env.FAKE_SSH_LINE), hostRunning: running(), ...over })
const answer = () => {
  // What centralu serve --detach answers, per FAKE_SSH_DETACH; anything else is --connection
  if (/ serve --detach/.test(cmd)) {
    const how = process.env.FAKE_SSH_DETACH
    if (how === 'old') { process.stderr.write('unknown option for serve: --detach\n'); process.exit(2) }
    if (how === 'blocked') return process.stdout.write(JSON.stringify({ v: 1, detach: { ok: false, how: 'wmi', reason: 'wmi_blocked', message: 'Windows did not start Centralu through WMI (returned 2).' } }) + '\n')
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

function tunnel(env: Record<string, string>, remoteSpec?: RemoteSpec) {
  const t = new SshTunnel({
    target: 'box',
    remote: remoteSpec,
    env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, FAKE_SSH_LOG: log, FAKE_SSH_LINE: line(), FAKE_SSH_HAS: 'centralu', ...env },
    forwardTimeoutMs: 5000,
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

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })

describe.skipIf(process.platform === 'win32')('the ssh transport, against a fake ssh (#82)', () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-fake-ssh-'))
    log = join(dir, 'log.jsonl')
    writeFileSync(log, '')
    writeFileSync(join(dir, 'ssh'), FAKE_SSH)
    chmodSync(join(dir, 'ssh'), 0o755)
    /*
     * The "remote host": an echo server, which is enough to see bytes cross a forward. Remote and
     * local are one machine here, so its port is taken locally and the tunnel picks another for
     * the local end; a test that needs the same number on both ends names a free port instead.
     */
    remote = createServer((c) => c.pipe(c))
    await new Promise<void>((r) => remote.listen(0, '127.0.0.1', () => r()))
    remotePort = (remote.address() as { port: number }).port
  })

  afterEach(async () => {
    await Promise.all(tunnels.splice(0).map((t) => t.close()))
    await new Promise<void>((r) => remote.close(() => r()))
    rmSync(dir, { recursive: true, force: true })
  })

  it('asks the remote for its connection line in batch mode, then forwards on loopback only', async () => {
    const t = tunnel({})
    const ep = await t.open()
    expect(ep.token).toBe('tok')
    expect(ep.line).toMatchObject({ port: remotePort, version: '0.1.0-beta.11', hostRunning: true })
    const [ask, forward] = (logged() as unknown[]).filter((x): x is string[] => Array.isArray(x))
    expect(ask!.slice(0, -1)).toEqual(['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '--', 'box'])
    expect(ask!.at(-1)).toMatch(/^sh -c 'm=.*; if \[ -x "\$m" \]; then .*elif command -v centralu .* serve --connection; .*CENTRALU-NOT-FOUND; exit 127; fi'$/)
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
    const echoed = await new Promise<string>((resolve) => {
      const c = createConnection(ep.localPort, '127.0.0.1', () => c.write('ping'))
      c.on('data', (d) => {
        resolve(String(d))
        c.destroy()
      })
    })
    expect(echoed).toBe('ping')
    expect(ep.url).toBe(`ws://127.0.0.1:${ep.localPort}`)
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
     * What a link does on down (links.ts `transportDown`): opens again a little later. Reopening
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
    await reopen()
    // Long enough for several rounds of the churn (each about 50 ms plus one ssh round trip)
    await new Promise((r) => setTimeout(r, 1500))
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
    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    for (let i = 0; i < 250 && alive(); i++) await new Promise((r) => setTimeout(r, 20))
    expect(alive()).toBe(false)
    expect((logged() as string[][]).filter((a) => Array.isArray(a) && a.includes('-L'))).toEqual([])
  })

  it('a forward ssh refuses fails the open with ssh’s reason', async () => {
    await expect(tunnel({ FAKE_SSH_LINE: line({ port: await freePort() }), FAKE_SSH_FORWARD_FAIL: '1' }).open()).rejects.toThrow(/Address already in use/)
  })

  it('reaches a Windows remote through PowerShell, and a WSL distro through wsl.exe, decoded as the remote would', async () => {
    await tunnel({ FAKE_SSH_LINE: line({ port: await freePort() }) }, { shell: 'powershell' }).open()
    await tunnel({ FAKE_SSH_LINE: line({ port: await freePort() }) }, { shell: 'wsl', wslDistro: 'Ubuntu-24.04' }).open()
    const runs = (logged() as { shell?: string; run?: string }[]).filter((x) => x.shell)
    expect(runs[0]!.shell).toBe('powershell')
    expect(runs[0]!.run).toContain("elseif (Get-Command centralu -ErrorAction SilentlyContinue) { & centralu serve --connection } else { $l = Join-Path $env:USERPROFILE '.centralu\\bin\\centralu.cmd'")
    expect(runs[1]!.shell).toBe('wsl:Ubuntu-24.04')
    // Windows' drives are off PATH inside the distro: its npm shim must not answer for the distro
    expect(runs[1]!.run).toMatch(/^PATH=\$\(printf %s "\$PATH" \| tr : '\\n' \| grep -v '\^\/mnt\/' \| paste -sd: -\); m=.*; if \[ -x "\$m" \]; then .*elif command -v centralu/)
    // The WSL forward holds a process in the distro, so WSL does not stop it under the link
    const forwards = (logged() as string[][]).filter((a) => Array.isArray(a) && a.includes('-L'))
    expect(forwards[0]).toContain('-N')
    expect(forwards[1]!.at(-1)).toBe('wsl.exe -d Ubuntu-24.04 --exec sleep infinity')
    expect(forwards[1]).not.toContain('-N')
  })

  it('runs the person’s own command in place of centralu, with no fallback', async () => {
    const cmd = 'CC_DATA_DIR=/tmp/x node /src/packaging/npm/centralu/bin/centralu.mjs'
    await expect(tunnel({ FAKE_SSH_HAS: 'launcher' }, { shell: 'posix', command: cmd }).open()).rejects.toThrow(/No such file or directory/)
    const runs = (logged() as { run?: string }[]).filter((x) => x.run).map((x) => x.run)
    expect(runs).toEqual([`${cmd} serve --connection`])
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
      expect(detaches[0]!.run).toMatch(/^sh -c .m=.*if \[ -x "\$m" \]; then exec "\$m" serve --detach; elif command -v centralu .*then exec centralu serve --detach; elif .* exec "\$HOME\/.centralu\/bin\/centralu" serve --detach; else echo CENTRALU-NOT-FOUND/)
      expect(detaches[1]!.run).toContain('{ & centralu serve --detach }')
      // A detached host needs nothing from the forward: a plain -N (and the distro keep-alive for WSL)
      const forwards = (logged() as string[][]).filter((a) => Array.isArray(a) && a.includes('-L'))
      expect(forwards[0]).toContain('-N')
      expect(forwards.at(-1)!.at(-1)).toBe('wsl.exe -d Ubuntu-24.04 --exec sleep infinity')
    }, 30_000)

    it('where WMI is blocked, runs the host in the forward’s own session instead, and it ends with the link', async () => {
      const t = tunnel({ FAKE_SSH_STATE: stateFile(), FAKE_SSH_DETACH: 'blocked', FAKE_SSH_LINE: line({ port: await freePort() }) }, { shell: 'powershell' })
      expect((await t.open()).line.hostRunning).toBe(false)
      const started = await t.startHost()
      expect(started.how).toBe('link_bound')
      expect(started.note).toMatch(/did not start Centralu through WMI/)
      const ep = await t.open()
      expect(ep.line.hostRunning).toBe(true)
      const hosting = (logged() as { hosting?: string; run?: string }[]).filter((x) => x.hosting)
      expect(hosting).toHaveLength(1)
      expect(hosting[0]!.hosting).toBe('powershell')
      expect(hosting[0]!.run).toContain('{ & centralu serve }')
      const forward = (logged() as string[][]).filter((a) => Array.isArray(a) && a.includes('-L')).at(-1)!
      expect(forward).toContain('-T')
      expect(forward).not.toContain('-N')
      await t.close()
      expect(existsSync(stateFile())).toBe(false)
    }, 30_000)

    it('says why a start failed, and that a remote too old for --detach has to be started there', async () => {
      const at = async (how: string) => {
        const t = tunnel({ FAKE_SSH_STATE: stateFile(), FAKE_SSH_DETACH: how, FAKE_SSH_LINE: line({ port: await freePort() }) })
        return t.startHost()
      }
      await expect(at('exited')).rejects.toThrow(/exited \(1\) before its host answered/)
      await expect(at('old')).rejects.toThrow(/too old to be started from here: run `centralu serve` there/)
      await expect(tunnel({ FAKE_SSH_HAS: '' }).startHost()).rejects.toThrow(/not installed on box/)
    }, 30_000)
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

  // Run by a real sh, as a POSIX remote would: the order is the shell's, not a string's
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

  it('a Windows remote tries the managed launcher before centralu on PATH too', () => {
    const ps = decode(connectionCommand({ shell: 'powershell' }))
    const managed = ps.indexOf("$m = Join-Path $d 'remote\\bin\\centralu.cmd'; if (Test-Path $m) { & $m serve --connection }")
    expect(managed).toBeGreaterThan(-1)
    expect(ps.indexOf('elseif (Get-Command centralu')).toBeGreaterThan(managed)
    expect(ps).toContain("$d = if ($env:CC_DATA_DIR) { $env:CC_DATA_DIR } else { Join-Path $env:USERPROFILE '.centralu' }")
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

  it('reads the connection line past anything else the remote shell printed', () => {
    expect(parseConnectionLine('Welcome!\r\n{"v":1,"port":17175,"token":"t","version":"0.1.0","protocolVersion":1,"dataDir":"/d","hostRunning":true}\r\n')).toMatchObject({ port: 17175, token: 't' })
    expect(() => parseConnectionLine('{"v":2}')).toThrow(/connection format 2/)
    expect(() => parseConnectionLine('nothing here')).toThrow(/did not print a connection line/)
  })

  it('reads the reason out of what ssh, PowerShell and Node print around it (measured on Windows)', () => {
    const pq = '** WARNING: connection is not using a post-quantum key exchange algorithm.\n** This session may be vulnerable to "store now, decrypt later" attacks.\n'
    expect(lastLine(`${pq}ssh: connect to host 192.168.0.24 port 22: Operation timed out\n`)).toBe('ssh: connect to host 192.168.0.24 port 22: Operation timed out')
    expect(lastLine("node:internal/modules/cjs/loader:1386\nError: Cannot find module '/var/tmp/x.mjs'\n    at Module._resolveFilename (node:internal)\n\nNode.js v22.23.3\n")).toBe(
      "Error: Cannot find module '/var/tmp/x.mjs'",
    )
    expect(lastLine('#< CLIXML\n<Objs Version="1.1.0.1"><S S="Error">Cloning into x</S></Objs>')).toBe('')
  })
})
