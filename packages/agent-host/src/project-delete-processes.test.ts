import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolName } from '@cc/protocol'
import type { AgentAdapter } from './adapters/contract.js'
import { CommandRunner } from './dev-services/commands.js'
import { Store } from './dev-services/store.js'
import { TerminalService } from './dev-services/terminal.js'
import { SessionManager } from './sessions/manager.js'
import { createRpcHandler } from './rpc.js'

/**
 * Deleting a project also ends its terminals and Run-menu executions (#177).
 *
 * Both use the path as their key, and the manager knows nothing about them. Previously
 * `projects.delete` called only the manager, so the deleted project's dev server kept holding its
 * port until the app quit, and re-adding the same folder brought the pre-deletion terminal back to
 * life in the list. Observed from the RPC door that the webview knocks on.
 *
 * The fake pty has no pid, so tree-kill falls back to `pty.kill(signal)` — that call is the proof
 * that it "ended." How the process tree is actually found is covered by kill-tree.test.ts against
 * real processes.
 */

type FakePty = { kill: ReturnType<typeof vi.fn> }

function fakePtyModule(spawned: FakePty[]) {
  return {
    spawn() {
      const inst = {
        kill: vi.fn(),
        write: vi.fn(),
        resize: vi.fn(),
        onData: () => {},
        onExit: () => {},
      }
      spawned.push(inst)
      return inst
    },
  }
}

let fixture = ''
let spawned: FakePty[] = []
let rpc: ReturnType<typeof createRpcHandler>

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-proj-del-')))
  mkdirSync(join(fixture, 'a'))
  mkdirSync(join(fixture, 'b'))
  spawned = []
  const store = new Store()
  const adapters = new Map<ToolName, AgentAdapter>()
  const mgr = new SessionManager(store, adapters, () => {})
  const terminals = new TerminalService(() => {})
  const commands = new CommandRunner(() => {})
  for (const svc of [terminals, commands]) {
    ;(svc as unknown as { loadPty: () => unknown }).loadPty = () => fakePtyModule(spawned)
  }
  rpc = createRpcHandler(mgr, adapters, { terminals, commands })
})

afterEach(() => {
  rmSync(fixture, { recursive: true, force: true })
})

describe('project deletion — terminals and executions', () => {
  it("a deleted project's terminals and executions end, and do not come back when the same folder is re-added", async () => {
    const a = (await rpc('projects.add', { path: join(fixture, 'a') })) as { id: string }
    const b = (await rpc('projects.add', { path: join(fixture, 'b') })) as { id: string }
    await rpc('terminal.create', { projectId: a.id, cols: 80, rows: 24 })
    await rpc('commands.run', { projectId: a.id, command: 'pnpm dev' })
    await rpc('terminal.create', { projectId: b.id, cols: 80, rows: 24 })
    await rpc('commands.run', { projectId: b.id, command: 'pnpm dev' })
    expect(spawned).toHaveLength(4)
    const [termA, runA, termB, runB] = spawned

    await rpc('projects.delete', { projectId: a.id })

    // The same first shot as the Stop button — anything that survives the grace period is collected
    // by tree-kill with SIGKILL
    // Windows has no signals: the pty is closed with kill() and no argument (kill-tree.ts, #14)
    const firstShot = process.platform === 'win32' ? [] : ['SIGTERM']
    expect(termA!.kill).toHaveBeenCalledWith(...firstShot)
    expect(runA!.kill).toHaveBeenCalledWith(...firstShot)
    // Does not touch the other project
    expect(termB!.kill).not.toHaveBeenCalled()
    expect(runB!.kill).not.toHaveBeenCalled()

    const again = (await rpc('projects.add', { path: join(fixture, 'a') })) as { id: string }
    expect(await rpc('terminal.list', { projectId: again.id })).toEqual({ terminals: [] })
    expect(await rpc('commands.state', { projectId: again.id })).toEqual({ runs: [] })
    expect(((await rpc('terminal.list', { projectId: b.id })) as { terminals: unknown[] }).terminals).toHaveLength(1)
    expect(((await rpc('commands.state', { projectId: b.id })) as { runs: unknown[] }).runs).toHaveLength(1)
  })
})
