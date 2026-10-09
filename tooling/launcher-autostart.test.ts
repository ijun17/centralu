import { afterEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AUTOSTART_FILE,
  autostartHow,
  autostartInfo,
  autostartLauncher,
  autostartName,
  connectionLine,
  parseServeArgs,
  parseTaskAnswer,
  runAutostart,
  systemdUnit,
  taskActionScript,
  taskScript,
  // @ts-expect-error — plain .mjs shipped inside the npm shim, no types on purpose
} from '../packaging/npm/centralu/bin/serve.mjs'

/**
 * `centralu serve --autostart on|off|status` (docs/plans/remote-hub.md §10.4, owner decision 4): the boot entry a
 * linked machine's host can be given, per machine, off by default. The unit and task text and every command are
 * checked here; nothing reaches the real systemd or Task Scheduler: the runner is a fake that answers as they would.
 */

type Run = { command: string; args: string[]; env: Record<string, string | undefined> }
type Answer = { code: number | null; stdout: string; stderr: string }

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function home(): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-autostart-'))
  dirs.push(d)
  return d
}

/** A command runner that records what it was asked and answers from `answer` */
function runner(answer: (r: Run) => Partial<Answer> = () => ({})) {
  const runs: Run[] = []
  const run = async (command: string, args: string[], env: Record<string, string | undefined>): Promise<Answer> => {
    const r = { command, args, env }
    runs.push(r)
    return { code: 0, stdout: '', stderr: '', ...answer(r) }
  }
  return { run, runs }
}

/** The JSON line `--autostart` printed */
async function autostart(opts: Record<string, unknown>): Promise<{ code: number; line: Record<string, unknown> }> {
  let out = ''
  const code = (await runAutostart({ write: (l: string) => (out += l), ...opts })) as number
  expect(out.trim().split('\n')).toHaveLength(1)
  return { code, line: JSON.parse(out).autostart }
}

const ps = (cmdArgs: string[]) => Buffer.from(cmdArgs[cmdArgs.indexOf('-EncodedCommand') + 1]!, 'base64').toString('utf16le')
/** The strings a PowerShell script carries as base64 (`psText`), decoded */
const texts = (script: string) => [...script.matchAll(/FromBase64String\('([A-Za-z0-9+/=]*)'\)/g)].map((m) => Buffer.from(m[1]!, 'base64').toString('utf8'))

describe('--autostart arguments', () => {
  it('takes on, off or status, as a separate word or after =', () => {
    expect(parseServeArgs(['--autostart', 'on'])).toEqual({ mode: 'autostart', port: null, autostart: 'on' })
    expect(parseServeArgs(['--autostart=off'])).toEqual({ mode: 'autostart', port: null, autostart: 'off' })
    expect(parseServeArgs(['--autostart', 'status'])).toEqual({ mode: 'autostart', port: null, autostart: 'status' })
  })

  it('refuses anything else, a port, and another command beside it', () => {
    expect(parseServeArgs(['--autostart']).error).toMatch(/--autostart needs on, off or status \(got nothing\)/)
    expect(parseServeArgs(['--autostart', 'yes']).error).toMatch(/needs on, off or status \(got "yes"\)/)
    expect(parseServeArgs(['--autostart', 'on', '--port', '4000']).error).toMatch(/--autostart takes no --port/)
    expect(parseServeArgs(['--stop', '--autostart', 'off']).error).toMatch(/--stop and --autostart are separate commands/)
    expect(parseServeArgs(['--autostart', 'off', '--detach']).error).toMatch(/--autostart and --detach are separate commands/)
  })
})

describe('what a machine starts its host at boot with (plan §10.4)', () => {
  it('a systemd user unit on Linux, a scheduled task on Windows and inside WSL, nothing elsewhere', () => {
    const yes = () => true
    const no = () => false
    expect(autostartHow('linux', {}, { systemd: yes, interop: no })).toBe('systemd')
    expect(autostartHow('win32', {}, { systemd: no, interop: no })).toBe('task')
    // WSL stops a distro with no Windows client, so its unit would never run; the Windows side starts it
    expect(autostartHow('linux', { WSL_DISTRO_NAME: 'Ubuntu' }, { systemd: yes, interop: yes })).toBe('task')
    expect(autostartHow('linux', { WSL_DISTRO_NAME: 'Ubuntu' }, { systemd: yes, interop: no })).toBeNull()
    expect(autostartHow('linux', {}, { systemd: no, interop: no })).toBeNull()
    expect(autostartHow('darwin', {}, { systemd: yes, interop: yes })).toBeNull()
  })

  it('names one entry per data folder, so a second data folder (or a test’s) never replaces the person’s', () => {
    const h = '/home/me'
    expect(autostartName('systemd', { dataDir: '/home/me/.centralu', home: h, env: {} })).toBe('centralu-serve.service')
    expect(autostartName('systemd', { dataDir: '/tmp/x', home: h, env: {} })).toMatch(/^centralu-serve-[0-9a-f]{8}\.service$/)
    expect(autostartName('systemd', { dataDir: '/tmp/x', home: h, env: {} })).not.toBe(autostartName('systemd', { dataDir: '/tmp/y', home: h, env: {} }))
    expect(autostartName('task', { dataDir: 'C:\\Users\\me\\.centralu', home: 'C:\\Users\\me', env: {} })).not.toMatch(/WSL/)
    // One laptop linked as Windows and as a WSL distro gets two tasks
    expect(autostartName('task', { dataDir: '/home/me/.centralu', home: h, env: { WSL_DISTRO_NAME: 'Ubuntu-24.04' } })).toBe('Centralu host (WSL Ubuntu-24.04)')
    expect(() => autostartName('task', { dataDir: '/home/me/.centralu', home: h, env: { WSL_DISTRO_NAME: 'a"b' } })).toThrow(/not a WSL distro name/)
  })

  it('runs the managed launcher when the app installed Centralu there, else the one serve keeps for npm', () => {
    const d = home()
    expect(autostartLauncher(d, 'linux')).toBeNull()
    mkdirSync(join(d, 'bin'))
    writeFileSync(join(d, 'bin', 'centralu'), '')
    expect(autostartLauncher(d, 'linux')).toBe(join(d, 'bin', 'centralu'))
    mkdirSync(join(d, 'remote', 'bin'), { recursive: true })
    writeFileSync(join(d, 'remote', 'bin', 'centralu'), '')
    expect(autostartLauncher(d, 'linux')).toBe(join(d, 'remote', 'bin', 'centralu'))
    writeFileSync(join(d, 'remote', 'bin', 'centralu.cmd'), '')
    expect(autostartLauncher(d, 'win32')).toBe(join(d, 'remote', 'bin', 'centralu.cmd'))
  })
})

describe('the systemd user unit', () => {
  it('runs serve in the foreground, stops it through the launcher, and restarts a crash a bounded number of times', () => {
    const unit = systemdUnit({ launcher: '/home/me/.centralu/remote/bin/centralu', env: {} })
    expect(unit).toContain('ExecStart="/home/me/.centralu/remote/bin/centralu" serve\n')
    expect(unit).toContain('KillMode=mixed\n')
    expect(unit).toContain('Restart=on-failure\n')
    expect(unit).toContain('StartLimitBurst=5\n')
    expect(unit).toContain('[Install]\nWantedBy=default.target\n')
    expect(unit).not.toContain('Environment=')
  })

  it('carries a data folder of its own, and quotes what systemd would otherwise expand', () => {
    const unit = systemdUnit({ launcher: '/srv/a b/$x/100%/centralu', env: { CC_DATA_DIR: '/srv/a b/100%', HOME: '/home/me', PATH: '/bin' } })
    expect(unit).toContain('Environment="CC_DATA_DIR=/srv/a b/100%%"\n')
    expect(unit).toContain('ExecStart="/srv/a b/$$x/100%%/centralu" serve\n')
    // Only what the entry needs: not the ssh session's PATH or HOME
    expect(unit).not.toMatch(/PATH|HOME/)
    expect(() => systemdUnit({ launcher: '/a\nExecStartPre=/bin/rm', env: {} })).toThrow(/cannot put/)
  })
})

describe('the Windows scheduled task (and WSL’s)', () => {
  it('runs the launcher’s serve on Windows, with the data folder set, every value as base64', () => {
    const s = taskActionScript({ how: 'wmi', launcher: 'C:\\Users\\me\\.centralu\\remote\\bin\\centralu.cmd', env: { CC_DATA_DIR: "D:\\it's data" } })
    expect(s).toMatch(/^\$env:CC_DATA_DIR = \(\[Text\.Encoding\]/)
    expect(s).toMatch(/\n& \(\[Text\.Encoding\]::UTF8\.GetString\(\[Convert\]::FromBase64String\('[A-Za-z0-9+/=]+'\)\)\) serve$/)
    expect(texts(s)).toEqual(["D:\\it's data", 'C:\\Users\\me\\.centralu\\remote\\bin\\centralu.cmd'])
    expect(s).not.toContain("it's")
  })

  it('in WSL, starts the distro’s launcher through wsl.exe, which holds the distro while the host runs', () => {
    const s = taskActionScript({ how: 'wsl', launcher: '/home/me/.centralu/remote/bin/centralu', env: { CC_DATA_DIR: '/data dir' }, distro: 'Ubuntu-24.04', user: 'me' })
    expect(s).toContain("& (Join-Path $env:SystemRoot 'System32\\wsl.exe') @a")
    expect(texts(s)).toEqual(['-d', 'Ubuntu-24.04', '-u', 'me', '--cd', '~', '--exec', '/usr/bin/env', 'CC_DATA_DIR=/data dir', '/home/me/.centralu/remote/bin/centralu', 'serve'])
    expect(() => taskActionScript({ how: 'wsl', launcher: '/x', env: {}, distro: 'a b', user: 'me' })).toThrow(/not a WSL distro name/)
    expect(() => taskActionScript({ how: 'wsl', launcher: '/x', env: {}, distro: 'Ubuntu', user: 'me;rm' })).toThrow(/cannot name the user/)
  })

  it('registers a task for this user at their sign-in, hidden, on battery too, with no time limit', () => {
    const run = taskActionScript({ how: 'wmi', launcher: 'C:\\c.cmd', env: {} })
    const s = taskScript('on', { name: 'Centralu host', run })
    expect(s).toContain('New-ScheduledTaskTrigger -AtLogOn -User $user')
    expect(s).toContain('-LogonType Interactive -RunLevel Limited')
    expect(s).toContain('-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)')
    expect(s).toContain("Register-ScheduledTask -TaskName $name -TaskPath '\\'")
    // What it runs is the action script itself, through PowerShell's own encoding
    const encoded = /-WindowStyle Hidden -EncodedCommand ([A-Za-z0-9+/=]+)'/.exec(s)?.[1]
    expect(Buffer.from(encoded!, 'base64').toString('utf16le')).toBe(run)
    expect(texts(s)[0]).toBe('Centralu host')
    expect(taskScript('off', { name: 'Centralu host' })).toContain("Unregister-ScheduledTask -TaskName $name -TaskPath '\\' -Confirm:$false")
    expect(taskScript('status', { name: 'Centralu host' })).toContain("'CENTRALU-AUTOSTART state none'")
  })

  it('reads what the task script printed', () => {
    expect(parseTaskAnswer('CENTRALU-AUTOSTART on\r\n')).toEqual({ ok: true, word: 'on' })
    expect(parseTaskAnswer('CENTRALU-AUTOSTART state Ready\r\n')).toEqual({ ok: true, word: 'Ready' })
    expect(parseTaskAnswer('CENTRALU-AUTOSTART-ERROR Access is denied. \r\n')).toEqual({ ok: false, message: 'Access is denied.' })
    expect(parseTaskAnswer('')).toEqual({ ok: false, message: 'PowerShell did not answer' })
  })
})

describe('centralu serve --autostart, with a fake systemctl and loginctl', () => {
  const user = 'me'

  /** systemd as a fake: `is-enabled` follows `enable` / `disable`, lingering as given */
  function systemd(o: { linger?: 'yes' | 'no'; lingerAllowed?: boolean; enableFails?: boolean } = {}) {
    let enabled = false
    let linger = o.linger ?? 'yes'
    return runner(({ command, args }) => {
      if (command === 'systemctl') {
        const verb = args[1]
        if (verb === 'enable') {
          if (o.enableFails) return { code: 1, stderr: 'Failed to connect to bus: No medium found' }
          enabled = true
        }
        if (verb === 'disable') enabled = false
        if (verb === 'is-enabled') return { code: enabled ? 0 : 1, stdout: enabled ? 'enabled\n' : 'disabled\n' }
        return {}
      }
      if (command === 'loginctl') {
        if (args[0] === 'show-user') return { stdout: `${linger}\n` }
        if (args.includes('enable-linger') && o.lingerAllowed) linger = 'yes'
        return o.lingerAllowed ? {} : { code: 1, stderr: 'Access denied' }
      }
      return { code: 127, stderr: `${command}: not found` }
    })
  }

  function machine() {
    const h = home()
    const dataDir = join(h, '.centralu')
    mkdirSync(join(dataDir, 'remote', 'bin'), { recursive: true })
    writeFileSync(join(dataDir, 'remote', 'bin', 'centralu'), '#!/bin/sh\n')
    const unit = join(h, '.config', 'systemd', 'user', 'centralu-serve.service')
    return { h, dataDir, unit, base: { env: {}, home: h, platform: 'linux', how: 'systemd', user, cliPath: null } }
  }

  it('on: writes the unit, enables it, asks for lingering, and the connection line says so', async () => {
    const m = machine()
    const s = systemd({ linger: 'no', lingerAllowed: true })
    const r = await autostart({ ...m.base, action: 'on', run: s.run })
    expect(r).toEqual({ code: 0, line: { ok: true, how: 'systemd', on: true, linger: true } })
    expect(readFileSync(m.unit, 'utf8')).toContain(`ExecStart="${join(m.dataDir, 'remote', 'bin', 'centralu')}" serve`)
    expect(s.runs.map((x) => [x.command, ...x.args].join(' '))).toEqual([
      'systemctl --user daemon-reload',
      'systemctl --user enable centralu-serve.service',
      'loginctl show-user me --property=Linger --value',
      'loginctl --no-ask-password enable-linger me',
      'loginctl show-user me --property=Linger --value',
    ])
    // Never --now: a host the link started runs already, and a second serve would only fail and be restarted
    expect(s.runs.some((x) => x.args.includes('--now') || x.args.includes('start'))).toBe(false)
    expect(autostartInfo(m.dataDir, 'linux', {}, 'systemd')).toEqual({ on: true, how: 'systemd', linger: true })
    expect(JSON.parse(connectionLine({ port: 1, token: 't', version: 'v', protocolVersion: 1, dataDir: m.dataDir, hostRunning: true, autostart: autostartInfo(m.dataDir, 'linux', {}, 'systemd') })).autostart).toEqual({ on: true, how: 'systemd', linger: true })
  })

  it('on, where lingering needs an administrator: on at login, and it says what to run', async () => {
    const m = machine()
    const r = await autostart({ ...m.base, action: 'on', run: systemd({ linger: 'no', lingerAllowed: false }).run })
    expect(r.code).toBe(0)
    expect(r.line).toMatchObject({ ok: true, on: true, linger: false, message: expect.stringMatching(/when me logs in, not at boot, until an administrator runs `sudo loginctl enable-linger me`/) })
    expect(autostartInfo(m.dataDir, 'linux', {}, 'systemd')).toEqual({ on: true, how: 'systemd', linger: false })
  })

  it('on, when systemd refuses: no unit is left behind and nothing says it is on', async () => {
    const m = machine()
    const r = await autostart({ ...m.base, action: 'on', run: systemd({ enableFails: true }).run })
    expect(r).toEqual({ code: 1, line: { ok: false, how: 'systemd', on: false, linger: null, message: 'systemd did not take the unit: Failed to connect to bus: No medium found' } })
    expect(existsSync(m.unit)).toBe(false)
    expect(existsSync(join(m.dataDir, AUTOSTART_FILE))).toBe(false)
  })

  it('status asks systemd, and corrects the mark when the unit was removed by hand', async () => {
    const m = machine()
    const s = systemd()
    await autostart({ ...m.base, action: 'on', run: s.run })
    expect((await autostart({ ...m.base, action: 'status', run: s.run })).line).toEqual({ ok: true, how: 'systemd', on: true, linger: true })
    rmSync(m.unit)
    expect((await autostart({ ...m.base, action: 'status', run: s.run })).line).toEqual({ ok: true, how: 'systemd', on: false, linger: null })
    expect(autostartInfo(m.dataDir, 'linux', {}, 'systemd').on).toBe(false)
  })

  it('off disables and removes the unit and the mark, and leaves lingering as it was', async () => {
    const m = machine()
    const s = systemd()
    await autostart({ ...m.base, action: 'on', run: s.run })
    s.runs.length = 0
    expect(await autostart({ ...m.base, action: 'off', run: s.run })).toEqual({ code: 0, line: { ok: true, how: 'systemd', on: false, linger: null } })
    expect(existsSync(m.unit)).toBe(false)
    expect(existsSync(join(m.dataDir, AUTOSTART_FILE))).toBe(false)
    expect(s.runs.map((x) => [x.command, ...x.args].join(' '))).toEqual(['systemctl --user disable centralu-serve.service', 'systemctl --user daemon-reload'])
    // Off again: nothing there, nothing asked
    s.runs.length = 0
    expect((await autostart({ ...m.base, action: 'off', run: s.run })).line).toMatchObject({ ok: true, on: false })
    expect(s.runs).toEqual([])
  })

  it('a data folder of its own gets a unit of its own, which carries it', async () => {
    const m = machine()
    const other = join(m.h, 'elsewhere')
    mkdirSync(join(other, 'bin'), { recursive: true })
    writeFileSync(join(other, 'bin', 'centralu'), '')
    const s = systemd()
    await autostart({ ...m.base, env: { CC_DATA_DIR: other }, action: 'on', run: s.run })
    expect(existsSync(m.unit)).toBe(false)
    const name = autostartName('systemd', { dataDir: other, home: m.h, env: {} })
    expect(readFileSync(join(m.h, '.config', 'systemd', 'user', name), 'utf8')).toContain(`Environment="CC_DATA_DIR=${other}"`)
  })

  it('says why where there is nothing to start it with, and turning it off there succeeds', async () => {
    const h = home()
    const r = await autostart({ env: {}, home: h, platform: 'darwin', how: null, action: 'on', run: runner().run, user, cliPath: null })
    expect(r).toEqual({ code: 1, line: { ok: false, on: false, how: null, linger: null, message: expect.stringMatching(/offered on Linux and Windows; on macOS/) } })
    expect((await autostart({ env: {}, home: h, platform: 'darwin', how: null, action: 'status', run: runner().run, user, cliPath: null })).code).toBe(0)
    expect((await autostart({ env: {}, home: h, platform: 'darwin', how: null, action: 'off', run: runner().run, user, cliPath: null })).line).toEqual({ ok: true, on: false, how: null, linger: null })
  })
})

describe('centralu serve --autostart on Windows, with a fake PowerShell', () => {
  function windows(answer: (script: string) => Partial<Answer>) {
    const h = home()
    const dataDir = join(h, '.centralu')
    mkdirSync(join(dataDir, 'remote', 'bin'), { recursive: true })
    writeFileSync(join(dataDir, 'remote', 'bin', 'centralu.cmd'), '')
    const r = runner(({ args }) => answer(ps(args)))
    return { dataDir, r, base: { env: { SystemRoot: 'C:\\Windows' }, home: h, platform: 'win32', how: 'task', user: 'me', cliPath: null, run: r.run } }
  }

  it('on registers the task through Windows PowerShell by full path; status and off follow Task Scheduler', async () => {
    let state = 'none'
    const w = windows((s) => {
      if (s.includes('Register-ScheduledTask')) {
        state = 'Ready'
        return { stdout: 'CENTRALU-AUTOSTART on\r\n' }
      }
      if (s.includes('Unregister-ScheduledTask')) {
        state = 'none'
        return { stdout: 'CENTRALU-AUTOSTART off\r\n' }
      }
      return { stdout: `CENTRALU-AUTOSTART state ${state}\r\n` }
    })
    expect(await autostart({ ...w.base, action: 'on' })).toEqual({ code: 0, line: { ok: true, how: 'task', on: true, linger: null } })
    expect(w.r.runs[0]!.command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(w.r.runs[0]!.args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand'])
    // The task runs this data folder's managed launcher
    const action = Buffer.from(/-EncodedCommand ([A-Za-z0-9+/=]+)'/.exec(ps(w.r.runs[0]!.args))![1]!, 'base64').toString('utf16le')
    expect(texts(action)).toEqual([join(w.dataDir, 'remote', 'bin', 'centralu.cmd')])
    expect(autostartInfo(w.dataDir, 'win32', {}, 'task')).toEqual({ on: true, how: 'task', linger: null })
    expect((await autostart({ ...w.base, action: 'status' })).line).toMatchObject({ ok: true, on: true })
    expect((await autostart({ ...w.base, action: 'off' })).line).toEqual({ ok: true, how: 'task', on: false, linger: null })
    expect(autostartInfo(w.dataDir, 'win32', {}, 'task').on).toBe(false)
  })

  it('a refusal is said as Task Scheduler said it, and a disabled task counts as off', async () => {
    const w = windows((s) => (s.includes('Register-') ? { stdout: 'CENTRALU-AUTOSTART-ERROR Access is denied.\r\n' } : { stdout: 'CENTRALU-AUTOSTART state Disabled\r\n' }))
    expect(await autostart({ ...w.base, action: 'on' })).toEqual({ code: 1, line: { ok: false, how: 'task', on: false, linger: null, message: 'Task Scheduler did not take the task: Access is denied.' } })
    expect(existsSync(join(w.dataDir, AUTOSTART_FILE))).toBe(false)
    expect((await autostart({ ...w.base, action: 'status' })).line).toMatchObject({ ok: true, on: false })
  })

  it('inside WSL with no way to Windows PowerShell, it says so instead of writing anything', async () => {
    const h = home()
    const r = await autostart({ env: { WSL_DISTRO_NAME: 'Ubuntu' }, home: h, platform: 'linux', how: 'task', interop: () => true, user: 'me', cliPath: null, action: 'on', run: runner().run })
    // This machine has no Windows drive mounted, which is what the lookup reads
    expect(r.line).toMatchObject({ ok: false, how: 'task', message: 'Windows PowerShell is not reachable from this WSL distro' })
  })
})
