import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AppRun, ToolName } from '@cc/protocol'
import type { AgentAdapter } from './adapters/contract.js'
import { storeRunLedger } from './app-run-ledger.js'
import { ExternalApps, type AppRef } from './apps/external/runtime.js'
import { PROJECT_APPS, plantApp, until } from './apps/external/test-helpers.js'
import { canonicalJson } from './apps/external/runs.js'
import { Store } from './dev-services/store.js'
import { SessionManager } from './sessions/manager.js'
import { createRpcHandler } from './rpc.js'

/**
 * 실행 기록 (M4 A-6) — 진짜 앱 프로세스, 진짜 저장소, host의 main과 같은 이음새(storeRunLedger).
 *
 * 기록의 약속: 호출마다 한 줄(거절도), 인자는 요약과 해시만, 비밀 값은 어디에도 없고, 실패한
 * 호출은 최근 20건만 원문이 남고, 30일이 지나면 걷힌다.
 */

const FIXTURE = fileURLToPath(new URL('./apps/external/test-fixtures/app.mjs', import.meta.url))
const SECRET = 'tok-9f8e7d6c5b4a'

let fixture = ''
let dataRoot = ''
let projRoot = ''
let store: Store
let rt: ExternalApps

const ref: AppRef = { projectId: 'p1', appId: 'notes' }
/** 앱에 실제로 보내진(열린) 실행이 생길 때까지 — 기록의 running 줄은 앱이 뜨기 전에 선다 */
const sentRun = () =>
  until(() => [...(rt as unknown as { openRuns: Map<string, unknown> }).openRuns.keys()][0], (id) => id !== undefined) as Promise<string>
const runs = () => rt.runs(ref, 500) as AppRun[]
const byId = (id: string) => runs().find((r) => r.id === id)!

const make = () => {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
    dataRoot,
    reservedIds: [],
    timing: { idleMs: 60_000, graceMs: 1_000, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
    runs: storeRunLedger(store),
  })
  rt.refresh()
  return rt
}

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-apps-runs-')))
  dataRoot = join(fixture, 'data')
  projRoot = join(fixture, 'proj')
  mkdirSync(dataRoot)
  mkdirSync(projRoot)
  plantApp(join(projRoot, ...PROJECT_APPS), 'notes', {
    server: { command: process.execPath, args: [FIXTURE, '--mode', 'mediation'] },
    secrets: ['FIXTURE_SECRET'],
  })
  store = new Store()
})

afterEach(async () => {
  await rt?.dispose()
  store.close()
  rmSync(fixture, { recursive: true, force: true })
})

describe('호출마다 한 줄', () => {
  it('누가 불렀는지(화면·세션·앱), 어느 도구를, 어떻게 끝났는지를 적는다 — 거절도 한 줄이다', async () => {
    make()
    const view = await rt.call(ref, 'echo', { text: 'hi' }, { kind: 'view' })
    const session = await rt.call(ref, 'fail', {}, { kind: 'session', sessionId: 's-42' })
    const refused = await rt.call(ref, 'model_only', {}, { kind: 'view' })

    expect(byId(view.runId)).toMatchObject({
      tool: 'echo', callerKind: 'view', callerSessionId: null, parentRunId: null, status: 'ok', error: null,
      argsSummary: '{"text":"hi"}', projectId: 'p1', appId: 'notes',
    })
    expect(byId(view.runId).durationMs).toBeGreaterThanOrEqual(0)
    expect(byId(view.runId).argsDigest).toMatch(/^[0-9a-f]{64}$/)
    expect(byId(session.runId)).toMatchObject({ callerKind: 'session', callerSessionId: 's-42', status: 'error', error: 'the thing failed' })
    expect(byId(refused.runId)).toMatchObject({ status: 'rejected', error: expect.stringContaining('visibility') })
  })

  it('부모 실행 id가 사슬로 남는다 (caller=app)', async () => {
    make()
    const ac = new AbortController()
    const parent = rt.call(ref, 'slow', {}, { kind: 'session', sessionId: 's1' }, { signal: ac.signal })
    const parentId = await sentRun()
    const child = await rt.call(ref, 'echo', { text: 'x' }, { kind: 'app', parentRunId: parentId })
    expect(byId(child.runId)).toMatchObject({ callerKind: 'app', parentRunId: parentId })
    ac.abort()
    await parent
  })

  it('도는 동안은 running이고, 취소되면 cancelled로 닫힌다', async () => {
    make()
    const ac = new AbortController()
    const p = rt.call(ref, 'slow', {}, { kind: 'session', sessionId: 's1' }, { signal: ac.signal })
    const sent = await sentRun()
    expect(byId(sent)).toMatchObject({ status: 'running', durationMs: null })
    ac.abort()
    const out = await p
    expect(byId(out.runId)).toMatchObject({ status: 'cancelled' })
  })

  it('앱이 뜨는 동안 취소된 호출은 앱에 보내지 않고 cancelled로 닫힌다', async () => {
    make()
    const ac = new AbortController()
    const t0 = Date.now()
    const p = rt.call(ref, 'slow', {}, { kind: 'session', sessionId: 's1' }, { signal: ac.signal })
    ac.abort() // 앱은 아직 뜨는 중이다 (첫 호출)
    const out = await p
    expect(out.status).toBe('cancelled')
    expect(byId(out.runId).status).toBe('cancelled')
    // 5초짜리 도구를 돌리지 않았다 — 뜨는 시간만 걸렸다
    expect(Date.now() - t0).toBeLessThan(2_000)
  })

  it('인자의 해시는 키 순서와 무관하다 — 같은 입력으로 또 실패했다를 셀 수 있게', async () => {
    make()
    const a = await rt.call(ref, 'echo', { text: 'same', extra: 1 }, { kind: 'view' })
    const b = await rt.call(ref, 'echo', { extra: 1, text: 'same' }, { kind: 'view' })
    expect(byId(a.runId).argsDigest).toBe(byId(b.runId).argsDigest)
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}')
  })

  it('긴 인자는 요약만 남는다', async () => {
    make()
    const out = await rt.call(ref, 'echo', { text: 'y'.repeat(1000) }, { kind: 'view' })
    const row = byId(out.runId)
    expect(row.argsSummary.length).toBeLessThanOrEqual(201)
    expect(row.argsSummary.endsWith('…')).toBe(true)
  })
})

describe('비밀 값은 기록 어디에도 없다', () => {
  it('요약·해시·실패 원문·이유 모두 가린 뒤에 남는다', async () => {
    make()
    rt.setSecret(ref, 'FIXTURE_SECRET', SECRET)
    // 앱이 되돌려주는 글에 비밀이 섞이는 경우까지 — echo는 받은 것을 그대로 돌려준다
    const ok = await rt.call(ref, 'echo', { text: `token ${SECRET}` }, { kind: 'view' })
    const failed = await rt.call(ref, 'fail', { note: `with ${SECRET}` }, { kind: 'view' })

    const all = JSON.stringify(runs())
    expect(all).not.toContain(SECRET)
    expect(byId(ok.runId).argsSummary).toBe('{"text":"token [redacted:FIXTURE_SECRET]"}')
    expect(byId(failed.runId).failure?.args).toBe('{"note":"with [redacted:FIXTURE_SECRET]"}')
    // 해시도 가린 입력의 해시다 — 짧은 비밀이 든 인자의 해시는 사전으로 되짚을 수 있다
    const again = await rt.call(ref, 'echo', { text: 'token [redacted:FIXTURE_SECRET]' }, { kind: 'view' })
    expect(byId(again.runId).argsDigest).toBe(byId(ok.runId).argsDigest)
  })
})

describe('실패한 입력은 최근 20건만 원문으로', () => {
  it('성공에는 원문이 없고, 실패는 원문과 결과가 남되 앱마다 20건까지다', async () => {
    make()
    const ok = await rt.call(ref, 'echo', { text: 'fine' }, { kind: 'view' })
    expect(byId(ok.runId).failure).toBeNull()

    const failedIds: string[] = []
    for (let i = 0; i < 22; i++) failedIds.push((await rt.call(ref, 'fail', { attempt: i }, { kind: 'view' })).runId)

    const first = byId(failedIds[21]!)
    expect(first.failure?.args).toBe('{"attempt":21}')
    expect(JSON.parse(first.failure!.result!)).toMatchObject({ isError: true, content: [{ type: 'text', text: 'the thing failed' }] })
    expect(failedIds.filter((id) => byId(id).failure !== null)).toHaveLength(20)
    // 가장 오래된 둘이 밀려났다 — 줄 자체는 남는다
    expect(byId(failedIds[0]!).failure).toBeNull()
    expect(byId(failedIds[1]!).failure).toBeNull()
    expect(byId(failedIds[0]!).status).toBe('error')
  })
})

describe('기동에서의 정리', () => {
  const row = (id: string, createdAt: number, status = 'ok') => ({
    id, projectId: 'p1', appId: 'notes', kind: 'tool', tool: 'echo', callerKind: 'view', callerSessionId: null, parentRunId: null,
    status, durationMs: 1, argsDigest: 'x', argsSummary: '{}', error: null, createdAt, sessionId: null,
  })

  it('30일이 지난 기록과 그 원문은 걷히고, 그 안의 것은 남는다', () => {
    const day = 24 * 60 * 60 * 1000
    store.beginAppRun(row('old', Date.now() - 31 * day, 'error'))
    store.keepAppRunFailure({ runId: 'old', projectId: 'p1', appId: 'notes', args: '{}', result: null, createdAt: Date.now() - 31 * day }, 20)
    store.beginAppRun(row('recent', Date.now() - 29 * day))
    make()
    expect(runs().map((r) => r.id)).toEqual(['recent'])
  })

  it('끝을 못 본 실행(host가 죽었다)은 error로 닫힌다 — 영원히 달리는 중으로 보이지 않게', () => {
    store.beginAppRun(row('orphan', Date.now() - 1000, 'running'))
    make()
    expect(byId('orphan')).toMatchObject({ status: 'error', error: 'the host stopped before this call finished' })
  })
})

describe('RPC와 프로젝트 삭제', () => {
  it('apps.runs가 기록을 돌려주고, 프로젝트를 지우면 그 앱들의 기록도 사라진다', async () => {
    const adapters = new Map<ToolName, AgentAdapter>()
    const mgr = new SessionManager(store, adapters, () => {})
    const { id } = await mgr.addProject(projRoot)
    store.setProjectTrusted(id, true)
    rt = new ExternalApps({
      projects: () => store.projectRoots(),
      dataRoot,
      reservedIds: [],
      timing: { probeTimeoutMs: 3_000 },
      runs: storeRunLedger(store),
    })
    rt.refresh()
    const rpc = createRpcHandler(mgr, adapters, { externalApps: rt })
    await rpc('apps.invoke', { appId: 'notes', projectId: id, name: 'echo', args: { text: 'via rpc' } })

    const listed = (await rpc('apps.runs', { appId: 'notes', projectId: id })) as AppRun[]
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ callerKind: 'view', status: 'ok', argsSummary: '{"text":"via rpc"}' })

    await rpc('projects.delete', { projectId: id })
    expect(store.listAppRuns(id, 'notes', 10)).toEqual([])
  })
})
