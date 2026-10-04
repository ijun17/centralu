import { afterEach, describe, expect, it } from 'vitest'
import { __forgetPrograms, launchFor, programPath, resolveCommand, shimTarget } from './tool-launch.js'

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

const NODE = 'C:\\Program Files\\nodejs\\node.exe'
const deps = (files: Record<string, string>, platform: NodeJS.Platform = 'win32') => ({
  platform,
  read: (p: string) => {
    if (!(p in files)) throw new Error(`ENOENT ${p}`)
    return files[p]!
  },
  exists: (p: string) => p in files,
  node: NODE,
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

describe("an app manifest's command on Windows", () => {
  const nodeDir = 'C:\\Program Files\\nodejs'
  const npxCli = `${nodeDir}\\node_modules\\npm\\bin\\npx-cli.js`
  // The npx.cmd Node's installer ships has the npm shape.
  const NPX_SHIM = NPM_SHIM.replace('node_modules\\@openai\\codex\\bin\\codex.js', 'node_modules\\npm\\bin\\npx-cli.js')
  const files = { [`${nodeDir}\\node.exe`]: '', [`${nodeDir}\\npx.cmd`]: NPX_SHIM, [npxCli]: '' }
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
