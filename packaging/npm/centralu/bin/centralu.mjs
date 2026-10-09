#!/usr/bin/env node
/**
 * The Centralu launcher.
 *
 * **Why this ships through npm:** macOS does not inspect the app and decide it is dangerous —
 * it looks at the `com.apple.quarantine` flag attached to the file and checks the developer's
 * identity from that. That flag is attached **by the program that downloaded it** — a browser
 * attaches it, npm does not. So an npm install just opens with no warning even with an ad hoc
 * signature (docs/plans/beta-release-checklist.md §2).
 *
 * The app itself lives inside an architecture-specific package (`@centralu/darwin-arm64`). This
 * package is a thin shell that finds it and launches it — the same structure esbuild and swc
 * use.
 *
 * Linux is served from the same shim (issue #14). The two platforms disagree about what
 * "the app" even is — macOS hands a `.app` directory to LaunchServices, Linux runs a
 * self-contained AppImage itself — so that difference lives in one table (`TARGETS`)
 * instead of being rediscovered in every function.
 *
 * Windows joined in W3 of #14. Its decisions — the exe inside the folder, a detached start,
 * where `install` copies to, the WebView2 check — live in `platform.mjs` as functions of the
 * platform, so they are tested on macOS CI (tooling/launcher-platform.test.ts) instead of
 * being first exercised on someone's laptop.
 */
import { execFileSync, spawn } from 'node:child_process'
import { copyDiffers, isNewer } from './semver.mjs'
import {
  asideCopies,
  busyMessage,
  earlyExitMessage,
  executableIn,
  findHostEntry,
  installedPaths,
  isBusyError,
  launchPlan,
  npmCommand,
  regExe,
  shortcutCommand,
  targetFor,
  TARGETS,
  webview2MissingMessage,
  webview2Status,
  windowsInstall,
} from './platform.mjs'
import {
  decodeChildSpec,
  parseServeArgs,
  printConnection,
  rotateToken,
  runDetach,
  runDetachedChild,
  runServe,
  runStop,
  SERVE_HELP,
} from './serve.mjs'
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const pkg = require('../package.json')

const APP_NAME = 'Centralu'
const BUNDLE = `${APP_NAME}.app`
const INSTALLED = `/Applications/${BUNDLE}`

const PLATFORM = process.platform
const HOME = homedir()

/** Where a menu entry for the app goes on freedesktop desktops */
const DESKTOP_ENTRY = join(HOME, '.local/share/applications/centralu.desktop')

/** Where `centralu install` copies the app on Windows (see `windowsInstall`) */
const WIN = PLATFORM === 'win32' ? windowsInstall(process.env, HOME) : null

/** The arch package for this machine (the table lives in platform.mjs) */
const TARGET = targetFor(PLATFORM, process.arch)

/** The app inside the architecture-specific package. null if it cannot be found. */
function bundledApp() {
  if (!TARGET) return null
  let root
  try {
    root = dirname(require.resolve(`${TARGET.pkg}/package.json`))
  } catch {
    return null // The package for this architecture is not installed — the reason is explained below.
  }
  const app = join(root, TARGET.artifact)
  return existsSync(executableIn(PLATFORM, app)) ? app : null
}

/**
 * States **specifically** why this machine cannot run it right now.
 * If all that shows is "not installed", there is nothing the person can act on.
 */
function explainMissing() {
  if (!TARGET) {
    // Kept as its own case: "not published for your machine" and "not published for
    // Intel Macs, and here is the reason" send the user to different places.
    if (PLATFORM === 'darwin') {
      return (
        `${APP_NAME} is Apple Silicon only for now (current architecture: ${process.arch}).\n` +
        'Intel Mac support needs native addons bundled in as well, and is tracked as separate work.'
      )
    }
    const supported = Object.keys(TARGETS).join(', ')
    return (
      `${APP_NAME} does not support ${PLATFORM}/${process.arch} yet.\n` +
      `Currently supported combinations: ${supported}\n` +
      'Progress is tracked at https://github.com/ijun17/centralu/issues/14.'
    )
  }
  return (
    `Could not find the app package (${TARGET.pkg}).\n` +
    'The install may have been interrupted — please reinstall with `npm i -g centralu`.'
  )
}

/**
 * The bundled host's entry (`resources/host/main.mjs`) for `centralu serve`, or exit with why not:
 * from the platform package, or from the host-only package where a hub installed this (`findHostEntry`).
 *
 * `CENTRALU_HOST_ENTRY` points it at another host instead: a source checkout's
 * `packages/agent-host/src/main.ts` while developing, or a freshly bundled `resources/host/main.mjs`.
 * The tests start `serve` that way (tooling/launcher-serve.test.ts).
 */
function requireHostEntry() {
  if (process.env.CENTRALU_HOST_ENTRY) return process.env.CENTRALU_HOST_ENTRY
  if (!TARGET) {
    console.error(explainMissing())
    process.exit(1)
  }
  // The platform package of an npm install, else the host-only package a hub installed (platform.mjs)
  const found = findHostEntry(PLATFORM, process.arch, {
    resolveRoot: (name) => {
      try {
        return dirname(require.resolve(`${name}/package.json`))
      } catch {
        return null
      }
    },
    exists: existsSync,
  })
  if (found.entry) return found.entry
  if (found.missingHost) {
    console.error(
      `The host is missing from ${found.missingHost.pkg} (looked for ${found.missingHost.entry}).\n` +
        'Linux packages published before `centralu serve` existed do not carry it. Update with `npm i -g centralu`.',
    )
    process.exit(1)
  }
  console.error(explainMissing())
  process.exit(1)
}

function requireApp() {
  const app = bundledApp()
  if (!app) {
    console.error(explainMissing())
    process.exit(1)
  }
  return app
}

/**
 * Launches the app. If it is installed in `/Applications` (macOS) or
 * `%LOCALAPPDATA%\Programs\Centralu` (Windows), that copy is used first.
 *
 * Linux has no such preference, and not for lack of an equivalent: `centralu install`
 * on Linux writes a launcher that points back at this same package, so there is never a
 * second copy to prefer.
 *
 * Resolves once the launcher has nothing more to wait for. Only Windows waits at all —
 * briefly, to report an exe that dies on start (see runWindows).
 */
async function run(args) {
  if (PLATFORM === 'darwin') {
    const app = existsSync(INSTALLED) ? INSTALLED : requireApp()
    // `open` goes through LaunchServices — the dock icon and single-instance behavior only
    // work correctly that way.
    const plan = launchPlan(PLATFORM, app, args, HOME)
    const r = spawn(plan.command, plan.args, plan.options)
    r.on('exit', (code) => process.exit(code ?? 0))
    return
  }
  if (PLATFORM === 'win32') return runWindows(args)
  // Linux has no LaunchServices — the AppImage is its own launcher, so run it directly.
  //
  // Staying attached to the terminal is on purpose. The two usual first failures on
  // Linux both explain themselves on stderr and nowhere else: a missing FUSE
  // ("AppImages require FUSE to run", with the workaround in the same sentence) and a
  // missing system library from the loader. Detaching would hand back the shell prompt
  // and throw away the one line that says what to do.
  const app = requireApp()
  const plan = launchPlan(PLATFORM, app, args, HOME)
  const r = spawn(plan.command, plan.args, plan.options)
  r.on('error', (e) => {
    console.error(`Failed to run ${app}: ${e.message}`)
    // EACCES here means the executable bit did not survive the trip through npm, which
    // is invisible from the message alone.
    if (e.code === 'EACCES') console.error(`No execute permission — run \`chmod +x "${app}"\` then try again.`)
    process.exit(1)
  })
  r.on('exit', (code) => process.exit(code ?? 0))
}

/** How long to watch a freshly started exe for an immediate exit */
const EARLY_EXIT_MS = 3000

/**
 * Windows: check WebView2, start `centralu.exe` detached, and watch it for a few seconds.
 *
 * The app is a GUI program, so a failure to start has nowhere to print. Without WebView2
 * the exe ends before it has a window, and the person sees nothing happen at all — the
 * registry check turns that into a message with the download link before anything starts.
 * The short watch afterwards catches whatever the registry cannot see (a broken runtime, a
 * blocked exe), then lets go so the app outlives this launcher.
 */
async function runWindows(args) {
  const webview = webview2Status(process.env, queryRegistry)
  if (webview.state === 'missing') {
    console.error(webview2MissingMessage())
    process.exit(1)
  }
  const app = existsSync(WIN.exe) ? WIN.dir : requireApp()
  const plan = launchPlan(PLATFORM, app, args, HOME)
  const child = spawn(plan.command, plan.args, plan.options)
  await new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      child.removeAllListeners()
      child.unref()
      resolve()
    }
    const timer = setTimeout(done, EARLY_EXIT_MS)
    child.on('error', (e) => {
      console.error(`Failed to start ${plan.command}: ${e.message}`)
      process.exitCode = 1
      done()
    })
    child.on('exit', (code) => {
      // 0 is a normal answer this early: a second start hands over to the window that is
      // already open and leaves.
      if (code !== 0 && code !== null) {
        console.error(earlyExitMessage(code, HOME))
        process.exitCode = 1
      }
      done()
    })
  })
}

/**
 * `reg query <key> /v pv`: stdout, null when the key or value does not exist (reg exits 1),
 * undefined when reg itself could not run.
 */
function queryRegistry(key) {
  try {
    return execFileSync(regExe(process.env), ['query', key, '/v', 'pv'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
  } catch (e) {
    return typeof e?.status === 'number' ? null : undefined
  }
}

/**
 * Registers the app in the system menu.
 *
 * **Never done quietly through postinstall.** Writing silently into someone's `/Applications`
 * erodes trust, and pnpm blocks postinstall by default anyway. This is only run when the
 * person explicitly asks for it.
 */
function install() {
  const app = requireApp()
  if (PLATFORM === 'win32') return installWindows(app)
  if (PLATFORM !== 'darwin') return installDesktopEntry(app)
  if (existsSync(INSTALLED)) {
    console.log(`Replacing the existing ${INSTALLED} with the new version.`)
    rmSync(INSTALLED, { recursive: true, force: true })
  }
  // ditto, not cp — carries over the bundle's permissions and extended attributes unchanged
  // (so the signature does not break).
  execFileSync('/usr/bin/ditto', [app, INSTALLED], { stdio: 'inherit' })
  console.log(`Installed: ${INSTALLED}`)
  console.log('It can now be found in Launchpad and Spotlight too.')
}

/**
 * The Linux answer to "copy it into /Applications so it shows up in Launchpad".
 *
 * It writes a launcher, not a copy. On macOS the `.app` has to move because
 * LaunchServices only indexes a few directories; on Linux the menu indexes `.desktop`
 * files that may point anywhere, so pointing at the npm package leaves exactly one copy
 * of the binary — and `npm i -g centralu@newer` then updates the menu entry too,
 * because the path it names does not change.
 */
function installDesktopEntry(app) {
  const icon = join(dirname(app), 'icon.png')
  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${APP_NAME}`,
    'Comment=Run, watch and steer several coding agents in one window',
    // Quoted because the path runs through node_modules and npm prefixes can contain spaces
    `Exec="${app}" %U`,
    `Icon=${existsSync(icon) ? icon : 'centralu'}`,
    'Terminal=false',
    'Categories=Development;Utility;',
    // Guessed, not measured: this must equal the WM class the running window reports,
    // and we have no Linux desktop here to read it off. If the taskbar shows two icons
    // for one window, this line is why.
    'StartupWMClass=Centralu',
    '',
  ].join('\n')
  mkdirSync(dirname(DESKTOP_ENTRY), { recursive: true })
  writeFileSync(DESKTOP_ENTRY, entry)
  chmodSync(DESKTOP_ENTRY, 0o755)
  console.log(`Registered: ${DESKTOP_ENTRY}`)
  console.log('It can now be found in the app list too (some desktops require logging back in before it shows up).')
}

/**
 * The Windows answer to "copy it into /Applications": copy the folder into
 * `%LOCALAPPDATA%\Programs\Centralu` and put a shortcut in the Start menu.
 *
 * A copy rather than a shortcut into the npm package (the Linux shape), because Windows
 * will not replace a running program's files: with the app running from the package,
 * `npm i -g centralu@newer` fails. Running from the copy leaves the package free to update.
 *
 * The old copy is never deleted before the new one is complete. The new folder is
 * assembled beside it, the old one is renamed aside, and only then is the new one moved in
 * — so a copy that fails halfway, or an app that is still running, leaves the working
 * install untouched rather than a folder with half its files.
 */
function installWindows(app) {
  const staging = `${WIN.dir}.new`
  const aside = `${WIN.dir}.old-${Date.now()}`
  sweepAsideCopies()
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(dirname(WIN.dir), { recursive: true })
  cpSync(app, staging, { recursive: true })
  writeFileSync(join(staging, 'centralu-version.txt'), `${pkg.version}\n`)
  if (existsSync(WIN.dir)) {
    console.log(`Replacing the existing ${WIN.dir} with the new version.`)
    try {
      renameSync(WIN.dir, aside)
    } catch (e) {
      rmSync(staging, { recursive: true, force: true })
      if (!isBusyError(e)) throw e
      console.error(busyMessage(WIN.dir))
      process.exit(1)
    }
  }
  renameSync(staging, WIN.dir)
  try {
    rmSync(aside, { recursive: true, force: true })
  } catch {
    // A rename can succeed while the old copy is running; its files then stay locked until
    // it quits. Harmless — it is no longer the one anything starts — but worth a line.
    console.log(`The previous copy is still in use and was left at ${aside}. Delete it after quitting ${APP_NAME}.`)
  }
  const sc = shortcutCommand(process.env, { shortcut: WIN.shortcut, target: WIN.exe, workdir: HOME })
  try {
    execFileSync(sc.command, sc.args, { env: sc.env, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true })
  } catch (e) {
    console.log(`Installed: ${WIN.dir}`)
    console.error(`Could not create the Start menu shortcut (${e.message}). Start ${WIN.exe} directly, or run \`centralu\`.`)
    process.exit(1)
  }
  console.log(`Installed: ${WIN.dir}`)
  console.log(`Start menu: ${WIN.shortcut}`)
  console.log('It can now be found in Start and Windows search, and `centralu` starts this copy too.')
}

/**
 * Removes the copies earlier installs renamed aside (`Centralu.old-<time>`), whichever can go.
 *
 * An update from inside the app renames the running copy aside, and Windows will not delete a
 * running exe, so that copy stays until the app quits. Nothing else would ever remove it, and
 * each in-app update would leave one more (about 70 files each, measured 2026-10-08). One still
 * in use is left for the next install; deleting what can be deleted from it does not disturb the
 * app running from it, which reaches its files by the folder's original path, now the new copy.
 */
function sweepAsideCopies() {
  const parent = dirname(WIN.dir)
  let names
  try {
    names = readdirSync(parent)
  } catch {
    return
  }
  for (const name of asideCopies(names)) {
    try {
      rmSync(join(parent, name), { recursive: true, force: true })
    } catch {
      // Still in use: the next install tries again
    }
  }
}

function uninstall() {
  const paths = installedPaths(PLATFORM, process.env, HOME)
  const present = paths.filter((p) => existsSync(p))
  if (present.length === 0) {
    console.log(`${paths[0]} does not exist — nothing to remove.`)
    return
  }
  for (const installed of present) {
    try {
      rmSync(installed, { recursive: true, force: true })
    } catch (e) {
      if (PLATFORM !== 'win32' || !isBusyError(e)) throw e
      console.error(busyMessage(installed))
      process.exit(1)
    }
    console.log(`Removed: ${installed}`)
  }
  console.log('To remove the package itself: npm uninstall -g centralu')
  const data = PLATFORM === 'win32' ? '%USERPROFILE%\\.centralu' : '~/.centralu'
  console.log(`Conversation history is left in place (${data}). Remove it yourself if you want to.`)
}

/**
 * The npm registry itself is the update channel — no separate server or signing key needed.
 *
 * Failures are not lumped together. Being unreachable (network) and not existing (404) call
 * for **different actions from the person** — the first says to check the connection, the
 * second says checking will not help.
 */
async function latestVersion(timeoutMs = 2000) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.name}/latest`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (res.status === 404) return { ok: false, reason: 'missing' }
    if (!res.ok) return { ok: false, reason: `http ${res.status}` }
    const body = await res.json()
    const version = body?.version
    return typeof version === 'string' ? { ok: true, version } : { ok: false, reason: 'bad-response' }
  } catch {
    return { ok: false, reason: 'network' } // The app has to launch even with no network.
  }
}


async function update() {
  const res = await latestVersion(8000)
  if (!res.ok) {
    if (res.reason === 'missing') {
      console.error(`${pkg.name} is not on the registry. The name may have changed, or it has not been published yet.`)
      console.error('Please check https://github.com/ijun17/centralu/releases.')
    } else if (res.reason === 'network') {
      console.error('Could not reach the registry. Please check your network and try again.')
    } else {
      console.error(`The registry gave an unexpected response (${res.reason}).`)
    }
    process.exit(1)
  }
  const latest = res.version
  if (!isNewer(latest, pkg.version)) {
    console.log(`Already up to date (${pkg.version}).`)
    // The package can be up to date while the copy is not — that is exactly the state of
    // someone who upgraded with `npm i -g`.
    notifyIfCopyStale()
    return
  }
  console.log(`Upgrading ${pkg.version} → ${latest}.`)
  const npm = npmCommand(PLATFORM, ['i', '-g', `${pkg.name}@${latest}`])
  try {
    execFileSync(npm.command, npm.args, npm.options)
  } catch (e) {
    // On Windows the usual cause is the app running from inside the package: its files are
    // locked, and npm cannot replace them. npm's own output (above) has the details.
    if (PLATFORM === 'win32') console.error(`\n${busyMessage('the npm package')}`)
    process.exit(typeof e?.status === 'number' ? e.status : 1)
  }
  // Someone with a copy in /Applications (or %LOCALAPPDATA%\Programs) needs that updated
  // too, or the old version stays behind.
  // On Linux the menu entry points at the package instead of a copy, so rewriting it is
  // cheap — but it is still worth doing, because the Exec path is what would go stale.
  //
  // The *new* launcher does the refresh: this file has just been replaced on disk. It is
  // run through `node` rather than as a script, because Windows cannot execute a `.mjs`.
  const installed = installedPaths(PLATFORM, process.env, HOME)[0]
  if (existsSync(installed)) {
    console.log(`Updating ${installed} too.`)
    execFileSync(process.execPath, [process.argv[1], 'install'], { stdio: 'inherit' })
  }
  console.log('Done. If the app is open, please restart it.')
}

/**
 * The version of the copy placed in /Applications. null if there is nothing to compare.
 *
 * `defaults` is used because there is no guarantee Info.plist stays XML — Tauri just happens
 * to write it as XML today, and if it ever switches to a binary plist, anything reading it
 * with a regex would silently stop working. `defaults` is always present on a Mac and reads
 * both formats.
 *
 * On Windows it is the file `centralu install` wrote beside the copy (see `windowsInstall`
 * for why not the exe's own version).
 */
function installedCopyVersion() {
  if (PLATFORM === 'win32') {
    try {
      return readFileSync(WIN.versionFile, 'utf8').trim()
    } catch {
      return null
    }
  }
  if (PLATFORM !== 'darwin' || !existsSync(INSTALLED)) return null
  try {
    const out = execFileSync('/usr/bin/defaults', ['read', join(INSTALLED, 'Contents/Info.plist'), 'CFBundleShortVersionString'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return out.trim()
  } catch {
    // Failing to read this is not worth mentioning — the app has already launched, and there
    // is nothing useful to say here.
    return null
  }
}

/**
 * One line, if the package and the /Applications copy have drifted apart.
 *
 * `npm i -g centralu` only changes the package. So a state quietly forms where the launcher is
 * new but the app that opens from Spotlight is old — this actually happened (beta.1 stayed in
 * /Applications while only the package moved to beta.3), and nothing on screen said so.
 *
 * **Says it, does not do it.** The same rule as the in-app update line. Overwriting someone's
 * /Applications without asking is the exact reason this package keeps `install` as a separate
 * step.
 */
function notifyIfCopyStale() {
  const version = installedCopyVersion()
  if (!copyDiffers(pkg.version, version)) return
  const where = PLATFORM === 'win32' ? WIN.dir : '/Applications'
  console.log(`\nThe ${where} copy is ${version} (this package is ${pkg.version}).\n  centralu install`)
}

/** Only announced after the app has launched — checking for updates must never delay startup. */
async function notifyIfOutdated() {
  // Every failure here is **swallowed entirely.** Someone who came here to launch the app has
  // no reason to be told about registry troubles.
  const res = await latestVersion()
  if (res.ok && isNewer(res.version, pkg.version)) {
    console.log(`\nA new version is available: ${pkg.version} → ${res.version}\n  centralu update`)
  }
}

const HELP = `${APP_NAME} ${pkg.version}

  centralu              Launches the app
  centralu install      Registers it in the app list (macOS: /Applications, Linux: a menu entry,
                        Windows: %LOCALAPPDATA%\\Programs\\Centralu and a Start menu shortcut)
  centralu uninstall    Removes that registration (conversation history is kept)
  centralu update       Upgrades if a new version is available
  centralu serve        Runs the host alone on this machine, for the app on another computer
                        to reach over SSH (\`centralu serve --help\`)
  centralu --version    Prints the version

Requires: Node 22+, and the claude or codex CLI (the app's first screen reports the status)`

const [cmd, ...rest] = process.argv.slice(2)
switch (cmd) {
  case 'install':
    install()
    break
  case 'uninstall':
    uninstall()
    break
  case 'update':
    await update()
    break
  case 'serve': {
    // No update notice here: `--connection`'s stdout is read by a program, and a foreground
    // server's terminal is a log.
    const args = parseServeArgs(rest)
    if (args.error) {
      console.error(args.error)
      process.exit(2)
    }
    if (args.mode === 'help') {
      console.log(SERVE_HELP)
      break
    }
    try {
      if (args.mode === 'rotate') {
        process.exitCode = rotateToken({ env: process.env, home: HOME })
        break
      }
      // A launcher `--detach` started: what it carried (the data folder, a host entry) applies before
      // anything below reads the environment
      const spec = args.child !== undefined ? decodeChildSpec(args.child) : null
      if (args.child !== undefined && !spec) {
        console.error('centralu serve: --detached-child is how --detach starts serve; this one could not be read')
        process.exit(2)
      }
      if (spec) Object.assign(process.env, spec.env)
      // realpath: npm's bin is a symlink to this file, and the launcher must not depend on the link
      const opts = { env: process.env, home: HOME, entry: requireHostEntry(), version: pkg.version, cliPath: realpathSync(process.argv[1]) }
      if (args.mode === 'connection') process.exitCode = await printConnection(opts)
      else if (args.mode === 'detach') process.exitCode = await runDetach({ ...opts, port: args.port })
      else if (args.mode === 'stop') process.exitCode = await runStop(opts)
      else if (spec) process.exitCode = await runDetachedChild({ ...opts, spec, port: args.port })
      else process.exitCode = await runServe({ ...opts, port: args.port })
    } catch (e) {
      // A state file that cannot be read or written: one sentence, not a stack, and nothing on stdout
      console.error(`centralu serve: ${e?.message ?? e}`)
      process.exitCode = 1
    }
    break
  }
  case '--version':
  case '-v':
    console.log(pkg.version)
    break
  case '--help':
  case '-h':
  case 'help':
    console.log(HELP)
    break
  default: {
    // Started before the update check, never after it: the check must not delay startup.
    const launched = run(cmd ? [cmd, ...rest] : [])
    notifyIfCopyStale()
    await Promise.all([launched, notifyIfOutdated()])
  }
}
