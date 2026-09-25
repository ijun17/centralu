import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, type AppRef } from './runtime.js'
import { PROJECT_APPS, fakeBrokerHost, memoryLedger, plantApp, until } from './test-helpers.js'

/**
 * 앱끼리 부르기 (M4 D-2) — 앱이 fd 3으로 `call_app`을 부탁하면 창구가 선언(`uses.apps`)과 범위를 보고, 런타임의 한 길로
 * 부른 앱의 에이전트용 도구를 부른다. 진짜 앱 프로세스(픽스처)와 진짜 실행 기록으로 본다.
 *
 *   p1     신뢰한 프로젝트 — notes, other, viewonly
 *   p2     신뢰한 다른 프로젝트 — far
 *   user   사용자 폴더 — shared, lonely
 */

const FIXTURE = fileURLToPath(new URL('./test-fixtures/app.mjs', import.meta.url))

let root = ''
let dataRoot = ''
let roots: { p1: string; p2: string } = { p1: '', p2: '' }
let logs = ''
let rt: ExternalApps

const plant = (where: 'p1' | 'p2' | 'user', id: string, uses: Record<string, unknown> = {}) =>
  plantApp(where === 'user' ? join(dataRoot, 'apps') : join(roots[where], ...PROJECT_APPS), id, {
    server: { command: process.execPath, args: [FIXTURE, '--log', join(logs, `${id}.jsonl`), '--mode', 'mediation'] },
    uses,
  })
const records = (id: string): { t: string; runId?: string | null }[] => {
  const f = join(logs, `${id}.jsonl`)
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
}
const ref = (projectId: string | null, appId: string): AppRef => ({ projectId, appId })
const SESSION = { kind: 'session' as const, sessionId: 's1' }

/** notes(또는 다른 앱)가 처리 중인 호출 안에서 `call_app`을 부탁하고, 중개의 답을 돌려받는다 */
const askCallApp = async (asker: AppRef, args: Record<string, unknown>, signal?: AbortSignal) => {
  const out = await rt.call(asker, 'ask_broker', { mode: 'run', tool: 'call_app', args }, SESSION, signal ? { signal } : {})
  return { outcome: out, broker: (out.result?.structuredContent ?? null) as { isError: boolean; text: string; structured: unknown } | null }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-call-app-')))
  dataRoot = join(root, 'data')
  roots = { p1: join(root, 'p1'), p2: join(root, 'p2') }
  logs = join(root, 'fixture-logs')
  for (const d of [dataRoot, roots.p1, roots.p2, logs]) mkdirSync(d, { recursive: true })
  rt = new ExternalApps({
    projects: () => [
      { id: 'p1', path: roots.p1, trusted: true },
      { id: 'p2', path: roots.p2, trusted: true },
    ],
    dataRoot,
    reservedIds: [],
    runs: memoryLedger(),
    timing: { idleMs: 60_000, graceMs: 500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  })
  // 능력 승인(D-4)은 이 시험의 일이 아니다 — 사람이 곧바로 허락하는 host (묻는 것은 capabilities.test.ts가 본다)
  rt.attachBrokerHost(fakeBrokerHost({}))
})

afterEach(async () => {
  await rt.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('call_app — 적은 앱의 에이전트용 도구만', () => {
  it('uses.apps에 적은 같은 프로젝트의 앱을 부르면 그 답이 그대로 오고, 부른 앱의 기록에는 호출자 app과 부모 실행이 남는다', async () => {
    plant('p1', 'notes', { apps: ['other'] })
    plant('p1', 'other')
    rt.refresh()
    const { outcome, broker } = await askCallApp(ref('p1', 'notes'), { app: 'other', tool: 'echo', args: { text: 'hi' } })
    expect(broker).toEqual({ isError: false, text: 'echo: hi', structured: null })
    const [row] = rt.runs(ref('p1', 'other'))
    expect(row).toMatchObject({ tool: 'echo', callerKind: 'app', parentRunId: outcome.runId, status: 'ok' })
  })

  it('적지 않은 앱은 부르지 않는다 — 그 앱은 뜨지도 않는다', async () => {
    plant('p1', 'notes', { apps: ['other'] })
    plant('p1', 'stranger')
    rt.refresh()
    const { broker } = await askCallApp(ref('p1', 'notes'), { app: 'stranger', tool: 'echo', args: { text: 'hi' } })
    expect(broker).toMatchObject({
      isError: true,
      text: 'call_app refused: "stranger" is not in this app\'s "uses.apps" (other) — an app may call only the apps its manifest lists',
    })
    expect(records('stranger')).toEqual([])
  })

  it('적은 앱이어도 화면 전용 도구는 부르지 못한다 — 앱이 부르는 것은 에이전트와 같은 model 도구뿐이다', async () => {
    plant('p1', 'notes', { apps: ['other'] })
    plant('p1', 'other')
    rt.refresh()
    const { broker } = await askCallApp(ref('p1', 'notes'), { app: 'other', tool: 'app_only' })
    expect(broker!.isError).toBe(true)
    expect(broker!.text).toMatch(/^call_app: other\.app_only was refused — app_only은\(는\) 에이전트에게 열린 도구가 아닙니다/)
    expect((await askCallApp(ref('p1', 'notes'), { app: 'other', tool: 'model_only' })).broker).toMatchObject({ isError: false, text: 'model_only ran' })
  })
})

describe('call_app — 세션과 같은 범위 규칙', () => {
  it('프로젝트 앱은 자기 프로젝트와 사용자 폴더의 앱을 부르고, 다른 프로젝트의 앱은 이름이 같아도 닿지 않는다', async () => {
    plant('p1', 'notes', { apps: ['shared', 'far'] })
    plant('user', 'shared')
    plant('p2', 'far')
    rt.refresh()
    expect((await askCallApp(ref('p1', 'notes'), { app: 'shared', tool: 'echo', args: { text: 'x' } })).broker).toMatchObject({ isError: false, text: 'echo: x' })
    const far = (await askCallApp(ref('p1', 'notes'), { app: 'far', tool: 'echo', args: { text: 'x' } })).broker
    expect(far).toMatchObject({ isError: true, text: 'call_app: there is no app "far" in this project or in your user folder' })
    expect(records('far')).toEqual([])
  })

  it('같은 이름이 프로젝트와 사용자 폴더에 다 있으면 프로젝트의 앱이다', async () => {
    plant('p1', 'notes', { apps: ['twin'] })
    plant('p1', 'twin')
    plant('user', 'twin')
    rt.refresh()
    await askCallApp(ref('p1', 'notes'), { app: 'twin', tool: 'echo', args: { text: 'x' } })
    expect(rt.runs(ref('p1', 'twin'))).toHaveLength(1)
    expect(rt.runs(ref(null, 'twin'))).toHaveLength(0)
  })

  it('사용자 폴더 앱은 사용자 폴더의 앱만 부른다 — 어느 프로젝트의 앱도 고를 근거가 없다', async () => {
    plant('user', 'lonely', { apps: ['shared', 'notes'] })
    plant('user', 'shared')
    plant('p1', 'notes')
    rt.refresh()
    expect((await askCallApp(ref(null, 'lonely'), { app: 'shared', tool: 'echo', args: { text: 'x' } })).broker).toMatchObject({ isError: false })
    expect((await askCallApp(ref(null, 'lonely'), { app: 'notes', tool: 'echo', args: { text: 'x' } })).broker).toMatchObject({
      isError: true,
      text: 'call_app: there is no app "notes" in your user folder — an app from the user folder can call only other apps there',
    })
  })
})

describe('call_app — 취소는 사슬을 따라 내려간다', () => {
  it('처음 부른 쪽이 취소하면 부탁받아 도는 앱의 호출까지 취소된다', async () => {
    plant('p1', 'notes', { apps: ['other'] })
    plant('p1', 'other')
    rt.refresh()
    const ac = new AbortController()
    const pending = askCallApp(ref('p1', 'notes'), { app: 'other', tool: 'slow' }, ac.signal)
    // other가 호출을 실제로 받은 뒤에 취소한다 — 뜨는 중에 취소되면 보내지도 않는다(그것도 맞는 결말이지만 여기서 볼 것이 아니다)
    await until(() => records('other').some((r) => r.t === 'method' && (r as { method?: string }).method === 'tools/call'), (x) => x)
    ac.abort()
    expect((await pending).outcome.status).toBe('cancelled')
    await until(() => records('other').find((r) => r.t === 'aborted'), (r) => r !== undefined)
    await until(() => rt.runs(ref('p1', 'other'))[0]?.status, (s) => s === 'cancelled')
  })
})

describe('call_app — 부른 앱의 "바뀌었다"', () => {
  it('부른 앱의 바꾸는 도구는 그 앱의 열린 화면에 알리고, 주인은 부탁한 실행(호출자 app)이다 — 읽기만 하는 도구는 알리지 않는다', async () => {
    plant('p1', 'notes', { apps: ['board'] })
    // board의 peek은 readOnlyHint: true, poke에는 주석이 없다(바꾸는 도구로 친다)
    plantApp(join(roots.p1, ...PROJECT_APPS), 'board', { server: { command: process.execPath, args: [FIXTURE, '--mode', 'attach'] } })
    await rt.dispose()
    const changed: { ref: AppRef; cause: unknown }[] = []
    rt = new ExternalApps({
      projects: () => [{ id: 'p1', path: roots.p1, trusted: true }],
      dataRoot,
      reservedIds: [],
      runs: memoryLedger(),
      timing: { idleMs: 60_000, graceMs: 500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
      emitChanged: (r, cause) => changed.push({ ref: r, cause: cause ?? null }),
    })
    rt.refresh()
    rt.attachBrokerHost(fakeBrokerHost({}))
    const board = () => changed.filter((c) => c.ref.appId === 'board')

    expect((await askCallApp(ref('p1', 'notes'), { app: 'board', tool: 'peek' })).broker?.isError).toBe(false)
    expect(board()).toEqual([])
    const poke = await askCallApp(ref('p1', 'notes'), { app: 'board', tool: 'poke', args: { to: 3 } })
    expect(poke.broker?.isError).toBe(false)
    expect(board()).toEqual([{ ref: ref('p1', 'board'), cause: { kind: 'app', parentRunId: poke.outcome.runId } }])
  })
})
