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
export function autostartName(how, { dataDir, home, env, platform = process.platform, user = null }) {
  const key = pathKey(dataDir, platform)
  const own = key === pathKey(`${home}/.centralu`, platform) ? '' : createHash('sha256').update(key).digest('hex').slice(0, 8)
  if (how === 'systemd') return `centralu-serve${own ? `-${own}` : ''}.service`
  const distro = env.WSL_DISTRO_NAME && wslDistro(env.WSL_DISTRO_NAME)
  /*
   * The user too (#1224 review): tasks in Task Scheduler's root folder are one list for every account, and an
   * administrator's ssh logon sees the others'. Without it, a second account's `--detach` on a shared PC would find and
   * start the first account's task. Characters a task name cannot hold become `-`
   */
  const who = user ? ` (${String(user).replace(/[\\/:*?"<>|]/g, '-')})` : ''
  return `Centralu host${who}${distro ? ` (WSL ${distro})` : ''}${own ? ` ${own}` : ''}`
}

/** The task's name before the user was part of it: an earlier version's entry, removed when this user's (`taskScript`) */
export function legacyTaskName({ dataDir, home, env, platform = process.platform }) {
  return autostartName('task', { dataDir, home, env, platform })
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
 * The PowerShell that registers, changes, removes or reads the scheduled task, printing one `CENTRALU-AUTOSTART` line.
 * Registered for this user only, run only while they are signed in (`Interactive`, `Limited`): the kind of task a user
 * may create without an administrator. On a laptop, it runs on battery too, and with no time limit (the default ends a
 * task after 72 hours).
 *
 *   on      the task with an `AtLogOn` trigger: the host starts at sign-in
 *   off     the same task without its trigger (#1224): kept for `serve --detach`, which starts the host in the
 *           person's sign-in through it; a task without a trigger reads as autostart off (`status` says `notrigger`)
 *   remove  the task gone (uninstall)
 *   status  `state none`, `state notrigger` or the task's state
 *   signin  `serve --detach`'s start (#1224): when this user has a desktop, the task is checked and started. It is
 *           registered (without a trigger) when missing, and registered again when its action or its principal is not
 *           what this serve would write (a launcher that moved, another install's data folder, a task some other
 *           account wrote under this name): Start-ScheduledTask would otherwise run something else, or as someone else.
 *           A trigger is kept only on a task that was this user's own
 *
 * A task whose principal is `Interactive` runs in that user's session with their sign-in's token, also when
 * Start-ScheduledTask is called from an ssh session. Measured on a linked Windows 11 PC (2026-10-19): a task started
 * that way from the hub's ssh logon ran in session 1 with an interactive logon at medium integrity and saw the user's
 * Credential Manager entries, where the ssh logon's own processes saw none.
 *
 * `legacy` is the name before the user was part of it (`autostartName`): this user's task of that name is removed by
 * `on`, `off`, `remove` and `signin`, and read by `status`, so an entry an earlier version wrote neither lingers nor
 * starts twice.
 */
export function taskScript(action, { name, run = '', legacy = null }) {
  const head = ["$ErrorActionPreference = 'Stop'", PS_MODULE_PATH, '[Console]::OutputEncoding = [Text.Encoding]::UTF8', `$name = ${psText(name)}`]
  const fail = `} catch { "${TASK_WORD}-ERROR $($_.Exception.Message -replace '\\s+', ' ')" }`
  const find = "$t = Get-ScheduledTask -TaskName $name -TaskPath '\\' -ErrorAction SilentlyContinue"
  /*
   * Who this user is: their account's SID, and its name as Windows resolves it (`PC\user`, `DOMAIN\user`), which a task
   * principal is registered with. Never USERDOMAIN: in an ssh logon on a PC in a workgroup it says `WORKGROUP`, which
   * names no account (#1223, measured on a laptop with beta.30). Whether a task's principal is this user's, as this
   * serve registers it, is decided by SID too: Task Scheduler gives the id with the domain, without it, or as a SID
   */
  const mine = [
    '$account = [System.Security.Principal.WindowsIdentity]::GetCurrent()',
    '$sid = $account.User.Value',
    '$me = $account.Name',
    "function Get-Sid($n) { if (\"$n\" -match '^S-1-') { return \"$n\" }; if (-not \"$n\") { return $null }; try { (New-Object System.Security.Principal.NTAccount(\"$n\")).Translate([System.Security.Principal.SecurityIdentifier]).Value } catch { $null } }",
    "function Test-Mine($x) { $x -and $x.Principal -and ((Get-Sid $x.Principal.UserId) -eq $sid) -and \"$($x.Principal.LogonType)\" -eq 'Interactive' -and \"$($x.Principal.RunLevel)\" -eq 'Limited' }",
  ]
  const old = legacy
    ? [`$legacy = ${psText(legacy)}`, "$old = Get-ScheduledTask -TaskName $legacy -TaskPath '\\' -ErrorAction SilentlyContinue"]
    : ['$old = $null']
  const dropOld = "if ($old -and (Test-Mine $old)) { Unregister-ScheduledTask -TaskName $legacy -TaskPath '\\' -Confirm:$false }"
  if (action === 'status') {
    return [
      ...head,
      'try {',
      ...[...mine, ...old, find, 'if (-not $t -and (Test-Mine $old)) { $t = $old }'].map((l) => `  ${l}`),
      `  if (-not $t) { '${TASK_WORD} state none' } elseif (@($t.Triggers | Where-Object { $_ }).Count -eq 0) { '${TASK_WORD} state notrigger' } else { "${TASK_WORD} state $($t.State)" }`,
      fail,
    ].join('\n')
  }
  if (action === 'remove') {
    return [...head, 'try {', ...[...mine, ...old, find, "if ($t) { Unregister-ScheduledTask -TaskName $name -TaskPath '\\' -Confirm:$false }", dropOld].map((l) => `  ${l}`), `  '${TASK_WORD} off'`, fail].join('\n')
  }
  if (action === 'off') {
    // The task stays, with what it runs and as whom; only the trigger goes
    const keep = "if ($t -and @($t.Triggers | Where-Object { $_ }).Count -gt 0) { Register-ScheduledTask -TaskName $name -TaskPath '\\' -Action $t.Actions -Principal $t.Principal -Settings $t.Settings -Description $t.Description -Force | Out-Null }"
    return [...head, 'try {', ...[...mine, ...old, find, keep, dropOld].map((l) => `  ${l}`), `  '${TASK_WORD} off'`, fail].join('\n')
  }
  const encoded = encodedCommand(run)
  const want = [
    "$exe = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    `$arg = '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}'`,
    '$user = $me',
  ]
  const register = (trigger) => [
    '$a = New-ScheduledTaskAction -Execute $exe -Argument $arg',
    '$p = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited',
    '$s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew',
    `$d = ${psText(trigger === 'logon' ? 'Starts the Centralu host (centralu serve) when you sign in. Written by centralu serve --autostart on.' : 'Starts the Centralu host (centralu serve) in your sign-in when a linked computer asks for it. Written by centralu serve --detach; centralu serve --autostart remove removes it.')}`,
    trigger === 'logon'
      ? "Register-ScheduledTask -TaskName $name -TaskPath '\\' -Action $a -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $user) -Principal $p -Settings $s -Description $d -Force | Out-Null"
      : "if (@($keep).Count -gt 0) { Register-ScheduledTask -TaskName $name -TaskPath '\\' -Action $a -Trigger $keep -Principal $p -Settings $s -Description $d -Force | Out-Null } else { Register-ScheduledTask -TaskName $name -TaskPath '\\' -Action $a -Principal $p -Settings $s -Description $d -Force | Out-Null }",
  ]
  if (action === 'signin') {
    /*
     * Someone is signed in when this user owns an Explorer in a session of its own (not session 0, where an ssh
     * logon's processes run). Asked of WMI for the owner's SID, which needs no administrator for the user's own
     * processes, reads the same in every language, and does not depend on what this logon calls its domain (GetOwner's
     * domain is the PC's name for a local account, while an ssh logon's USERDOMAIN may say `WORKGROUP`). When none is
     * found, how many desktop Explorers there were at all, and how many of their owners WMI would not tell, goes into
     * serve.log's line
     */
    return [
      ...head,
      'try {',
      ...mine.map((l) => `  ${l}`),
      "  $all = @(Get-CimInstance Win32_Process -Filter \"Name='explorer.exe'\" | Where-Object { $_.SessionId -gt 0 })",
      '  $owners = @($all | ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid })',
      '  $desk = @($owners | Where-Object { $_.ReturnValue -eq 0 -and $_.Sid -eq $sid })',
      '  $unread = @($owners | Where-Object { $_.ReturnValue -ne 0 }).Count',
      `  if ($desk.Count -eq 0) { "${TASK_WORD} nosession desktops=$($all.Count) unreadable=$unread" } else {`,
      ...[...want, ...old, find, dropOld].map((l) => `    ${l}`),
      '    $acts = @(if ($t) { $t.Actions })',
      '    $same = (Test-Mine $t) -and $acts.Count -eq 1 -and $acts[0].Execute -eq $exe -and $acts[0].Arguments -eq $arg',
      '    if (-not $same) {',
      // A trigger is this user's own choice (autostart on): kept only when the task was theirs
      '      $keep = @(if (Test-Mine $t) { $t.Triggers | Where-Object { $_ } })',
      ...register('keep').map((l) => `      ${l}`),
      `      '${TASK_WORD}-NOTE registered'`,
      '    }',
      "    Start-ScheduledTask -TaskName $name -TaskPath '\\'",
      `    '${TASK_WORD} started'`,
      '  }',
      fail,
    ].join('\n')
  }
  return [...head, 'try {', ...[...mine, ...want, ...old, ...register('logon'), dropOld].map((l) => `  ${l}`), `  '${TASK_WORD} on'`, fail].join('\n')
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
  if (action === 'off' || action === 'remove') {
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

async function taskAutostart(action, { dataDir, env, home, name, run, user, platform, interop }) {
  const legacy = legacyTaskName({ dataDir, home, env, platform })
  const detach = detachHow(platform, env, interop)
  const ps = windowsPowershell(detach, env)
  const base = { ok: true, how: 'task', linger: null }
  if (!ps) return { ...base, ok: false, on: false, message: 'Windows PowerShell is not reachable from this WSL distro' }
  const ask = (script) => askPowershell(ps, script, env, parseTaskAnswer, run)
  if (action === 'status') {
    const a = await ask(taskScript('status', { name, legacy }))
    if (!a.ok) return { ...base, ok: false, on: readAutostartMark(dataDir)?.how === 'task', message: `Task Scheduler did not answer: ${a.message}` }
    // A task without its trigger is the one `--detach` starts in the sign-in (#1224): no start at sign-in
    const on = a.word !== 'none' && a.word !== 'Disabled' && a.word !== 'notrigger'
    if (on) writeAutostartMark(dataDir, { how: 'task', name, linger: null })
    else clearAutostartMark(dataDir)
    return { ...base, on }
  }
  if (action === 'off' || action === 'remove') {
    // `off` keeps the task without its trigger, for `--detach`'s start in the sign-in; `remove` (uninstall) removes it
    const a = await ask(taskScript(action, { name, legacy }))
    if (!a.ok) return { ...base, ok: false, on: true, message: `Task Scheduler did not ${action === 'off' ? 'change' : 'remove'} the task "${name}": ${a.message}` }
    clearAutostartMark(dataDir)
    return { ...base, on: false }
  }
  const launcher = autostartLauncher(dataDir, platform)
  if (!launcher) return { ...base, ok: false, on: false, message: `there is no Centralu launcher in ${dataDir} to start at sign-in` }
  const runScript = taskActionScript({ how: detach, launcher, env, distro: env.WSL_DISTRO_NAME ?? null, user })
  const a = await ask(taskScript('on', { name, run: runScript, legacy }))
  if (!a.ok) return { ...base, ok: false, on: false, message: `Task Scheduler did not take the task: ${a.message}` }
  writeAutostartMark(dataDir, { how: 'task', name, linger: null })
  return { ...base, on: true }
}

/**
 * Starts this data folder's host in the person's Windows sign-in, when someone is signed in (#1224): the task
 * `--autostart` writes, registered without its trigger when it is not there, started with Start-ScheduledTask. Called
 * by `serve --detach` before it falls back to WMI, whose process keeps the caller's logon: from an ssh session that is a
 * network logon, which cannot open the user's Credential Manager vault, runs elevated for an administrator (#702) and
 * opens what it shows in session 0, where nobody sees it.
 *
 * `{ started: true, name }`, or `{ started: false, reason, message?, desktops? }`: `nosession` (this user is not signed
 * in here; `desktops` is how many desktop Explorers, of any account, there were, `unreadable` how many of their owners
 * WMI would not tell),
 * `off` (`CENTRALU_SIGNIN_TASK=off`, for a person who wants no task, and for tests on a machine with a desktop),
 * `not_windows`, `no_launcher`, `error`. `run` is a parameter so tests never reach the real Task Scheduler.
 */
export async function startInSignIn({ dataDir, env, home, platform = process.platform, run = runCaptured, user = env.USERNAME || userInfo().username }) {
  if (platform !== 'win32' || env.WSL_DISTRO_NAME) return { started: false, reason: 'not_windows' }
  if (env.CENTRALU_SIGNIN_TASK === 'off') return { started: false, reason: 'off' }
  const launcher = autostartLauncher(dataDir, platform)
  if (!launcher) return { started: false, reason: 'no_launcher' }
  const ps = windowsPowershell('wmi', env)
  if (!ps) return { started: false, reason: 'error', message: 'Windows PowerShell is not reachable' }
  const name = autostartName('task', { dataDir, home, env, platform, user })
  const runScript = taskActionScript({ how: 'wmi', launcher, env })
  const parse = (out) => {
    const m = /nosession desktops=(\d+)(?: unreadable=(\d+))?/.exec(String(out ?? ''))
    return { ...parseTaskAnswer(out), ...(m ? { desktops: Number(m[1]), unreadable: Number(m[2] ?? 0) } : {}) }
  }
  const a = await askPowershell(ps, taskScript('signin', { name, run: runScript, legacy: legacyTaskName({ dataDir, home, env, platform }) }), env, parse, run)
  if (!a.ok) return { started: false, reason: 'error', message: a.message }
  if (a.word === 'started') return { started: true, name }
  if (a.word === 'nosession') return { started: false, reason: 'nosession', ...(a.desktops !== undefined ? { desktops: a.desktops, unreadable: a.unreadable } : {}) }
  return { started: false, reason: 'error', message: `Task Scheduler answered ${a.word}` }
}

/**
 * `centralu serve --autostart on|off|remove|status` (docs/plans/remote-hub.md §10.4, owner decision 4: per
 * machine, off by default). The hub runs it over ssh for the Settings → Machines toggle, and its
 * uninstall runs `remove` (`off` on a serve that predates it). Turning it on or off never starts or stops a host: one runs already when the
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
    return report({ ok: action !== 'on', on: false, how: null, linger: null, ...(action === 'off' || action === 'remove' ? {} : { message: autostartUnsupported(platform, env) }) })
  }
  try {
    const name = autostartName(how, { dataDir, home, env, platform, user })
    const opts = { dataDir, env, home, name, run, user, platform, interop }
    return report(how === 'systemd' ? await systemdAutostart(action, opts) : await taskAutostart(action, opts))
  } catch (e) {
    return report({ ok: false, on: readAutostartMark(dataDir)?.how === how, how, linger: null, message: e?.message ?? String(e) })
  }
}
