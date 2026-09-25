import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { onExternalAppListChanged } from './app-list-events.js'
import { ExternalApps, type RuntimeTiming } from './apps/external/runtime.js'
import { PROJECT_APPS, plantApp, until } from './apps/external/test-helpers.js'

/**
 * 외부 앱 목록이 달라졌다는 방송 (M4 A-8) — main.ts가 쓰는 `onExternalAppListChanged` 그대로.
 *
 * 사이드바의 앱 줄과 고정 화면의 "뜨는 중·멈춤·이유"는 이 방송이 올 때 `apps.list`를 다시 읽는다.
 * 그래서 여기서 보는 것은 두 가지다. 목록이 달라지는 길(발견, 신뢰, 앱의 수명)마다 방송이
 * 나가는가, 그리고 나간 순간 `list()`가 이미 새 모양인가. 방송을 받은 쪽이 옛 목록을 읽으면
 * 방송이 없는 것과 같다. 그래서 방송마다 그 순간의 목록을 적어 두고 그것으로 판정한다.
 *
 * 폴더의 변화는 감시의 fs 이벤트를 기다리지 않고 `refresh()`로 직접 훑는다. 감시가 부르는 것과
 * 같은 rescan이다. 병렬 실행에서 macOS의 fs 이벤트가 몇 초씩 늦는 것이 실측됐고(c772e49),
 * 감시 자체는 discovery.test.ts가 본다.
 */

const FIXTURE = fileURLToPath(new URL('./apps/external/test-fixtures/app.mjs', import.meta.url))

let fixture = ''
let dataRoot = ''
let projRoot = ''
let projects: { id: string; path: string; trusted: boolean }[] = []
let rt: ExternalApps
/** 방송이 나갈 때마다, 그 순간의 목록을 `앱:상태`로 */
let heard: string[] = []

const snapshot = () =>
  rt
    .list()
    .filter((a) => a.projectId === 'p1')
    .map((a) => `${a.appId}:${a.status}`)
    .sort()
    .join(',')

const make = (timing: Partial<RuntimeTiming> = {}) => {
  rt = new ExternalApps({
    projects: () => projects,
    dataRoot,
    reservedIds: [],
    timing: { idleMs: 60_000, backoffBaseMs: 100, graceMs: 1_000, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000, maxFailures: 2, ...timing },
  })
  onExternalAppListChanged(rt, () => heard.push(snapshot()))
  return rt
}

/** 알림은 한 틱 뒤에 모여서 나간다 */
const settle = () => new Promise((r) => setTimeout(r, 30))

const plant = (id: string, mode = 'normal', over: Record<string, unknown> = {}) =>
  plantApp(join(projRoot, ...PROJECT_APPS), id, { server: { command: process.execPath, args: [FIXTURE, '--mode', mode] }, ...over })

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-apps-list-')))
  dataRoot = join(fixture, 'data')
  projRoot = join(fixture, 'proj')
  mkdirSync(dataRoot)
  mkdirSync(projRoot)
  projects = [{ id: 'p1', path: projRoot, trusted: true }]
  heard = []
})

afterEach(async () => {
  await rt?.dispose()
  rmSync(fixture, { recursive: true, force: true })
})

describe('발견', () => {
  it('앱 폴더의 생김·고침·사라짐마다 방송하고, 방송한 순간의 목록이 이미 그 모양이다', async () => {
    make().refresh()
    await settle()
    expect(heard).toEqual([])

    plant('notes')
    rt.refresh()
    await settle()
    expect(heard).toEqual(['notes:stopped'])

    // 매니페스트를 고쳤다 — 상태는 같아도 목록(이름)이 달라졌으니 방송한다
    plant('notes', 'normal', { name: 'Renamed notes' })
    rt.refresh()
    await settle()
    expect(heard).toHaveLength(2)
    expect(rt.list().find((a) => a.appId === 'notes')?.name).toBe('Renamed notes')

    rmSync(join(projRoot, ...PROJECT_APPS, 'notes'), { recursive: true })
    rt.refresh()
    await settle()
    expect(heard).toEqual(['notes:stopped', 'notes:stopped', ''])
  })

  it('아무것도 바뀌지 않은 다시 훑기는 조용하다', async () => {
    plant('notes')
    make().refresh()
    await settle()
    const base = heard.length

    rt.refresh()
    rt.refresh()
    await settle()
    expect(heard.length).toBe(base)
  })
})

describe('신뢰', () => {
  it('신뢰를 끄고 켜면 방송하고, 등록에서 빠진 프로젝트의 앱이 사라지는 것도 방송한다', async () => {
    plant('notes')
    make().refresh()
    await settle()
    heard = []

    projects = [{ ...projects[0]!, trusted: false }]
    rt.refresh()
    await settle()
    expect(heard).toEqual(['notes:untrusted'])

    projects = [{ ...projects[0]!, trusted: true }]
    rt.refresh()
    await settle()
    expect(heard).toEqual(['notes:untrusted', 'notes:stopped'])

    // 프로젝트를 지웠다 — 그 범위는 훑지 않고 통째로 빠진다
    projects = []
    rt.refresh()
    await settle()
    expect(heard.at(-1)).toBe('')
  })
})

describe('앱의 수명', () => {
  it('뜨는 중 → 떴다 → 쉬어서 내렸다를 차례로 방송한다', async () => {
    plant('notes')
    make({ idleMs: 200 }).refresh()
    await settle()
    heard = []

    await rt.tools({ projectId: 'p1', appId: 'notes' })
    await until(() => heard.at(-1), (h) => h === 'notes:running')
    expect(heard).toEqual(['notes:starting', 'notes:running'])

    await until(() => heard.at(-1), (h) => h === 'notes:stopped', 3000)
  })

  it('못 뜬 앱은 이유와 함께 crashed, 연달아 못 뜨면 failed, 다시 시작하면 stopped를 방송한다', async () => {
    plant('broken', 'crash-on-start')
    make().refresh()
    await settle()
    heard = []

    await rt.tools({ projectId: 'p1', appId: 'broken' }).catch(() => {})
    await until(() => heard.at(-1), (h) => h === 'broken:crashed')
    expect(rt.list().find((a) => a.appId === 'broken')?.error).toContain('fixture: cannot open the thing it needs')

    await rt.tools({ projectId: 'p1', appId: 'broken' }).catch(() => {})
    await until(() => heard.at(-1), (h) => h === 'broken:failed')

    await rt.restart({ projectId: 'p1', appId: 'broken' })
    await until(() => heard.at(-1), (h) => h === 'broken:stopped')
  })

  it('떠 있던 앱이 호출 중에 죽으면 방송한다', async () => {
    plant('dies', 'mediation')
    make().refresh()
    await settle()
    await rt.tools({ projectId: 'p1', appId: 'dies' })
    await until(() => heard.at(-1), (h) => h === 'dies:running')

    await rt.call({ projectId: 'p1', appId: 'dies' }, 'crash', {}, { kind: 'session', sessionId: 's1' })
    await until(() => heard.at(-1), (h) => h === 'dies:crashed')
  })

  it('다시 시작해서 이유가 지워진 앱(crashed → stopped)도 방송한다', async () => {
    plant('dies', 'mediation')
    make().refresh()
    await settle()
    await rt.call({ projectId: 'p1', appId: 'dies' }, 'crash', {}, { kind: 'session', sessionId: 's1' })
    await until(() => heard.at(-1), (h) => h === 'dies:crashed')

    await rt.restart({ projectId: 'p1', appId: 'dies' })
    await until(() => heard.at(-1), (h) => h === 'dies:stopped')
  })
})
