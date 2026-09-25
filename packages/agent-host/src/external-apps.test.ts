import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExternalAppInfo, ToolName } from '@cc/protocol'
import type { AgentAdapter } from './adapters/contract.js'
import { ExternalApps } from './apps/external/runtime.js'
import { PROJECT_APPS, plantApp } from './apps/external/test-helpers.js'
import { Store } from './dev-services/store.js'
import { SessionManager } from './sessions/manager.js'
import { createRpcHandler } from './rpc.js'

/**
 * 외부 앱의 RPC 문 (M4 A) — 웹뷰가 실제로 두드리는 자리에서 본다.
 *
 * 런타임 테스트(apps/external/*.test.ts)는 가짜 프로젝트 목록으로 돈다. 여기서는 진짜
 * 저장소와 매니저를 끼워서, 신뢰가 **저장소에 적히고 런타임이 그걸 읽는** 길이 이어져
 * 있는지를 본다 — 두 쪽이 각자 초록이어도 그 사이의 선이 끊겨 있을 수 있다.
 */

let fixture = ''
let projRoot = ''
let store: Store
let rt: ExternalApps
let rpc: ReturnType<typeof createRpcHandler>

const list = async () => (await rpc('apps.list', {})) as ExternalAppInfo[]

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-apps-rpc-')))
  projRoot = join(fixture, 'proj')
  mkdirSync(join(fixture, 'data'))
  mkdirSync(projRoot)
  plantApp(join(projRoot, ...PROJECT_APPS), 'notes')

  store = new Store()
  const adapters = new Map<ToolName, AgentAdapter>()
  const mgr = new SessionManager(store, adapters, () => {})
  rt = new ExternalApps({ projects: () => store.projectRoots(), dataRoot: join(fixture, 'data'), reservedIds: [] })
  rt.refresh()
  rpc = createRpcHandler(mgr, adapters, undefined, undefined, undefined, rt)
})

afterEach(() => {
  rt.dispose()
  rmSync(fixture, { recursive: true, force: true })
})

describe('외부 앱 RPC — 신뢰', () => {
  it('등록한 프로젝트의 앱은 신뢰하지 않은 채로 목록에 서고, 신뢰를 켜고 끄는 대로 따라간다', async () => {
    expect(await list()).toEqual([])
    const { id } = (await rpc('projects.add', { path: projRoot })) as { id: string }

    expect((await list()).map((a) => [a.appId, a.projectId, a.status])).toEqual([['notes', id, 'untrusted']])

    await rpc('projects.setTrusted', { projectId: id, trusted: true })
    expect(store.projectRoots()[0]?.trusted).toBe(true)
    expect((await list())[0]?.status).toBe('stopped')

    await rpc('projects.setTrusted', { projectId: id, trusted: false })
    expect((await list())[0]?.status).toBe('untrusted')

    await rpc('projects.delete', { projectId: id })
    expect(await list()).toEqual([])
  })

  it('없는 프로젝트의 신뢰는 조용히 성공하지 않는다', async () => {
    await expect(rpc('projects.setTrusted', { projectId: 'nope', trusted: true })).rejects.toThrow(/Project not found/)
  })
})
