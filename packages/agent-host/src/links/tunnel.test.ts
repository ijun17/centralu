import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
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
const L = args.indexOf('-L')
if (L !== -1) {
  if (process.env.FAKE_SSH_FORWARD_FAIL) { process.stderr.write('bind [127.0.0.1]:1: Address already in use\n'); process.exit(255) }
  const [bind, lport, rhost, rport] = args[L + 1].split(':')
  const server = net.createServer((c) => { const r = net.connect(Number(rport), rhost); c.pipe(r); r.pipe(c); c.on('error', () => r.destroy()); r.on('error', () => c.destroy()) })
  server.listen(Number(lport), bind)
  setInterval(() => {}, 1 << 30)
  return
}
if (process.env.FAKE_SSH_HANG) { fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ hanging: process.pid }) + '\n'); setInterval(() => {}, 1 << 30); return }
if (process.env.FAKE_SSH_UNREACHABLE) { process.stderr.write('ssh: connect to host x port 22: Operation timed out\n'); process.exit(255) }
let cmd = args[args.length - 1]
const enc = 'powershell -NoProfile -NonInteractive -EncodedCommand '
let shell = 'posix'
if (cmd.startsWith(enc)) {
  cmd = Buffer.from(cmd.slice(enc.length), 'base64').toString('utf16le')
  shell = 'powershell'
  const w = /wsl\.exe -d '([^']+)' -- bash -lc 'echo ([A-Za-z0-9+/=]+) \| base64 -d \| bash -l'$/.exec(cmd)
  if (w) { shell = 'wsl:' + w[1]; cmd = Buffer.from(w[2], 'base64').toString('utf8') }
}
fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ shell, run: cmd }) + '\n')
const has = (process.env.FAKE_SSH_HAS || '').split('|')
const answer = () => process.stdout.write('some motd line\n' + process.env.FAKE_SSH_LINE + '\n')
// The lookup centralu, then the launcher, then the not-found word, as connectionCommand writes it
if (cmd.includes('CENTRALU-NOT-FOUND')) {
  const used = has.includes('centralu') ? 'centralu' : has.includes('launcher') ? 'launcher' : null
  fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ used }) + '\n')
  if (used) answer()
  else { process.stdout.write('CENTRALU-NOT-FOUND\n'); process.exit(shell === 'posix' ? 127 : 1) }
} else {
  const program = cmd.replace('[Console]::OutputEncoding=[Text.Encoding]::UTF8\n', '').split(' serve --connection')[0]
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
    expect(ask!.at(-1)).toMatch(/^sh -c 'if command -v centralu .* serve --connection; .*CENTRALU-NOT-FOUND; exit 127; fi'$/)
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
    await expect(tunnel({ FAKE_SSH_HAS: '' }, { shell: 'wsl', wslDistro: 'Ubuntu-24.04' }).open()).rejects.toThrow(/not installed on box/)
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
    expect(runs[0]!.run).toContain("if (Get-Command centralu -ErrorAction SilentlyContinue) { & centralu serve --connection } else { $l = Join-Path $env:USERPROFILE '.centralu\\bin\\centralu.cmd'")
    expect(runs[1]!.shell).toBe('wsl:Ubuntu-24.04')
    // Windows' drives are off PATH inside the distro: its npm shim must not answer for the distro
    expect(runs[1]!.run).toMatch(/^PATH=\$\(printf %s "\$PATH" \| tr : '\\n' \| grep -v '\^\/mnt\/' \| paste -sd: -\); if command -v centralu/)
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
