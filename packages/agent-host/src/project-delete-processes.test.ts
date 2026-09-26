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
 * 프로젝트를 지우면 그 터미널과 Run 메뉴 실행도 끝난다 (#177).
 *
 * 둘 다 경로를 키로 쓰고 매니저는 이들을 모른다. 예전에는 `projects.delete`가 매니저만
 * 불러, 지운 프로젝트의 데브 서버가 앱을 끌 때까지 포트를 쥔 채 남았고, 같은 폴더를 다시
 * 추가하면 지우기 전의 터미널이 목록에 되살아났다. 웹뷰가 두드리는 RPC 문에서 본다.
 *
 * 가짜 pty에는 pid가 없어 트리 킬이 `pty.kill(신호)`로 물러난다 — 그 호출이 곧 "끝냈다"의
 * 증거다. 트리를 어떻게 찾는지는 kill-tree.test.ts가 진짜 프로세스로 본다.
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

describe('프로젝트 삭제 — 터미널과 실행', () => {
  it('지운 프로젝트의 터미널과 실행은 끝나고, 같은 폴더를 다시 추가해도 되살아나지 않는다', async () => {
    const a = (await rpc('projects.add', { path: join(fixture, 'a') })) as { id: string }
    const b = (await rpc('projects.add', { path: join(fixture, 'b') })) as { id: string }
    await rpc('terminal.create', { projectId: a.id, cols: 80, rows: 24 })
    await rpc('commands.run', { projectId: a.id, command: 'pnpm dev' })
    await rpc('terminal.create', { projectId: b.id, cols: 80, rows: 24 })
    await rpc('commands.run', { projectId: b.id, command: 'pnpm dev' })
    expect(spawned).toHaveLength(4)
    const [termA, runA, termB, runB] = spawned

    await rpc('projects.delete', { projectId: a.id })

    // Stop 단추와 같은 첫 발이다 — 유예 뒤 버틴 것은 트리 킬이 SIGKILL로 거둔다
    expect(termA!.kill).toHaveBeenCalledWith('SIGTERM')
    expect(runA!.kill).toHaveBeenCalledWith('SIGTERM')
    // 남의 프로젝트는 건드리지 않는다
    expect(termB!.kill).not.toHaveBeenCalled()
    expect(runB!.kill).not.toHaveBeenCalled()

    const again = (await rpc('projects.add', { path: join(fixture, 'a') })) as { id: string }
    expect(await rpc('terminal.list', { projectId: again.id })).toEqual({ terminals: [] })
    expect(await rpc('commands.state', { projectId: again.id })).toEqual({ runs: [] })
    expect(((await rpc('terminal.list', { projectId: b.id })) as { terminals: unknown[] }).terminals).toHaveLength(1)
    expect(((await rpc('commands.state', { projectId: b.id })) as { runs: unknown[] }).runs).toHaveLength(1)
  })
})
