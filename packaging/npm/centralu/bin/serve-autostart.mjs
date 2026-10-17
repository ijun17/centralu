/**
 * `centralu serve --autostart on|off|status`: a `systemd --user` unit on Linux, a scheduled task at
 * sign-in on Windows and for WSL, and the mark in the data folder that `--connection` reports.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join, posix } from 'node:path'
import { answerLine, replaceFile, runCaptured } from './serve-util.mjs'
import { serveDataDir } from './serve-files.mjs'
import { askPowershell, detachHow, encodedCommand, wslInterop, PS_MODULE_PATH, windowsArg, windowsPowershell, psText, wslDistro, wslUser } from './serve-windows.mjs'
import { keepLauncher, remoteLayout } from './serve-install.mjs'

/**
 * What `--autostart on` records in the data folder: the entry it wrote, so `--connection` can say
 * whether this machine starts its host at boot without asking systemd or Task Scheduler at every
 * link start. `--autostart status` asks them, and corrects this file when it disagrees.
 */
export const AUTOSTART_FILE = 'autostart.json'

/** The variables the entry carries to the serve it starts: the data folder, and a host entry (development) */
export const AUTOSTART_ENV = ['CC_DATA_DIR', 'CENTRALU_HOST_ENTRY']

/**
 * How this machine would start `serve` at boot (docs/plans/remote-hub.md §10.4, owner decision 4),
 * or null where it offers none:
 *
 *   systemd  Linux: a `systemd --user` unit, enabled for `default.target`, plus lingering so the
 *            user's manager starts at boot rather than at the first login
 *   task     Windows: a per-user scheduled task at sign-in (no administrator needed). Also inside
 *            WSL: nothing in a stopped distro runs, so the Windows side has to start it, through
 *            `wsl.exe`, which then holds the distro for as long as the host runs
 *
 * WSL with interop off has no way to the Windows side, and a Linux without systemd (or macOS) has
 * no user unit; those say so instead.
 */
export function autostartHow(platform, env, { interop = wslInterop, systemd = () => existsSync('/run/systemd/system') } = {}) {
  if (platform === 'win32') return 'task'
  if (platform !== 'linux') return null
  if (env.WSL_DISTRO_NAME) return interop() ? 'task' : null
  return systemd() ? 'systemd' : null
}

/** Why `autostartHow` found nothing, in one sentence */
export function autostartUnsupported(platform, env) {
  if (platform === 'linux' && env.WSL_DISTRO_NAME) {
    return 'Starting Centralu with WSL needs a Windows scheduled task, and this distro cannot run Windows programs (WSL interop is off)'
  }
  if (platform === 'linux') return 'This Linux does not run systemd, so there is no user unit to start Centralu at boot; start `centralu serve` from your own init system'
  return `Starting Centralu at boot is offered on Linux and Windows; on ${platform === 'darwin' ? 'macOS' : platform}, run \`centralu serve --detach\` from a login item or launchd agent of your own`
}

/**
 * A folder path as a comparable key on `platform`: either separator as `/`, `.` and `..` folded, no
 * trailing separator, and lower case on Windows, whose paths do not differ by case
 */
export function pathKey(p, platform) {
  let s = posix.normalize(String(p).replaceAll('\\', '/'))
  if (s.length > 1) s = s.replace(/\/+$/, '')
  return platform === 'win32' ? s.toLowerCase() : s
}

/**
 * The entry's name. One per data folder: the default one gets the plain name, any other (a second
 * install, a test's temporary folder) a suffix from its path, so they never replace each other. A
 * Windows laptop linked twice, as Windows and as a WSL distro, gets two tasks.
 *
 * Whether `dataDir` is the default is read the same way whatever OS runs this (`pathKey`), not with
 * this Node's `join`: the folder may be written with either separator (`CC_DATA_DIR=C:/x` on Windows),
 * and Windows paths do not differ by case, so `C:\Users\Me\.centralu` is the default folder too.
 */
export function autostartName(how, { dataDir, home, env, platform = process.platform }) {
  const key = pathKey(dataDir, platform)
  const own = key === pathKey(`${home}/.centralu`, platform) ? '' : createHash('sha256').update(key).digest('hex').slice(0, 8)
  if (how === 'systemd') return `centralu-serve${own ? `-${own}` : ''}.service`
  const distro = env.WSL_DISTRO_NAME && wslDistro(env.WSL_DISTRO_NAME)
  return `Centralu host${distro ? ` (WSL ${distro})` : ''}${own ? ` ${own}` : ''}`
}

/**
 * What the entry runs: the managed launcher when the app installed Centralu here over ssh (its text
 * never changes and it reads `current`, so an update needs no new entry), else the launcher `serve`
 * keeps for an npm install. The order is the hub's lookup (`connectionCommand` in links/tunnel.ts).
 */
export function autostartLauncher(dataDir, platform, exists = existsSync) {
  const file = platform === 'win32' ? 'centralu.cmd' : 'centralu'
  for (const p of [join(remoteLayout(dataDir).bin, file), join(dataDir, 'bin', file)]) if (exists(p)) return p
  return null
}

/** One value for a unit file, double-quoted; `$` doubled where systemd would expand it (ExecStart) */
function systemdQuote(value, { dollars = false } = {}) {
  const s = String(value)
  if (/[\r\n\0]/.test(s)) throw new Error(`cannot put ${JSON.stringify(s)} in a systemd unit`)
  let q = s.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')
  if (dollars) q = q.replaceAll('$', '$$$$')
  return `"${q}"`
}

/**
 * The `systemd --user` unit (docs/agent-host.md §4.7 has the hand-written one this follows).
 *
 * - `serve` in the foreground: systemd is what keeps it outside any session.
 * - `KillMode=mixed`: a stop sends SIGTERM to the launcher only, which passes one to the host, which
 *   stops its agents in order; the rest of the group is killed only after `TimeoutStopSec`.
 * - `Restart=on-failure`, but bounded: a host that fails at every start (a port another program
 *   holds, a store from a newer build) is left failed after five tries in five minutes rather than
 *   started forever. A clean stop (`serve --stop`, as an update does) exits 0 and stays stopped.
 */
export function systemdUnit({ launcher, env }) {
  return [
    '# Written by `centralu serve --autostart on`; `centralu serve --autostart off` removes it.',
    '[Unit]',
    'Description=Centralu host (centralu serve)',
    'StartLimitIntervalSec=300',
    'StartLimitBurst=5',
    '',
    '[Service]',
    'Type=simple',
    ...AUTOSTART_ENV.filter((k) => env[k]).map((k) => `Environment=${systemdQuote(`${k}=${env[k]}`)}`),
    `ExecStart=${systemdQuote(launcher, { dollars: true })} serve`,
    'KillMode=mixed',
    'TimeoutStopSec=30',
    'Restart=on-failure',
    'RestartSec=10',
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n')
}

/**
 * The PowerShell the scheduled task runs at sign-in, in a hidden window: `serve` in the foreground,
 * for as long as it runs. Not `--detach`: a task is not an ssh session, so nothing ends it with one,
 * and it needs no WMI, which some machines block (decision 3).
 *
 *   Windows  the launcher itself
 *   WSL      `wsl.exe -d <distro> -u <user> --exec <launcher> serve`: that `wsl.exe` is a client of
 *            the distro for as long as the host runs, so WSL does not stop it (§10.4)
 *
 * The variables of `AUTOSTART_ENV` are set in the task (Windows) or passed through `env` (WSL, where
 * the Windows side's environment does not reach the distro).
 */
export function taskActionScript({ how, launcher, env, distro = null, user = null }) {
  const carried = AUTOSTART_ENV.filter((k) => env[k])
  if (how === 'wmi') return [...carried.map((k) => `$env:${k} = ${psText(env[k])}`), `& ${psText(launcher)} serve`].join('\n')
  const args = ['-d', wslDistro(distro), '-u', wslUser(user), '--cd', '~', '--exec', ...(carried.length ? ['/usr/bin/env', ...carried.map((k) => `${k}=${env[k]}`)] : []), launcher, 'serve']
  // PowerShell writes the command line itself; what windowsArg could not quote, it would not either
  for (const a of args) windowsArg(a)
  return [`$a = @(${args.map(psText).join(', ')})`, "& (Join-Path $env:SystemRoot 'System32\\wsl.exe') @a"].join('\n')
}

const TASK_WORD = 'CENTRALU-AUTOSTART'

/**
 * The PowerShell that registers, removes or reads the scheduled task, printing one `CENTRALU-AUTOSTART`
 * line. Registered for this user only, at this user's sign-in, run only while they are signed in
 * (`Interactive`): the kind of task a user may create without an administrator. On a laptop, it runs
 * on battery too, and with no time limit (the default ends a task after 72 hours).
 */
export function taskScript(action, { name, run = '' }) {
  const head = ["$ErrorActionPreference = 'Stop'", PS_MODULE_PATH, '[Console]::OutputEncoding = [Text.Encoding]::UTF8', `$name = ${psText(name)}`]
  const fail = `} catch { "${TASK_WORD}-ERROR $($_.Exception.Message -replace '\\s+', ' ')" }`
  const find = "$t = Get-ScheduledTask -TaskName $name -TaskPath '\\' -ErrorAction SilentlyContinue"
  if (action === 'status') return [...head, 'try {', `  ${find}`, `  if ($t) { "${TASK_WORD} state $($t.State)" } else { '${TASK_WORD} state none' }`, fail].join('\n')
  if (action === 'off') {
    return [...head, 'try {', `  ${find}`, "  if ($t) { Unregister-ScheduledTask -TaskName $name -TaskPath '\\' -Confirm:$false }", `  '${TASK_WORD} off'`, fail].join('\n')
  }
  const encoded = encodedCommand(run)
  return [
    ...head,
    'try {',
    "  $exe = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    `  $arg = '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}'`,
    '  $user = if ($env:USERDOMAIN) { "$env:USERDOMAIN\\$env:USERNAME" } else { $env:USERNAME }',
    '  $a = New-ScheduledTaskAction -Execute $exe -Argument $arg',
    '  $tr = New-ScheduledTaskTrigger -AtLogOn -User $user',
    '  $p = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited',
    '  $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew',
    `  Register-ScheduledTask -TaskName $name -TaskPath '\\' -Action $a -Trigger $tr -Principal $p -Settings $s -Description ${psText('Starts the Centralu host (centralu serve) when you sign in. Written by centralu serve --autostart on.')} -Force | Out-Null`,
    `  '${TASK_WORD} on'`,
    fail,
  ].join('\n')
}

/** What a task script printed: `{ ok: true, word }` (`on`, `off`, or the state after `state`) or `{ ok: false, message }` */
export function parseTaskAnswer(stdout) {
  const text = String(stdout ?? '')
  const e = new RegExp(`${TASK_WORD}-ERROR (.*)`).exec(text)
  if (e) return { ok: false, message: e[1].trim() }
  const m = new RegExp(`${TASK_WORD} (?:state )?(\\S+)`).exec(text)
  if (m) return { ok: true, word: m[1] }
  return { ok: false, message: 'PowerShell did not answer' }
}

/** `{ how, name, linger }` from `AUTOSTART_FILE`, or null */
export function readAutostartMark(dataDir) {
  try {
    const v = JSON.parse(readFileSync(join(dataDir, AUTOSTART_FILE), 'utf8'))
    if ((v?.how !== 'systemd' && v?.how !== 'task') || typeof v.name !== 'string') return null
    return { how: v.how, name: v.name, linger: typeof v.linger === 'boolean' ? v.linger : null }
  } catch {
    return null
  }
}

function writeAutostartMark(dataDir, mark) {
  mkdirSync(dataDir, { recursive: true })
  const file = join(dataDir, AUTOSTART_FILE)
  replaceFile(file, `${JSON.stringify({ v: 1, ...mark, at: Date.now() })}\n`)
}

function clearAutostartMark(dataDir) {
  rmSync(join(dataDir, AUTOSTART_FILE), { force: true })
}

/**
 * The connection line's `autostart` field (additive): `{ on, how, linger }`. `how` is what this
 * machine would use (null where it offers nothing), `on` whether `--autostart on` wrote an entry of
 * that kind, `linger` (systemd only) whether the user's manager starts at boot. From the mark only:
 * this runs at every link start.
 */
export function autostartInfo(dataDir, platform, env, how = autostartHow(platform, env)) {
  const mark = readAutostartMark(dataDir)
  const on = how !== null && mark?.how === how
  return { on, how, linger: on && how === 'systemd' ? mark.linger : null }
}

/** The sentence for a user manager that starts only at login (`loginctl enable-linger` refused) */
export function lingerMessage(user) {
  return `systemd starts it when ${user} logs in, not at boot, until an administrator runs \`sudo loginctl enable-linger ${user}\` there`
}

/** systemctl --user over ssh needs the user's runtime folder; a session without pam_systemd may not name it */
function userManagerEnv(env) {
  if (env.XDG_RUNTIME_DIR || typeof process.getuid !== 'function') return env
  const dir = `/run/user/${process.getuid()}`
  return existsSync(dir) ? { ...env, XDG_RUNTIME_DIR: dir } : env
}

async function systemdAutostart(action, { dataDir, env, home, name, run, user }) {
  const dir = join(env.XDG_CONFIG_HOME || join(home, '.config'), 'systemd', 'user')
  const file = join(dir, name)
  const ctlEnv = userManagerEnv(env)
  const ctl = (...args) => run('systemctl', ['--user', ...args], ctlEnv)
  const lingers = async () => {
    const r = await run('loginctl', ['show-user', user, '--property=Linger', '--value'], ctlEnv)
    return r.code === 0 ? r.stdout.trim() === 'yes' : null
  }
  const base = { ok: true, how: 'systemd' }
  if (action === 'status') {
    const on = existsSync(file) && (await ctl('is-enabled', name)).stdout.trim() === 'enabled'
    const linger = on ? await lingers() : null
    if (on) writeAutostartMark(dataDir, { how: 'systemd', name, linger })
    else clearAutostartMark(dataDir)
    return { ...base, on, linger }
  }
  if (action === 'off') {
    if (existsSync(file)) {
      await ctl('disable', name)
      rmSync(file, { force: true })
      // Left by an `enable` whose `disable` did not reach the manager; harmless, but not ours to leave
      rmSync(join(dir, 'default.target.wants', name), { force: true })
      await ctl('daemon-reload')
    }
    clearAutostartMark(dataDir)
    return { ...base, on: false, linger: null }
  }
  const launcher = autostartLauncher(dataDir, 'linux')
  if (!launcher) return { ...base, ok: false, on: false, linger: null, message: `there is no Centralu launcher in ${dataDir} to start at boot` }
  mkdirSync(dir, { recursive: true })
  replaceFile(file, systemdUnit({ launcher, env }))
  let r = await ctl('daemon-reload')
  if (r.code === 0) r = await ctl('enable', name)
  if (r.code !== 0) {
    rmSync(file, { force: true })
    await ctl('daemon-reload')
    clearAutostartMark(dataDir)
    const why = String(r.stderr).trim().split(/\r?\n/).at(-1) || `exit ${r.code}`
    return { ...base, ok: false, on: false, linger: null, message: `systemd did not take the unit: ${why}` }
  }
  let linger = await lingers()
  if (linger === false) {
    await run('loginctl', ['--no-ask-password', 'enable-linger', user], ctlEnv)
    linger = await lingers()
  }
  writeAutostartMark(dataDir, { how: 'systemd', name, linger })
  return { ...base, on: true, linger, ...(linger === true ? {} : { message: lingerMessage(user) }) }
}

async function taskAutostart(action, { dataDir, env, name, run, user, platform, interop }) {
  const detach = detachHow(platform, env, interop)
  const ps = windowsPowershell(detach, env)
  const base = { ok: true, how: 'task', linger: null }
  if (!ps) return { ...base, ok: false, on: false, message: 'Windows PowerShell is not reachable from this WSL distro' }
  const ask = (script) => askPowershell(ps, script, env, parseTaskAnswer, run)
  if (action === 'status') {
    const a = await ask(taskScript('status', { name }))
    if (!a.ok) return { ...base, ok: false, on: readAutostartMark(dataDir)?.how === 'task', message: `Task Scheduler did not answer: ${a.message}` }
    const on = a.word !== 'none' && a.word !== 'Disabled'
    if (on) writeAutostartMark(dataDir, { how: 'task', name, linger: null })
    else clearAutostartMark(dataDir)
    return { ...base, on }
  }
  if (action === 'off') {
    const a = await ask(taskScript('off', { name }))
    if (!a.ok) return { ...base, ok: false, on: true, message: `Task Scheduler did not remove the task "${name}": ${a.message}` }
    clearAutostartMark(dataDir)
    return { ...base, on: false }
  }
  const launcher = autostartLauncher(dataDir, platform)
  if (!launcher) return { ...base, ok: false, on: false, message: `there is no Centralu launcher in ${dataDir} to start at sign-in` }
  const runScript = taskActionScript({ how: detach, launcher, env, distro: env.WSL_DISTRO_NAME ?? null, user })
  const a = await ask(taskScript('on', { name, run: runScript }))
  if (!a.ok) return { ...base, ok: false, on: false, message: `Task Scheduler did not take the task: ${a.message}` }
  writeAutostartMark(dataDir, { how: 'task', name, linger: null })
  return { ...base, on: true }
}

/**
 * `centralu serve --autostart on|off|status` (docs/plans/remote-hub.md §10.4, owner decision 4: per
 * machine, off by default). The hub runs it over ssh for the Settings → Machines toggle, and its
 * uninstall runs `off`. Turning it on or off never starts or stops a host: one runs already when the
 * hub asks (the link started it), and the entry is for the next boot.
 *
 * stdout: one line, `{ v: 1, autostart: { ok, on, how, linger, message? } }`; `how` null where this
 * machine offers nothing (`autostartHow`). `run` (a command runner) and `how` are parameters so
 * tests never reach the real systemd or Task Scheduler.
 */
export async function runAutostart({
  env,
  home,
  action,
  cliPath,
  platform = process.platform,
  interop = wslInterop,
  how = autostartHow(platform, env, { interop }),
  run = runCaptured,
  user = userInfo().username,
  write = (line) => process.stdout.write(line),
}) {
  const dataDir = serveDataDir(env, home)
  // The entry of an npm install runs the launcher serve keeps; make sure it is there and current
  keepLauncher(dataDir, cliPath, env)
  const report = (a) => answerLine(write, 'autostart', a)
  if (how === null) {
    clearAutostartMark(dataDir)
    return report({ ok: action !== 'on', on: false, how: null, linger: null, ...(action === 'off' ? {} : { message: autostartUnsupported(platform, env) }) })
  }
  try {
    const name = autostartName(how, { dataDir, home, env, platform })
    const opts = { dataDir, env, home, name, run, user, platform, interop }
    return report(how === 'systemd' ? await systemdAutostart(action, opts) : await taskAutostart(action, opts))
  } catch (e) {
    return report({ ok: false, on: readAutostartMark(dataDir)?.how === how, how, linger: null, message: e?.message ?? String(e) })
  }
}
