import { afterEach, describe, expect, it } from 'vitest'
import { __forgetPrograms, launchFor, nodeShimEntry, programPath, resolveCommand, shimTarget } from './tool-launch.js'

/**
 * Windows (#14), simulated. Node refuses to spawn a `.cmd` without a shell, and a shell would read
 * the JSON and prompts in our arguments as its own syntax, so a package manager's batch shim is
 * read for the program it starts.
 */

// npm 10's cmd-shim output for `npm i -g @openai/codex`.
const NPM_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
].join('\r\n')

// pnpm's (@zkochan/cmd-shim) for a global install.
const PNPM_SHIM = [
  '@SETLOCAL',
  '@IF NOT DEFINED NODE_PATH (',
  '  @SET "NODE_PATH=C:\\Users\\me\\AppData\\Local\\pnpm\\global\\5\\node_modules"',
  ')',
  '@IF EXIST "%~dp0\\node.exe" (',
  '  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ') ELSE (',
  '  @SET PATHEXT=%PATHEXT:;.JS;=;%',
  '  node  "%~dp0\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ')',
].join('\r\n')

// npm's shim for a package whose bin is an executable.
const EXE_SHIM = '@ECHO off\r\nGOTO start\r\n:start\r\n"%dp0%\\node_modules\\tool\\bin\\tool.exe"   %*\r\n'

/**
 * The `npm.cmd` Node's Windows installer puts beside `node.exe`, as read on Windows 11 with Node
 * 24.21 (2026-10-08). Not cmd-shim output: it starts a variable, after asking npm for the global
 * prefix in case a newer npm was installed there. `npx.cmd` is the same with `npx-cli.js`.
 */
const nodeDistShim = (cli: 'npm' | 'npx') => {
  const V = cli.toUpperCase()
  return [
    ":: Created by npm, please don't edit manually.",
    '@ECHO OFF',
    '',
    'SETLOCAL',
    '',
    'SET "NODE_EXE=%~dp0\\node.exe"',
    'IF NOT EXIST "%NODE_EXE%" (',
    '  SET "NODE_EXE=node"',
    ')',
    '',
    'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
    `SET "${V}_CLI_JS=%~dp0\\node_modules\\npm\\bin\\${cli}-cli.js"`,
    `FOR /F "delims=" %%F IN ('CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"') DO (`,
    `  SET "NPM_PREFIX_${V}_CLI_JS=%%F\\node_modules\\npm\\bin\\${cli}-cli.js"`,
    ')',
    `IF EXIST "%NPM_PREFIX_${V}_CLI_JS%" (`,
    `  SET "${V}_CLI_JS=%NPM_PREFIX_${V}_CLI_JS%"`,
    ')',
    '',
    `"%NODE_EXE%" "%${V}_CLI_JS%" %*`,
    '',
  ].join('\r\n')
}

const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const deps = (files: Record<string, string>, platform: NodeJS.Platform = 'win32', prefix: string | null = null) => ({
  platform,
  read: (p: string) => {
    if (!(p in files)) throw new Error(`ENOENT ${p}`)
    return files[p]!
  },
  exists: (p: string) => p in files,
  node: NODE,
  runJs: (script: string) => (script.endsWith('npm-prefix.js') && prefix !== null ? `${prefix}\r\n` : null),
})

describe('reading a batch shim for the program it starts', () => {
  it('npm: the .js entry, skipping the optional node.exe beside the shim', () => {
    expect(shimTarget(NPM_SHIM)).toBe('node_modules\\@openai\\codex\\bin\\codex.js')
  })

  it('pnpm: the same, written with %~dp0', () => {
    expect(shimTarget(PNPM_SHIM)).toBe('global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js')
  })

  it('a file that is not a shim names nothing', () => {
    expect(shimTarget('@echo off\r\necho hello\r\n')).toBeNull()
  })
})

describe('how a tool found on PATH is started', () => {
  const dir = 'C:\\Users\\me\\AppData\\Roaming\\npm'
  const entry = `${dir}\\node_modules\\@openai\\codex\\bin\\codex.js`

  it("a .js behind an npm shim runs through the host's own Node, ahead of the tool's arguments", () => {
    const launch = launchFor(`${dir}\\codex.cmd`, deps({ [`${dir}\\codex.cmd`]: NPM_SHIM, [entry]: '' }))
    expect(launch).toEqual({ command: NODE, args: [entry] })
  })

  it('an .exe behind a shim is started directly', () => {
    const exe = `${dir}\\node_modules\\tool\\bin\\tool.exe`
    expect(launchFor(`${dir}\\tool.cmd`, deps({ [`${dir}\\tool.cmd`]: EXE_SHIM, [exe]: '' }))).toEqual({
      command: exe,
      args: [],
    })
  })

  it('a native executable is started as it is', () => {
    const exe = 'C:\\Users\\me\\.local\\bin\\claude.exe'
    expect(launchFor(exe, deps({ [exe]: '' }))).toEqual({ command: exe, args: [] })
  })

  it('a shim whose target is gone is left alone, so the spawn error names the real file', () => {
    expect(launchFor(`${dir}\\codex.cmd`, deps({ [`${dir}\\codex.cmd`]: NPM_SHIM }))).toEqual({
      command: `${dir}\\codex.cmd`,
      args: [],
    })
  })

  it('off Windows nothing is rewritten', () => {
    expect(launchFor('/usr/local/bin/codex', deps({}, 'darwin'))).toEqual({ command: '/usr/local/bin/codex', args: [] })
  })
})

describe('a program the host runs in a project folder', () => {
  afterEach(() => __forgetPrograms())

  it('on Windows git is spawned by its absolute path, so a git.exe at a repository root is never the one run', () => {
    const git = 'C:\\Program Files\\Git\\cmd\\git.exe'
    expect(programPath('git', 'win32', (n) => (n === 'git' ? git : null))).toBe(git)
  })

  it('a found path is remembered; a miss is asked again', () => {
    let asked = 0
    const find = () => (++asked > 1 ? 'C:\\Git\\cmd\\git.exe' : null)
    expect(programPath('git', 'win32', find)).toBe('git')
    expect(programPath('git', 'win32', find)).toBe('C:\\Git\\cmd\\git.exe')
    expect(programPath('git', 'win32', find)).toBe('C:\\Git\\cmd\\git.exe')
    expect(asked).toBe(2)
  })

  it('off Windows the bare name, as before', () => {
    expect(programPath('git', 'darwin', () => '/opt/homebrew/bin/git')).toBe('git')
  })
})

describe("Node's own npm.cmd and npx.cmd", () => {
  const nodeDir = 'C:\\Program Files\\nodejs'
  const npmCli = `${nodeDir}\\node_modules\\npm\\bin\\npm-cli.js`
  const prefix = 'C:\\Users\\Jane Doe\\AppData\\Roaming\\npm'
  const prefixCli = `${prefix}\\node_modules\\npm\\bin\\npm-cli.js`
  const files = { [`${nodeDir}\\npm.cmd`]: nodeDistShim('npm'), [npmCli]: '' }

  it('are not cmd-shim output, so the quoted-path reading names nothing in them', () => {
    expect(shimTarget(nodeDistShim('npm'))).toBeNull()
  })

  it('npm.cmd starts npm-cli.js beside Node when the global prefix has no npm of its own', () => {
    expect(nodeShimEntry(nodeDistShim('npm'), nodeDir, deps(files, 'win32', prefix))).toBe(npmCli)
    expect(launchFor(`${nodeDir}\\npm.cmd`, deps(files, 'win32', prefix))).toEqual({ command: NODE, args: [npmCli] })
  })

  it('after `npm i -g npm`, the npm in the global prefix, as the batch file itself would choose', () => {
    const withPrefixNpm = { ...files, [prefixCli]: '' }
    expect(launchFor(`${nodeDir}\\npm.cmd`, deps(withPrefixNpm, 'win32', prefix))).toEqual({ command: NODE, args: [prefixCli] })
  })

  it('a prefix that cannot be asked for falls back to the npm beside Node', () => {
    const withPrefixNpm = { ...files, [prefixCli]: '' }
    expect(launchFor(`${nodeDir}\\npm.cmd`, deps(withPrefixNpm, 'win32', null))).toEqual({ command: NODE, args: [npmCli] })
  })

  it('`npm` by name, as the updater asks for it, becomes Node and npm-cli.js', () => {
    const env = { Path: `C:\\WINDOWS\\system32;${nodeDir}\\;${prefix}`, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    expect(resolveCommand('npm', env, deps(files, 'win32', prefix))).toEqual({ command: NODE, args: [npmCli] })
  })
})

describe("an app manifest's command on Windows", () => {
  const nodeDir = 'C:\\Program Files\\nodejs'
  const npxCli = `${nodeDir}\\node_modules\\npm\\bin\\npx-cli.js`
  const files = { [`${nodeDir}\\node.exe`]: '', [`${nodeDir}\\npx.cmd`]: nodeDistShim('npx'), [npxCli]: '' }
  const env = { PATH: `C:\\Windows\\System32;${nodeDir}` }

  it('`npx` becomes the program its batch file starts', () => {
    expect(resolveCommand('npx', env, deps(files))).toEqual({ command: NODE, args: [npxCli] })
  })

  it('`node` becomes the absolute node.exe on PATH, never one in the app folder', () => {
    expect(resolveCommand('node', env, deps(files))).toEqual({ command: `${nodeDir}\\node.exe`, args: [] })
  })

  it('a command not on PATH is left for the spawn to report', () => {
    expect(resolveCommand('uvx', env, deps(files))).toEqual({ command: 'uvx', args: [] })
  })

  it('off Windows the manifest command is spawned as written', () => {
    expect(resolveCommand('npx', env, deps(files, 'linux'))).toEqual({ command: 'npx', args: [] })
  })
})
