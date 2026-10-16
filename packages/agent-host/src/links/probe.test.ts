import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseProbe, probeCommand, probeTarget } from './probe.js'
import { WINDOWS_INLINE_MAX } from './tunnel.js'
import { fakeExe, rmFakeDir } from '../fake-exe.test-helpers.js'

/**
 * The probe the Add machine dialog runs when the person picks a host (#514), against a fake `ssh`
 * that plays the three shells a command can land in: a POSIX shell (no `powershell`, exit 127),
 * Windows OpenSSH under cmd.exe or PowerShell (it decodes the `-EncodedCommand` as PowerShell would
 * and answers from a registry it is given), and ssh's own failure (255).
 */

const FAKE_SSH = String.raw`#!/usr/bin/env node
const fs = require('node:fs')
const args = process.argv.slice(2)
fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify(args) + '\n')
const as = process.env.FAKE_AS
if (as === 'hang') { setInterval(() => {}, 1 << 30); return }
// A reason whose first character's bytes arrive in two chunks
if (as === 'split') { const b = Buffer.from('접속 거부: 계정이 잠겼습니다\n'); process.stderr.write(b.subarray(0, 4)); setTimeout(() => { process.stderr.write(b.subarray(4)); process.exit(1) }, 200); return }
if (as === 'unreachable') { process.stderr.write('ijun1: Permission denied (publickey,password,keyboard-interactive).\n'); process.exit(255) }
const cmd = args[args.length - 1]
const enc = 'powershell -NoProfile -NonInteractive -EncodedCommand '
if (as === 'posix') { process.stderr.write('bash: line 1: powershell: command not found\n'); process.exit(127) }
if (as === 'csh') { process.stderr.write('powershell: Command not found.\n'); process.exit(1) }
if (as === 'odd') { process.stderr.write('This account is restricted\n'); process.exit(1) }
if (!cmd.startsWith(enc)) { process.stderr.write('not a probe\n'); process.exit(1) }
const script = Buffer.from(cmd.slice(enc.length), 'base64').toString('utf16le')
fs.appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ script }) + '\n')
// Answers what the script reads, from FAKE_REGISTRY: { platform, defaultShell, distros: [{ guid, name }], defaultGuid }
const reg = JSON.parse(process.env.FAKE_REGISTRY)
const out = ['CENTRALU-PROBE platform=' + reg.platform, 'CENTRALU-PROBE shell=' + (reg.defaultShell ?? '')]
for (const d of reg.distros ?? []) out.push('CENTRALU-PROBE ' + (d.guid === reg.defaultGuid ? 'wsl-default=' : 'wsl=') + d.name)
// Windows ends lines with CRLF, and PowerShell 5.1 writes its progress as CLIXML on stderr
process.stdout.write(out.join('\r\n') + '\r\n')
process.stderr.write('#< CLIXML\r\n<Objs Version="1.1.0.1"><Obj S="progress"></Obj></Objs>')
`

let dir: string
let log: string
let ssh: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cc-probe-'))
  log = join(dir, 'ssh.log')
  ssh = fakeExe(dir, 'ssh', FAKE_SSH)
})
afterEach(() => rmFakeDir(dir))

const probe = (as: string, registry: unknown = {}, timeoutMs?: number) =>
  probeTarget('ijun1', { ssh, env: { ...process.env, FAKE_SSH_LOG: log, FAKE_AS: as, FAKE_REGISTRY: JSON.stringify(registry) }, ...(timeoutMs ? { timeoutMs } : {}) })
const logged = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))

describe('the probe command', () => {
  it('is one short line of base64 after `powershell`, which cmd.exe, PowerShell and sh all pass on untouched', () => {
    const c = probeCommand()
    expect(c).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/)
    // cmd.exe's line is 8,191 characters (#489); this one has to fit with room to spare
    expect(c.length).toBeLessThan(WINDOWS_INLINE_MAX / 2)
  })

  it('reads the registry only: where OpenSSH keeps its default shell and WSL its distros, nothing run or written', () => {
    const script = Buffer.from(probeCommand().split(' ').pop()!, 'base64').toString('utf16le')
    expect(script).toContain("'HKLM:\\SOFTWARE\\OpenSSH'")
    expect(script).toContain("'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss'")
    expect(script).not.toMatch(/wsl\.exe|Set-|New-|Remove-|Start-|Invoke-|>/i)
  })

  it('goes over BatchMode ssh with the target after --', async () => {
    await probe('posix')
    const args = logged()[0] as string[]
    expect(args.slice(0, 6)).toEqual(['-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--'])
    expect(args[6]).toBe('ijun1')
    expect(args[7]).toBe(probeCommand())
  })

  it('refuses a target that ssh would read as an option, without running ssh', async () => {
    await expect(probeTarget('-oProxyCommand=touch /tmp/x', { ssh, env: { ...process.env, FAKE_SSH_LOG: log } })).rejects.toThrow('Not an ssh target')
    await expect(probeTarget('two words', { ssh, env: { ...process.env, FAKE_SSH_LOG: log } })).rejects.toThrow('Not an ssh target')
    expect(existsSync(log)).toBe(false)
  })
})

describe('what it tells apart', () => {
  it('a POSIX shell: no powershell there, exit 127', async () => {
    expect(await probe('posix')).toEqual({ sshTarget: 'ijun1', reachable: true, os: 'posix', windowsShell: null, wslDistros: [], error: null })
  })

  it("csh's own words for a missing command are a POSIX shell too", async () => {
    expect((await probe('csh')).os).toBe('posix')
  })

  it('Windows with no DefaultShell: cmd.exe, which is what OpenSSH runs then', async () => {
    const r = await probe('windows', { platform: 'Win32NT', defaultShell: '' })
    expect(r).toEqual({ sshTarget: 'ijun1', reachable: true, os: 'windows', windowsShell: 'cmd', wslDistros: [], error: null })
  })

  it.each([
    ['C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', 'powershell'],
    ['"C:\\Program Files\\PowerShell\\7\\pwsh.exe"', 'pwsh'],
    ['C:\\Windows\\System32\\cmd.exe', 'cmd'],
    ['C:\\Program Files\\Git\\bin\\bash.exe', 'other'],
  ])('Windows with DefaultShell %s: %s', async (defaultShell, shell) => {
    expect((await probe('windows', { platform: 'Win32NT', defaultShell })).windowsShell).toBe(shell)
  })

  it('the WSL distros, the default first, without docker-desktop and without a name WSL would not take', async () => {
    const r = await probe('windows', {
      platform: 'Win32NT',
      defaultGuid: '{b}',
      distros: [
        { guid: '{a}', name: 'Debian' },
        { guid: '{d}', name: 'docker-desktop' },
        { guid: '{b}', name: 'Ubuntu' },
        { guid: '{e}', name: 'bad name; rm' },
      ],
    })
    expect(r.wslDistros).toEqual([
      { name: 'Ubuntu', default: true },
      { name: 'Debian', default: false },
    ])
  })

  it('PowerShell on a Unix machine, installed as `powershell`, is a POSIX machine', async () => {
    expect((await probe('windows', { platform: 'Unix' })).os).toBe('posix')
  })

  it("not reached, or a key refused: ssh's own reason, and nothing told", async () => {
    expect(await probe('unreachable')).toEqual({
      sshTarget: 'ijun1',
      reachable: false,
      os: null,
      windowsShell: null,
      wslDistros: [],
      error: 'ijun1: Permission denied (publickey,password,keyboard-interactive).',
    })
  })

  it('an answer it does not recognise: reached, nothing told, what came back said', async () => {
    expect(await probe('odd')).toMatchObject({ reachable: true, os: null, error: 'This account is restricted' })
  })

  /** The probe sent TERM alone: an ssh that ignored it ran on with nobody waiting for it (#428) */
  // A shell script that traps TERM: there is no TERM to ignore on Windows, where the bound ends ssh with TerminateProcess
  it.skipIf(process.platform === 'win32')('an ssh that ignores TERM past its deadline is KILLed', async () => {
    const pidFile = join(dir, 'pid')
    /*
     * An ssh that ignores TERM, as one stuck in a ProxyCommand can. A shell, so TERM is ignored from its first
     * instant: a Node fake on a loaded machine could still be starting when the deadline's TERM came, and die of it
     */
    const stubborn = join(dir, 'ssh-stubborn')
    writeFileSync(stubborn, `#!/bin/sh\ntrap '' TERM\necho $$ > "${pidFile}"\nwhile :; do sleep 1; done\n`)
    chmodSync(stubborn, 0o755)
    const r = await probeTarget('ijun1', { ssh: stubborn, env: process.env, timeoutMs: 2000 })
    expect(r).toMatchObject({ reachable: false, error: 'ssh to ijun1 did not answer in time' })
    const pid = Number(readFileSync(pidFile, 'utf8'))
    const alive = () => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    // The KILL follows the TERM after 2 s (`SSH_KILL_GRACE_MS`)
    for (let i = 0; i < 100 && alive(); i++) await new Promise((res) => setTimeout(res, 50))
    const left = alive()
    if (left) process.kill(pid, 'SIGKILL')
    expect(left).toBe(false)
  }, 20_000)

  it('reads a reason whose character arrives in two pieces as one character (#428)', async () => {
    expect(await probe('split')).toMatchObject({ reachable: true, os: null, error: '접속 거부: 계정이 잠겼습니다' })
  })

  it('an ssh that never answers is ended and reported as not reached', async () => {
    const r = await probe('hang', {}, 500)
    expect(r).toMatchObject({ reachable: false, os: null, error: 'ssh to ijun1 did not answer in time' })
  })

  it("reads the answer measured on a Windows 11 PC (2026-10-12: cmd.exe, WSL Ubuntu and docker-desktop)", () => {
    // The probe's real output over Tailscale, 1.15 s; stderr is PowerShell 5.1 preparing a module on first use
    const run = {
      code: 0,
      stdout: 'CENTRALU-PROBE platform=Win32NT\r\nCENTRALU-PROBE shell=\r\nCENTRALU-PROBE wsl=docker-desktop\r\nCENTRALU-PROBE wsl-default=Ubuntu\r\n',
      stderr: '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"></Obj></Objs>',
    }
    expect(parseProbe('ijun1', run)).toEqual({ sshTarget: 'ijun1', reachable: true, os: 'windows', windowsShell: 'cmd', wslDistros: [{ name: 'Ubuntu', default: true }], error: null })
  })
})
