import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
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
  // 진짜로 뜨는 앱 하나 — 중개의 RPC 문을 끝까지 두드린다
  plantApp(join(projRoot, ...PROJECT_APPS), 'live', {
    server: { command: process.execPath, args: [fileURLToPath(new URL('./apps/external/test-fixtures/app.mjs', import.meta.url)), '--mode', 'mediation'] },
  })

  store = new Store()
  const adapters = new Map<ToolName, AgentAdapter>()
  const mgr = new SessionManager(store, adapters, () => {})
  rt = new ExternalApps({ projects: () => store.projectRoots(), dataRoot: join(fixture, 'data'), reservedIds: ['control'] })
  rt.refresh()
  rpc = createRpcHandler(mgr, adapters, { externalApps: rt })
})

afterEach(async () => {
  await rt.dispose()
  rmSync(fixture, { recursive: true, force: true })
})

describe('외부 앱 RPC — 신뢰', () => {
  it('등록한 프로젝트의 앱은 신뢰하지 않은 채로 목록에 서고, 신뢰를 켜고 끄는 대로 따라간다', async () => {
    expect(await list()).toEqual([])
    const { id } = (await rpc('projects.add', { path: projRoot })) as { id: string }

    expect((await list()).filter((a) => a.appId === 'notes').map((a) => [a.appId, a.projectId, a.status])).toEqual([['notes', id, 'untrusted']])

    await rpc('projects.setTrusted', { projectId: id, trusted: true })
    expect(store.projectRoots()[0]?.trusted).toBe(true)
    expect((await list()).find((a) => a.appId === 'notes')?.status).toBe('stopped')

    await rpc('projects.setTrusted', { projectId: id, trusted: false })
    expect((await list()).find((a) => a.appId === 'notes')?.status).toBe('untrusted')

    await rpc('projects.delete', { projectId: id })
    expect(await list()).toEqual([])
  })

  it('apps.restart는 발견된 앱에만 닿는다 — 없는 앱은 이름과 함께 거절한다', async () => {
    const { id } = (await rpc('projects.add', { path: projRoot })) as { id: string }
    await expect(rpc('apps.restart', { appId: 'notes', projectId: id })).resolves.toEqual({ ok: true })
    await expect(rpc('apps.restart', { appId: 'ghost', projectId: id })).rejects.toThrow(/그런 앱이 없습니다: .*\/ghost/)
  })

  it('없는 프로젝트의 신뢰는 조용히 성공하지 않는다', async () => {
    await expect(rpc('projects.setTrusted', { projectId: 'nope', trusted: true })).rejects.toThrow(/Project not found/)
  })
})

describe('외부 앱 RPC — apps.invoke는 내장과 외부가 같은 문이다', () => {
  it('projectId를 주면 외부 앱의 중개로 간다 — 호출자는 화면이고, 앱의 답이 그대로 실린다', async () => {
    const { id } = (await rpc('projects.add', { path: projRoot })) as { id: string }
    await rpc('projects.setTrusted', { projectId: id, trusted: true })

    const ok = (await rpc('apps.invoke', { appId: 'live', projectId: id, name: 'app_only', args: {} })) as Record<string, unknown>
    expect(ok).toMatchObject({ text: 'app_only ran', isError: false, status: 'ok', result: { content: [{ type: 'text', text: 'app_only ran' }] } })
    expect(ok.runId).toMatch(/^run_/)

    // 화면에 열리지 않은 도구 — host가 앱에 보내지 않고 이유를 말한다
    const refused = (await rpc('apps.invoke', { appId: 'live', projectId: id, name: 'model_only', args: {} })) as Record<string, unknown>
    expect(refused).toMatchObject({ status: 'rejected', isError: true })
    expect(refused.text).toContain('visibility')
    expect(refused.result).toBeUndefined()
  })

  it('projectId 없이 내장 앱의 id면 예전 길 그대로 — 내장 앱의 도구가 돈다', async () => {
    const out = (await rpc('apps.invoke', { appId: 'control', name: 'control_notify', args: { text: '사람이 봐야 할 일' } })) as {
      text: string
      isError?: boolean
    }
    expect(out.isError).toBeFalsy()
    const state = (await rpc('apps.state', { appId: 'control' })) as { doc: { notifies?: { text: string }[] } }
    expect(state.doc.notifies?.map((n) => n.text)).toContain('사람이 봐야 할 일')
  })
})
