import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { KILL_GRACE_MS, type WinProcRow } from '../dev-services/kill-tree.js'
import { CodexClient } from './codex/client.js'
import { alive, fakeAgentCli, goneWithin, helperPid, killLeftovers } from './fake-agent-cli.test-helpers.js'
import { spawnLocalAgent } from './local-process.js'

/**
 * An agent CLI this host starts itself, without a keeper (Windows, dev, e2e, a debug app): stopping
 * it, or its exit, also ends the helpers it started (a language server and its `tsserver`, MCP
 * servers), which used to be left running under launchd/init. Real processes: what is being tested
 * is exactly which processes a signal reaches.
 */

const unix = process.platform !== 'win32'
// Real process trees: a node start costs seconds on a loaded machine, and every wait below is bounded on its own
vi.setConfig({ testTimeout: 30_000 })
const started: number[] = []
afterEach(() => killLeftovers(started))

function exitOf(p: { once(e: 'exit', l: (code: number | null, signal: NodeJS.Signals | null) => void): unknown }) {
  return new Promise<[number | null, NodeJS.Signals | null]>((r) => p.once('exit', (c, s) => r([c, s])))
}

describe('an agent CLI started without a keeper, for real', () => {
  // Windows has no process groups: a stop there is `taskkill /T` on the tree (the tests below)
  it.skipIf(!unix)('leads a process group of its own, not the host’s', async () => {
    const p = spawnLocalAgent({ ...fakeAgentCli(), env: process.env })
    started.push(await helperPid(p.stdout), p.pid!)
    const pgid = (pid: number) => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
    expect(pgid(p.pid!)).toBe(p.pid)
    expect(pgid(p.pid!)).not.toBe(pgid(process.pid))
    const exited = exitOf(p)
    p.kill('SIGKILL')
    await exited
  })

  // Windows has no TERM to die of; its stop is the next test but one
  it.skipIf(!unix)('TERM ends the helper a CLI leaves behind when it dies of it', async () => {
    const p = spawnLocalAgent({ ...fakeAgentCli(), env: process.env })
    const helper = await helperPid(p.stdout)
    started.push(helper)
    const exited = exitOf(p)
    expect(p.kill('SIGTERM')).toBe(true)
    expect(await exited).toEqual([null, 'SIGTERM'])
    expect(await goneWithin(helper, 5000)).toBe(true)
  })

  // Windows has no TERM to ignore and no grace: its one shot is already forceful
  it.skipIf(!unix)('a CLI and a helper that ignore TERM are KILLed once the grace is over', async () => {
    const p = spawnLocalAgent({ ...fakeAgentCli({ ignoreTerm: true }), env: process.env })
    const helper = await helperPid(p.stdout)
    started.push(helper, p.pid!)
    const exited = exitOf(p)
    p.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 300))
    expect(alive(p.pid!) && alive(helper)).toBe(true)
    expect(await exited).toEqual([null, 'SIGKILL'])
    expect(await goneWithin(helper, KILL_GRACE_MS + 3000)).toBe(true)
  })

  it.runIf(!unix)('Windows: a stop is taskkill on the tree, which ends the CLI and its helper', async () => {
    const p = spawnLocalAgent({ ...fakeAgentCli(), env: process.env })
    const helper = await helperPid(p.stdout)
    started.push(helper, p.pid!)
    const exited = exitOf(p)
    expect(p.kill('SIGTERM')).toBe(true)
    // `taskkill /F` ends a process with exit code 1; Windows has no signal to report
    expect(await exited).toEqual([1, null])
    // Gone already: `/T` ended it with the CLI. The sweep after an exit would also find it, but only
    // once its process listing is back, which takes PowerShell most of a second to start
    expect(alive(helper)).toBe(false)
  })

  it('a CLI that exits by itself does not leave its helper running', async () => {
    const p = spawnLocalAgent({ ...fakeAgentCli({ crash: true }), env: process.env })
    const helper = await helperPid(p.stdout)
    started.push(helper)
    expect(await exitOf(p)).toEqual([3, null])
    // Windows finds it by a process listing through PowerShell, which alone takes most of a second
    expect(await goneWithin(helper, unix ? 5000 : 15_000)).toBe(true)
  })

  it('codex closed with stdin EOF does not leave its helper running', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc-codex-helper-'))
    try {
      const pidFile = join(dir, 'helper.pid')
      const ended = new Promise<void>((resolve) => {
        const client = new CodexClient(
          { onNotification: () => {}, onServerRequest: () => {}, onExit: () => resolve() },
          { command: process.execPath, args: fakeAgentCli({ pidFile }).args },
        )
        const wait = setInterval(() => {
          if (!existsSync(pidFile)) return
          clearInterval(wait)
          void client.dispose()
        }, 20)
      })
      await ended
      const helper = Number(readFileSync(pidFile, 'utf8'))
      started.push(helper)
      expect(await goneWithin(helper, unix ? 5000 : 15_000)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * How `npm i -g` installs a CLI on Windows: a `.cmd` batch file that Node will not spawn without a
 * shell, and cmd.exe would read `%`, `^`, `&` and quotes in the arguments as its own. The shim is
 * read for the script it starts (tool-launch.ts), so the arguments reach the CLI as they were
 * given, from a folder whose name has spaces and Korean in it, as a Windows user folder can.
 */
describe.runIf(!unix)('an agent CLI installed as an npm .cmd shim (Windows)', () => {
  it('starts without a shell, and its arguments and working folder arrive intact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cc shim 한글 '))
    try {
      const entry = join(dir, 'npm', 'node_modules', 'fake-cli', 'bin', 'cli.js')
      mkdirSync(dirname(entry), { recursive: true })
      writeFileSync(
        entry,
        [
          "const { writeFileSync } = require('node:fs')",
          'const [out, ...rest] = process.argv.slice(2)',
          'writeFileSync(out, JSON.stringify({ args: rest, cwd: process.cwd() }))',
          "process.stdin.on('end', () => process.exit(0))",
          'process.stdin.resume()',
        ].join('\n'),
      )
      // What npm's cmd-shim writes, line for line
      const shim = join(dir, 'npm', 'fake-cli.cmd')
      writeFileSync(
        shim,
        [
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
          'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fake-cli\\bin\\cli.js" %*',
          '',
        ].join('\r\n'),
      )
      const cwd = join(dir, '프로젝트 폴더')
      mkdirSync(cwd)
      const out = join(dir, 'seen.json')
      const args = ['with space', 'a "quoted" word', '한글 인자', '%PATH%', 'a^b&c|d<e>f', 'ends with a backslash\\', '']
      const ended = new Promise<boolean>((resolve) => {
        const client = new CodexClient(
          { onNotification: () => {}, onServerRequest: () => {}, onExit: (_code, expected) => resolve(expected) },
          { command: shim, args: [out, ...args], cwd },
        )
        const wait = setInterval(() => {
          if (!existsSync(out)) return
          clearInterval(wait)
          void client.dispose()
        }, 20)
      })
      expect(await ended).toBe(true)
      expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ args, cwd })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

/**
 * Windows has no groups: the tree goes with `taskkill /T /F`, and what the CLI left running after
 * it exited is found by parent links and creation times. The OS is a parameter, so this runs
 * anywhere; the child is real, the process table and taskkill are not.
 */
describe('an agent CLI started without a keeper (Windows)', () => {
  it('a stop is taskkill on its tree, and its exit collects what it left running', async () => {
    const killed: number[] = []
    let listed = 0
    let orphan = 0
    const os = {
      platform: 'win32' as const,
      taskkill: (pid: number) => void killed.push(pid),
      listProcesses: async (): Promise<WinProcRow[]> => {
        listed++
        return [{ pid: orphan, ppid: p.pid!, created: Date.now() - 50 }]
      },
    }
    const p = spawnLocalAgent({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], env: process.env }, os)
    orphan = p.pid! + 100_000
    started.push(p.pid!)
    // Long enough for the orphan's creation time (50 ms before the listing) to fall inside its life
    await new Promise((r) => setTimeout(r, 150))
    const exited = exitOf(p)
    expect(p.kill('SIGTERM')).toBe(true)
    await exited
    expect(killed[0]).toBe(p.pid)
    await new Promise((r) => setTimeout(r, 100))
    expect(listed).toBe(1)
    expect(killed).toEqual([p.pid, orphan])
  })
})

/** A Korean or emoji crash reason came out as `��` when a pipe chunk ended inside a character (#428) */
describe('the stderr an agent CLI leaves for a failure message', () => {
  it('keeps a character whole when the pipe splits it between two chunks', async () => {
    const script = "const b = Buffer.from('실패: 한글\\n'); process.stderr.write(b.subarray(0, 4)); setTimeout(() => process.stderr.write(b.subarray(4)), 200)"
    const p = spawnLocalAgent({ command: process.execPath, args: ['-e', script], env: process.env })
    started.push(p.pid!)
    await exitOf(p)
    expect(p.stderrTail()).toBe('실패: 한글\n')
  })
})
