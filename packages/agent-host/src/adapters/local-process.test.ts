import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

describe.skipIf(!unix)('an agent CLI started without a keeper (macOS, Linux)', () => {
  it('leads a process group of its own, not the host’s', async () => {
    const p = spawnLocalAgent({ ...fakeAgentCli(), env: process.env })
    started.push(await helperPid(p.stdout), p.pid!)
    const pgid = (pid: number) => Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim())
    expect(pgid(p.pid!)).toBe(p.pid)
    expect(pgid(p.pid!)).not.toBe(pgid(process.pid))
    const exited = exitOf(p)
    p.kill('SIGKILL')
    await exited
  })

  it('TERM ends the helper a CLI leaves behind when it dies of it', async () => {
    const p = spawnLocalAgent({ ...fakeAgentCli(), env: process.env })
    const helper = await helperPid(p.stdout)
    started.push(helper)
    const exited = exitOf(p)
    expect(p.kill('SIGTERM')).toBe(true)
    expect(await exited).toEqual([null, 'SIGTERM'])
    expect(await goneWithin(helper, 5000)).toBe(true)
  })

  it('a CLI and a helper that ignore TERM are KILLed once the grace is over', async () => {
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

  it('a CLI that exits by itself does not leave its helper running', async () => {
    const p = spawnLocalAgent({ ...fakeAgentCli({ crash: true }), env: process.env })
    const helper = await helperPid(p.stdout)
    started.push(helper)
    expect(await exitOf(p)).toEqual([3, null])
    expect(await goneWithin(helper, 5000)).toBe(true)
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
      expect(await goneWithin(helper, 5000)).toBe(true)
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
