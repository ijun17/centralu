/**
 * The two launchers and the install they reach: `<data>/bin/centralu` that `serve` keeps for an npm
 * install, and the managed install the hub writes over ssh (`<data>/remote/`, docs/plans/remote-hub.md
 * §10.1), with the launcher that never changes and the pointers it reads.
 */
import { chmodSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { replaceFile, say } from './serve-util.mjs'

/**
 * The launcher `serve` keeps at `<data folder>/bin/centralu` (`centralu.cmd` on Windows).
 *
 * The client runs `ssh -T -o BatchMode=yes <target> centralu …`, and a non-interactive SSH shell
 * reads no profile: npm's global bin under nvm, fnm, volta or `~/.npm-global` is not on its PATH,
 * and often neither is `node`. So the plain name fails with exit 127, and the person, who just ran
 * `centralu serve` in their own shell, sees no reason why. This file names both by absolute path,
 * so `~/.centralu/bin/centralu` works from any shell. It is rewritten whenever it differs from
 * what this run would write, which follows a Node upgrade or a moved npm prefix on the next start.
 */
export function launcherScript(platform, execPath, cliPath) {
  if (platform === 'win32') {
    // A batch file reads every % as the start of a variable (`100% cli.mjs" %*` came out as `100*`); %% is a literal one
    const lit = (v) => String(v).replaceAll('%', '%%')
    /*
     * The file is UTF-8, and cmd.exe reads each line of a batch file in the console's code page as it reaches it: 949
     * on a Korean Windows, where a profile folder named in Korean came out as other characters and node found no
     * centralu.mjs there (#849). So the lines before the paths, all ASCII, switch the console to UTF-8 (65001), and the
     * code page it had is put back on the line with the paths, ahead of node: cmd.exe reads and decodes a whole line
     * before it runs any of it, so the paths are already read as UTF-8 by then. The console is the shell's that ran
     * this, and node runs on the page it had; a Ctrl+C answered at "Terminate batch job (Y/N)?" ends this file
     * before any later line, and a restore there was skipped. chcp is named by its full path: the shell's PATH may
     * not have System32 on it.
     */
    return [
      '@echo off',
      "rem Written by `centralu serve`: reaches this install without npm's folder on PATH.",
      'setlocal',
      'set "CENTRALU_CP="',
      `for /f "tokens=2 delims=:." %%c in ('%SystemRoot%\\System32\\chcp.com') do set /a "CENTRALU_CP=%%c" >nul 2>&1`,
      '%SystemRoot%\\System32\\chcp.com 65001 >nul 2>&1',
      `(if defined CENTRALU_CP %SystemRoot%\\System32\\chcp.com %CENTRALU_CP% >nul 2>&1) & "${lit(execPath)}" "${lit(cliPath)}" %*`,
      'exit /b %ERRORLEVEL%',
      '',
    ].join('\r\n')
  }
  const q = (v) => `'${String(v).replaceAll("'", "'\\''")}'`
  return (
    '#!/bin/sh\n' +
    "# Written by `centralu serve`: reaches this install from a shell whose PATH has neither npm's global\n" +
    '# folder nor node (a non-interactive SSH session). Rewritten when node or the package moves.\n' +
    `exec ${q(execPath)} ${q(cliPath)} "$@"\n`
  )
}

/** Writes the launcher if it is missing or out of date. Returns its path. Never fatal to the caller */
export function ensureLauncher(dataDir, { platform = process.platform, execPath = process.execPath, cliPath }) {
  const file = join(dataDir, 'bin', platform === 'win32' ? 'centralu.cmd' : 'centralu')
  const want = launcherScript(platform, execPath, cliPath)
  let have = null
  try {
    have = readFileSync(file, 'utf8')
  } catch {
    // not there yet
  }
  if (have !== want) {
    mkdirSync(dirname(file), { recursive: true })
    replaceFile(file, want, { mode: 0o755 })
  }
  if (platform !== 'win32' && (statSync(file).mode & 0o777) !== 0o755) chmodSync(file, 0o755)
  return file
}

/**
 * ensureLauncher, with a failure said on stderr instead of thrown: the launcher is a convenience.
 *
 * Not under the managed launcher (`CENTRALU_MANAGED=1`, docs/plans/remote-hub.md §10.1): an install
 * the hub made over ssh has its own launcher in `<data>/remote/bin/`, which reads `current`. Writing
 * `<data>/bin/centralu` from there would point an npm install's launcher at one managed version, and
 * the two would rewrite each other's file on every start.
 */
export function keepLauncher(dataDir, cliPath, env) {
  if (!cliPath || env?.CENTRALU_MANAGED === '1') return
  try {
    ensureLauncher(dataDir, { cliPath })
  } catch (e) {
    say(`could not write the launcher in ${join(dataDir, 'bin')}: ${e.message}`)
  }
}

/**
 * The install the hub manages on this machine (docs/plans/remote-hub.md §10.1): side-by-side
 * versions, the pinned Node they run on, and two pointer files naming what runs and what to roll
 * back to. The hub's installer writes it; `serve` only reads it.
 */
export function remoteLayout(dataDir) {
  const root = join(dataDir, 'remote')
  return {
    root,
    current: join(root, 'current'),
    previous: join(root, 'previous'),
    versions: join(root, 'versions'),
    node: join(root, 'node'),
    bin: join(root, 'bin'),
  }
}

/** A word a pointer file may hold: a folder name, nothing a path could escape with */
const POINTER_WORD = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/

/** `current` / `previous`: one line, "<centralu version> <node version>". null for anything else */
export function parsePointer(text) {
  const m = /^\s*(\S+)[ \t]+(\S+)\s*$/.exec(String(text ?? ''))
  if (!m || !POINTER_WORD.test(m[1]) || !POINTER_WORD.test(m[2])) return null
  return { version: m[1], node: m[2] }
}

/**
 * Where a managed version came from, from its `install.json`: `{ kind: 'dev', commit, dirty }` for a dev build put
 * there from a git commit (`pnpm remote-dev`, #1036), null for a release (or anything unreadable). The hub shows it
 * on the machine's row, so a build no release produced is never mistaken for one.
 */
export function installSource(versionDir) {
  try {
    const s = JSON.parse(readFileSync(join(versionDir, 'install.json'), 'utf8')).source
    if (s?.kind === 'dev' && typeof s.commit === 'string' && /^[0-9a-f]{7,64}$/.test(s.commit)) return { kind: 'dev', commit: s.commit, dirty: s.dirty === true }
  } catch {
    // no install.json, or not one this reads
  }
  return null
}

/**
 * The connection line's `install` field (docs/plans/remote-hub.md §10.5): whether this command was
 * started by the managed launcher, the managed install's `current` and `previous`, and the Node
 * running this command. Read from the machine at every ask, never kept by the hub (S12).
 */
export function installInfo(dataDir, env, nodeVersion = process.versions.node) {
  const l = remoteLayout(dataDir)
  const read = (file) => {
    let p
    try {
      p = parsePointer(readFileSync(file, 'utf8'))
    } catch {
      return null
    }
    const source = p && installSource(join(l.versions, p.version))
    return p && source ? { ...p, source } : p
  }
  return { managed: env.CENTRALU_MANAGED === '1', current: read(l.current), previous: read(l.previous), node: nodeVersion }
}

/**
 * The managed launcher, `<data>/remote/bin/centralu` (`centralu.cmd` on Windows), as the installer
 * writes it (docs/plans/remote-hub.md §10.1, S8).
 *
 * **Its text never changes.** It reads `current` at every start and runs that version's
 * `centralu.mjs` on that version's Node, so switching versions is one file replaced by a rename,
 * atomic on both systems. A launcher rewritten per version would be replaced while it may be
 * running, and cmd.exe reads a batch file by offset as it runs. It sets `CENTRALU_MANAGED=1`, so
 * the `serve` it starts leaves `<data>/bin/` to an npm install on the same machine.
 *
 * Both refuse a pointer that holds anything but plain version words, so an edited `current` cannot
 * point it outside the install.
 */
export function managedLauncherScript(platform) {
  if (platform === 'win32') {
    return (
      [
        '@echo off',
        'rem The Centralu launcher for the install the app manages over SSH. It never changes: it reads',
        'rem "current" at every start, so switching versions replaces that file and never this one.',
        'setlocal',
        'set "CENTRALU_REMOTE=%~dp0.."',
        'set "CENTRALU_LINE="',
        'set "CENTRALU_V="',
        'set "CENTRALU_N="',
        'set /p CENTRALU_LINE=<"%CENTRALU_REMOTE%\\current"',
        'for /f "tokens=1,2" %%a in ("%CENTRALU_LINE%") do (set "CENTRALU_V=%%a" & set "CENTRALU_N=%%b")',
        'if not defined CENTRALU_N goto none',
        'echo %CENTRALU_V% %CENTRALU_N%| findstr /r /c:"^[0-9A-Za-z][0-9A-Za-z.+-]* [0-9A-Za-z][0-9A-Za-z.+-]*$" >nul || goto none',
        'set CENTRALU_MANAGED=1',
        '"%CENTRALU_REMOTE%\\node\\v%CENTRALU_N%\\node.exe" "%CENTRALU_REMOTE%\\versions\\%CENTRALU_V%\\node_modules\\centralu\\bin\\centralu.mjs" %*',
        'exit /b %ERRORLEVEL%',
        ':none',
        'echo Centralu: no version is installed in %CENTRALU_REMOTE% 1>&2',
        'exit /b 1',
      ].join('\r\n') + '\r\n'
    )
  }
  return [
    '#!/bin/sh',
    '# The Centralu launcher for the install the app manages over SSH. It never changes: it reads',
    '# `current` at every start, so switching versions replaces that file and never this one.',
    'remote=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P) || exit 1',
    'v= n=',
    'read -r v n < "$remote/current" 2>/dev/null',
    'case "$v" in ""|[!0-9A-Za-z]*|*[!0-9A-Za-z.+-]*) echo "Centralu: no version is installed in $remote" >&2; exit 1 ;; esac',
    'case "$n" in ""|[!0-9A-Za-z]*|*[!0-9A-Za-z.+-]*) echo "Centralu: no version is installed in $remote" >&2; exit 1 ;; esac',
    'CENTRALU_MANAGED=1',
    'export CENTRALU_MANAGED',
    'exec "$remote/node/v$n/bin/node" "$remote/versions/$v/node_modules/centralu/bin/centralu.mjs" "$@"',
    '',
  ].join('\n')
}
