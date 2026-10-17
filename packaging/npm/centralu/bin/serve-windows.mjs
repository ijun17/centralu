/**
 * Windows and WSL for `centralu serve`: which way a start outlives the ssh session, a Windows command
 * line, the PowerShell that asks WMI to create a process, and the Windows programs reached by full path
 * (from Windows itself, or through the drive a WSL distro mounts).
 */
import { existsSync, readFileSync } from 'node:fs'
import { systemRoot } from './platform.mjs'
import { runCaptured } from './serve-util.mjs'

/**
 * How `--detach` starts the launcher so that it outlives the session that asked (measured,
 * docs/plans/remote-hub.md §10.4):
 *
 *   setsid  posix: a new session, no terminal, nothing from the ssh session's process group. Once
 *           `--detach` returns, the launcher is reparented to init (the second fork of the usual
 *           double fork); it opens no terminal, so it can never get a controlling one back
 *   wmi     Windows: `Win32_Process.Create`. Windows' OpenSSH ends every process of a session with
 *           it, `Start-Process` included; a process WMI creates is not part of the session
 *   wsl     inside WSL: the same WMI call from the Windows side, creating `wsl.exe -d <distro>
 *           --exec <launcher>`. A `setsid` launcher inside the distro survives the session but not the
 *           distro, which WSL stops about 15 s after its last `wsl.exe` client exits; this
 *           `wsl.exe` is a client for as long as the host runs, and ending it ends the host
 */
export function detachHow(platform, env, interop = wslInterop) {
  if (platform === 'win32') return 'wmi'
  if (platform === 'linux' && env.WSL_DISTRO_NAME && interop()) return 'wsl'
  return 'setsid'
}

export function wslInterop() {
  return existsSync('/proc/sys/fs/binfmt_misc/WSLInterop') || existsSync('/proc/sys/fs/binfmt_misc/WSLInterop-late')
}

/** A WSL distro's name for `wsl.exe -d`, refused when it could be read as anything else */
export function wslDistro(distro) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(distro ?? '')) throw new Error(`not a WSL distro name: ${distro}`)
  return distro
}

/** A Linux user's name for `wsl.exe -u`, refused when it could be read as anything else */
export function wslUser(user) {
  if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/.test(user ?? '')) throw new Error(`cannot name the user ${user} to wsl.exe`)
  return user
}

/**
 * One argument for a Windows command line, as `CommandLineToArgvW` and the C runtime read it: always
 * quoted, backslashes before the closing quote doubled. A double quote or a line break cannot be a
 * path on Windows and is refused rather than escaped.
 */
export function windowsArg(arg) {
  const s = String(arg)
  if (/["\r\n\0]/.test(s)) throw new Error(`cannot pass ${JSON.stringify(s)} on a Windows command line`)
  return `"${s.replace(/(\\+)$/, '$1$1')}"`
}

/**
 * The first line of a script run by Windows PowerShell 5.1: its own module path. Started from
 * PowerShell 7 (pwsh, a `DefaultShell` of it, a CI runner), 5.1 inherits pwsh's `PSModulePath`, whose
 * first folder holds 7.x copies of the built-in modules that 5.1 cannot load: `Invoke-CimMethod` and
 * `Get-ScheduledTask` are then "found in the module … but the module could not be loaded". Same line as
 * the hub's (links/tunnel.ts, `PS_PREAMBLE`)
 */
export const PS_MODULE_PATH = "if ($env:PSModulePath -match '\\x5cPowerShell\\x5c') { $env:PSModulePath = \"$env:ProgramFiles\\WindowsPowerShell\\Modules;$PSHOME\\Modules\" }"

/** A PowerShell expression for `s`: base64 decoded there, so no quote reaches PowerShell's parser */
export function psText(s) {
  return `([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(String(s), 'utf8').toString('base64')}')))`
}

/** The PowerShell that asks WMI to create `commandLine`. Values cross as base64, so no quoting can break */
export function wmiScript({ commandLine, cwd = null }) {
  return [
    "$ErrorActionPreference = 'Stop'",
    PS_MODULE_PATH,
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `$a = @{ CommandLine = ${psText(commandLine)} }`,
    ...(cwd ? [`$a.CurrentDirectory = ${psText(cwd)}`] : []),
    // No console window when this runs from a desktop session; left out where it cannot be built
    'try { $a.ProcessStartupInformation = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 } } catch { }',
    'try {',
    '  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $a',
    "  if ($r.ReturnValue -eq 21 -and $a.ContainsKey('ProcessStartupInformation')) { $a.Remove('ProcessStartupInformation'); $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments $a }",
    '  "CENTRALU-WMI $($r.ReturnValue) $($r.ProcessId)"',
    '} catch { "CENTRALU-WMI-ERROR $($_.Exception.Message)" }',
  ].join('\n')
}

/** `Win32_Process.Create`'s return values (Microsoft's documentation of the method) */
const WMI_CODES = { 2: 'access denied', 3: 'insufficient privilege', 8: 'unknown failure', 9: 'path not found', 21: 'invalid parameter' }

/** What the WMI script said: `{ ok: true, pid }` or `{ ok: false, message }` */
export function parseWmiAnswer(stdout) {
  const text = String(stdout ?? '')
  const m = /CENTRALU-WMI (\d+) (\d*)/.exec(text)
  if (m) {
    const rv = Number(m[1])
    if (rv === 0 && Number(m[2]) > 0) return { ok: true, pid: Number(m[2]) }
    return { ok: false, message: `WMI's Win32_Process.Create returned ${rv}${WMI_CODES[rv] ? ` (${WMI_CODES[rv]})` : ''}` }
  }
  const e = /CENTRALU-WMI-ERROR (.*)/.exec(text)
  if (e) return { ok: false, message: `WMI refused to create the process: ${e[1].trim()}` }
  return { ok: false, message: 'PowerShell did not answer the WMI request' }
}

/**
 * The sentence for a start WMI did not make. Some managed machines block process creation through
 * WMI (Microsoft Defender's attack surface reduction rule "Block process creations originating from
 * PSExec and WMI commands", off by default); the hub then runs the host bound to its link
 * (docs/plans/remote-hub.md §10.9, decision 3).
 */
export function wmiBlockedMessage(detail) {
  return (
    `Windows did not start Centralu through WMI (${detail}). Some managed Windows machines block it ` +
    '(Microsoft Defender\'s attack surface reduction rule "Block process creations originating from PSExec and WMI commands"). ' +
    'Centralu can run there while this computer is linked instead, and stops when the link does.'
  )
}

/** Windows PowerShell 5.1, by full path: under %SystemRoot% on Windows, through the drive WSL mounts inside a distro */
export function windowsPowershell(how, env, mounts) {
  return windowsTool(how, env, ['System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'], mounts)
}

/** A program under the Windows folder, by full path, from Windows or from inside a WSL distro; null when unreachable */
export function windowsTool(how, env, rel, mounts = () => readFileSync('/proc/mounts', 'utf8')) {
  if (how === 'wmi') return [systemRoot(env), ...rel].join('\\')
  let text = ''
  try {
    text = mounts()
  } catch {
    // no /proc: not WSL after all
  }
  for (const line of text.split('\n')) {
    const [, at, type] = line.split(' ')
    if (!at || !(type === '9p' || type === 'drvfs')) continue
    const candidate = [at, 'Windows', ...rel].join('/')
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** A script as `-EncodedCommand` takes it: UTF-16LE, in base64 */
export function encodedCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64')
}

/**
 * Runs `script` in the Windows PowerShell at `ps` and reads what it printed with `parse` (`{ ok, … }`). When it printed
 * nothing and PowerShell itself complained (a policy, a module it could not load), the answer is the last line of that.
 */
export async function askPowershell(ps, script, env, parse, run = runCaptured) {
  const r = await run(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand(script)], env)
  const a = parse(r.stdout)
  return a.ok || r.stdout.trim() || !r.stderr.trim() ? a : { ok: false, message: r.stderr.trim().split(/\r?\n/).at(-1) }
}
