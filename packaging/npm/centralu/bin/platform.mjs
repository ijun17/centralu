/**
 * The launcher's per-platform decisions, as plain functions of the platform.
 *
 * Lives apart from `centralu.mjs` for the same reason `semver.mjs` does: the launcher runs
 * a command at import time, so a test cannot import it. Everything here takes the platform
 * (and the environment, and the home folder) as an argument instead of reading `process`,
 * so `tooling/launcher-platform.test.ts` can ask what Windows would do from a Mac — which
 * is the only place this project can run a test before the Windows package ships.
 *
 * package.json "files" lists the whole bin/ directory, so this ships automatically.
 */
import { posix, win32 } from 'node:path'

export const APP_NAME = 'Centralu'

/**
 * The arch package for each machine, and what the app is called inside it.
 *
 * `artifact` must match `scripts/release-npm.mts` exactly — that script renames what
 * Tauri produced (`Centralu_0.1.0-beta.2_amd64.AppImage`) to a fixed name precisely so
 * the launcher does not have to know version or architecture. If the two ever disagree
 * the symptom is "installed fine, does nothing".
 *
 * Only combinations that are actually published belong here. Listing a package that was
 * never released would turn "not supported yet" into "your install is broken", which
 * sends the user off to reinstall something that can never appear.
 * `tooling/launcher-platform.test.ts` holds this table to the shim's `optionalDependencies`.
 *
 * Windows ships a folder, not a single file: `Centralu\centralu.exe` beside
 * `Centralu\resources\host\`. Tauri looks for its resources next to the exe when nothing
 * is installed, so the folder runs where npm unpacked it (#14, W1 in #307).
 */
export const TARGETS = {
  'darwin-arm64': { pkg: 'centralu-darwin-arm64', artifact: `${APP_NAME}.app` },
  'linux-arm64': { pkg: 'centralu-linux-arm64', artifact: `${APP_NAME}.AppImage` },
  'linux-x64': { pkg: 'centralu-linux-x64', artifact: `${APP_NAME}.AppImage` },
  'win32-x64': { pkg: 'centralu-win32-x64', artifact: APP_NAME },
}

/** The target for a platform/arch pair, or null when nothing is published for it. */
export function targetFor(platform, arch) {
  return TARGETS[`${platform}-${arch}`] ?? null
}

/**
 * The file that proves the artifact is there and is what gets started.
 *
 * On macOS and Linux that is the artifact itself (a bundle handed to `open`, an AppImage
 * run directly). On Windows the artifact is a folder, and a folder that exists without its
 * exe — an interrupted extract — must count as missing, not as found.
 */
export function executableIn(platform, app) {
  return platform === 'win32' ? win32.join(app, 'centralu.exe') : app
}

/**
 * How to start the app: the command, its arguments, the spawn options, and whether the
 * launcher stays attached until it exits.
 *
 * - macOS goes through `open`, so LaunchServices handles the dock icon and single instance.
 * - Linux runs the AppImage attached to the terminal, because its two usual first failures
 *   (missing FUSE, a missing system library) explain themselves on stderr and nowhere else.
 * - Windows starts `centralu.exe` **detached**. That is not only about handing the prompt
 *   back: libuv puts every non-detached child in a job object that kills it when the parent
 *   exits, so an attached app would die the moment this launcher returns, or when the
 *   console window is closed. `centralu.exe` is a GUI-subsystem program (checked by
 *   `scripts/release-npm.mts`), so no console window appears for it either way.
 *   `windowsHide` stays off on purpose: it starts the process with SW_HIDE, which a GUI
 *   program applies to its first window — the app would start invisible.
 *   The working directory is the home folder, because a process holds its working
 *   directory open on Windows, and that would stop the shell's folder from being renamed
 *   or deleted (and `centralu install` from replacing the app's own folder).
 */
export function launchPlan(platform, app, args, home) {
  if (platform === 'darwin') {
    return {
      command: 'open',
      args: ['-a', app, ...(args.length ? ['--args', ...args] : [])],
      options: { stdio: 'inherit' },
      attached: true,
    }
  }
  if (platform === 'win32') {
    return {
      command: executableIn(platform, app),
      args,
      options: { detached: true, stdio: 'ignore', windowsHide: false, cwd: home },
      attached: false,
    }
  }
  return { command: app, args, options: { stdio: 'inherit' }, attached: true }
}

/**
 * Where `centralu install` puts the app on Windows, and what it writes there.
 *
 * The analogue of copying the bundle into `/Applications` on macOS, not of the Linux menu
 * entry that points back into the npm package. The reason is Windows-specific: a running
 * program's files cannot be replaced, so while the app runs from inside the npm package,
 * `npm i -g centralu@newer` fails with EBUSY. A copy elsewhere is what lets the package
 * update while the app is open.
 *
 * `%LOCALAPPDATA%\Programs` is the per-user program folder (VS Code's user installer and
 * winget's user scope use it). No admin rights, nothing outside the user's own profile.
 * The Start menu entry is a shortcut in the per-user Start menu folder; Windows search
 * indexes it.
 *
 * `versionFile` records which package version the copy came from, so the launcher can say
 * when the copy is behind — the exe's own version resource does not carry a prerelease tag.
 */
export function windowsInstall(env, home) {
  const local = env.LOCALAPPDATA || win32.join(home, 'AppData', 'Local')
  const roaming = env.APPDATA || win32.join(home, 'AppData', 'Roaming')
  const dir = win32.join(local, 'Programs', APP_NAME)
  return {
    dir,
    shortcut: win32.join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${APP_NAME}.lnk`),
    exe: win32.join(dir, 'centralu.exe'),
    versionFile: win32.join(dir, 'centralu-version.txt'),
  }
}

/**
 * What `centralu install` creates, per platform. `uninstall` removes exactly these and
 * `update` refreshes them when the first one exists.
 */
export function installedPaths(platform, env, home) {
  if (platform === 'darwin') return [`/Applications/${APP_NAME}.app`]
  if (platform === 'win32') {
    const w = windowsInstall(env, home)
    return [w.dir, w.shortcut]
  }
  return [posix.join(home, '.local/share/applications/centralu.desktop')]
}

function systemRoot(env) {
  return env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows'
}

/**
 * A PowerShell invocation that writes the Start-menu shortcut.
 *
 * Windows has no file format for a shortcut that Node can write; `.lnk` is a binary shell
 * format, and the supported way to write one is the WScript.Shell COM object. The paths go
 * in through environment variables rather than the script text, so a profile path with a
 * space or an apostrophe (`C:\Users\O'Brien Kim\…`) needs no quoting at all — the one way
 * this cannot be got wrong. PowerShell is named by its full path under `%SystemRoot%` so a
 * `powershell.exe` earlier on PATH (or in the current folder) is never the one that runs.
 */
export function shortcutCommand(env, { shortcut, target, workdir }) {
  const script = [
    '$ErrorActionPreference = "Stop"',
    'New-Item -ItemType Directory -Force -Path (Split-Path -Parent $env:CENTRALU_SHORTCUT) | Out-Null',
    '$s = (New-Object -ComObject WScript.Shell).CreateShortcut($env:CENTRALU_SHORTCUT)',
    '$s.TargetPath = $env:CENTRALU_TARGET',
    '$s.WorkingDirectory = $env:CENTRALU_WORKDIR',
    '$s.IconLocation = "$env:CENTRALU_TARGET,0"',
    `$s.Description = "${APP_NAME}"`,
    '$s.Save()',
  ].join('; ')
  return {
    command: win32.join(systemRoot(env), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    env: { ...env, CENTRALU_SHORTCUT: shortcut, CENTRALU_TARGET: target, CENTRALU_WORKDIR: workdir },
  }
}

/**
 * How to run npm from the launcher (`centralu update`).
 *
 * On Windows `npm` is `npm.cmd`, and Node refuses to start a `.cmd` without a shell
 * (EINVAL, since the April 2024 security releases) — and without one it would not find it
 * either, as libuv only tries `.com` and `.exe`. So Windows goes through the shell, and
 * because a shell re-parses its command line, every argument has to be a plain token. The
 * version comes from the registry's response, so that is checked rather than trusted.
 */
export function npmCommand(platform, args) {
  for (const a of args) {
    if (!/^[\w@./:+-]+$/.test(a)) throw new Error(`refusing to pass an unexpected argument to npm: ${JSON.stringify(a)}`)
  }
  return platform === 'win32'
    ? { command: 'npm', args, options: { stdio: 'inherit', shell: true } }
    : { command: 'npm', args, options: { stdio: 'inherit' } }
}

export const WEBVIEW2_DOWNLOAD = 'https://developer.microsoft.com/microsoft-edge/webview2/'
/** Microsoft's link to the Evergreen Bootstrapper itself, for someone who wants one click. */
export const WEBVIEW2_BOOTSTRAPPER = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'

/** The Evergreen WebView2 Runtime's client id, the same under every registry hive. */
const WEBVIEW2_CLIENT = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'

/**
 * Where an installed WebView2 Runtime registers itself: per machine (the 32-bit view on
 * 64-bit Windows, which is where the installer writes), per machine on 32-bit Windows, and
 * per user. This is Microsoft's documented detection
 * (learn.microsoft.com/microsoft-edge/webview2/concepts/distribution, "Detect if a WebView2
 * Runtime is already installed").
 */
export const WEBVIEW2_KEYS = [
  `HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_CLIENT}`,
  `HKLM\\SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_CLIENT}`,
  `HKCU\\Software\\Microsoft\\EdgeUpdate\\Clients\\${WEBVIEW2_CLIENT}`,
]

/** `reg.exe` by full path, for the same reason PowerShell is. */
export function regExe(env) {
  return win32.join(systemRoot(env), 'System32', 'reg.exe')
}

/**
 * The `pv` value out of `reg query <key> /v pv`, or null. Microsoft's rule: the runtime is
 * installed when `pv` exists and is neither empty nor `0.0.0.0` (an uninstall can leave
 * the key behind with that value).
 */
export function parseRegPv(stdout) {
  const m = /^\s*pv\s+REG_SZ\s+(\S*)\s*$/im.exec(String(stdout ?? ''))
  const v = m?.[1] ?? ''
  return v && v !== '0.0.0.0' ? v : null
}

/**
 * Whether WebView2 is there, from a `query(key)` that returns `reg`'s stdout, `null` when
 * the key does not exist, or `undefined` when `reg` itself could not run.
 *
 * Three answers, not two. "Missing" stops the launch with a message, so it has to be a
 * positive finding — every hive was readable and none has the runtime. If `reg` could not
 * run at all the answer is "unknown" and the app starts anyway: refusing to launch because
 * a check broke would be worse than the blank window the check exists to explain.
 *
 * `WEBVIEW2_BROWSER_EXECUTABLE_FOLDER` points WebView2 at a fixed-version runtime that the
 * registry knows nothing about; when it is set, the person has made that choice.
 */
export function webview2Status(env, query) {
  if (env.WEBVIEW2_BROWSER_EXECUTABLE_FOLDER) return { state: 'present', version: 'fixed' }
  let unknown = false
  for (const key of WEBVIEW2_KEYS) {
    const out = query(key)
    if (out === undefined) {
      unknown = true
      continue
    }
    const version = parseRegPv(out)
    if (version) return { state: 'present', version }
  }
  return { state: unknown ? 'unknown' : 'missing' }
}

export function webview2MissingMessage() {
  return (
    `${APP_NAME} needs the Microsoft Edge WebView2 Runtime, and it is not installed on this machine.\n` +
    'Windows 11 includes it; some Windows 10 installs do not.\n' +
    `Install the "Evergreen Bootstrapper" from ${WEBVIEW2_DOWNLOAD}\n` +
    `(direct download: ${WEBVIEW2_BOOTSTRAPPER}),\n` +
    'then run `centralu` again.'
  )
}

/**
 * What to say when the exe exits nonzero within moments of starting.
 *
 * The launcher is detached by then, so this is the only place a failure to start can be
 * reported at all — a GUI program has no stderr to read. The registry check catches the
 * usual cause before the start; this catches the rest (a runtime that is registered but
 * broken, a blocked exe, a crash before the window).
 */
export function earlyExitMessage(code, home) {
  return (
    `${APP_NAME} exited right after starting (exit code ${code}).\n` +
    `- If no window appeared, check the WebView2 Runtime: ${WEBVIEW2_DOWNLOAD}\n` +
    `- The host log is ${win32.join(home, '.centralu', 'host.log')}\n` +
    'Please report it at https://github.com/ijun17/centralu/issues/14 with that log.'
  )
}

/**
 * What to say when Windows refuses to replace or remove the app's files.
 *
 * EBUSY / EPERM on a program folder almost always means the program is running: Windows
 * locks a running exe and the native modules the host loaded. Macs and Linux let both be
 * replaced underneath a running process, which is why this message exists only here.
 */
export function busyMessage(path) {
  return (
    `Windows would not replace ${path} — ${APP_NAME} is probably still running.\n` +
    'Quit it (close the window and choose Quit), then run the command again.'
  )
}

export function isBusyError(e) {
  return e?.code === 'EBUSY' || e?.code === 'EPERM' || e?.code === 'EACCES' || e?.code === 'ENOTEMPTY'
}
