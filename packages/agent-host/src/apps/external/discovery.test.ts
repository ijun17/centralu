import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps } from './runtime.js'
import { MANIFEST_FILE } from './manifest.js'
import { PROJECT_APPS, plantApp } from './test-helpers.js'

/**
 * 발견과 신뢰 (M4 A-2).
 *
 * 앱은 등록된 프로젝트 뿌리의 `.centralu/apps/*`와 host 데이터 폴더의 `apps/*`에서만 읽고,
 * 신뢰하지 않은 프로젝트의 앱은 **목록에 서되 뜨지 않는다.** 여기서는 "목록에 선다"와
 * 상태가 신뢰를 따라가는 것을 본다 — 뜨지 않는다는 것은 프로세스가 생기는 A-3이 잰다.
 */

let fixture = ''
let dataRoot = ''
let projRoot = ''
let projects: { id: string; path: string; trusted: boolean }[] = []
let rt: ExternalApps

const byId = (id: string) => rt.list().find((a) => a.appId === id)

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-apps-disc-')))
  dataRoot = join(fixture, 'data')
  projRoot = join(fixture, 'proj')
  mkdirSync(dataRoot)
  mkdirSync(projRoot)
  projects = [{ id: 'p1', path: projRoot, trusted: false }]
  rt = new ExternalApps({ projects: () => projects, dataRoot, reservedIds: ['control'], watchFlushMs: 40 })
})

afterEach(() => {
  rt.dispose()
  rmSync(fixture, { recursive: true, force: true })
})

describe('발견', () => {
  it('프로젝트 앱과 사용자 폴더 앱을 찾는다 — 사용자 폴더 앱은 신뢰, 프로젝트 앱은 기본이 불신', () => {
    plantApp(join(projRoot, ...PROJECT_APPS), 'notes')
    plantApp(join(dataRoot, 'apps'), 'timer')
    rt.refresh()

    expect(byId('notes')).toMatchObject({ projectId: 'p1', trusted: false, status: 'untrusted', name: 'App notes', error: null })
    expect(byId('timer')).toMatchObject({ projectId: null, trusted: true, status: 'stopped' })
    expect(byId('notes')?.dir).toBe(join(projRoot, '.centralu', 'apps', 'notes'))
  })

  it('신뢰를 켜고 다시 훑으면 뜰 수 있는 앱이 된다 — 끄면 다시 막힌다', () => {
    plantApp(join(projRoot, ...PROJECT_APPS), 'notes')
    rt.refresh()
    expect(byId('notes')?.status).toBe('untrusted')

    projects = [{ ...projects[0]!, trusted: true }]
    rt.refresh()
    expect(byId('notes')).toMatchObject({ trusted: true, status: 'stopped' })

    projects = [{ ...projects[0]!, trusted: false }]
    rt.refresh()
    expect(byId('notes')?.status).toBe('untrusted')
  })

  it('깨진 앱도 숨기지 않고 이유와 함께 선다', () => {
    const apps = join(projRoot, ...PROJECT_APPS)
    plantApp(apps, 'broken', {}, '{ nope')
    plantApp(apps, 'renamed', { id: 'other-id' })
    plantApp(apps, 'control') // 내장 앱의 이름
    mkdirSync(join(apps, 'half-made')) // 매니페스트가 아직 없는 폴더
    writeFileSync(join(apps, 'stray-file.txt'), 'not an app')
    rt.refresh()

    expect(byId('broken')).toMatchObject({ status: 'invalid', error: expect.stringContaining('is not JSON') })
    expect(byId('renamed')).toMatchObject({ status: 'invalid', error: expect.stringContaining('the folder name (renamed)') })
    expect(byId('control')).toMatchObject({ status: 'invalid', error: expect.stringContaining('the name of a built-in app') })
    expect(byId('half-made')).toMatchObject({ status: 'invalid', error: expect.stringContaining(`there is no ${MANIFEST_FILE}`) })
    expect(rt.list().map((a) => a.appId).sort()).toEqual(['broken', 'control', 'half-made', 'renamed'])
  })

  it('뿌리 밖을 가리키는 앱 폴더 링크는 따라가지 않는다 — 감시가 거절하는 것은 발견도 하지 않는다', () => {
    const outside = join(fixture, 'outside')
    plantApp(outside, 'escapee')
    const apps = join(projRoot, ...PROJECT_APPS)
    mkdirSync(apps, { recursive: true })
    symlinkSync(join(outside, 'escapee'), join(apps, 'escapee'), 'dir')
    rt.refresh()

    expect(byId('escapee')).toMatchObject({ status: 'invalid', error: expect.stringContaining('a link that points outside its root') })
    expect(byId('escapee')?.name).toBeNull()
  })

  it('등록에서 빠진 프로젝트의 앱은 목록에서도 빠진다', () => {
    plantApp(join(projRoot, ...PROJECT_APPS), 'notes')
    rt.refresh()
    expect(byId('notes')).toBeDefined()
    projects = []
    rt.refresh()
    expect(byId('notes')).toBeUndefined()
  })
})

/**
 * 폴더 감시는 둘로 나눠 잰다 (#153).
 *
 * 예전엔 한 테스트가 진짜 파일 시스템 이벤트를 기다리며 목록까지 봤고, 병렬 실행에서 세 번에 한 번꼴로 실패했다(이
 * 파일 넷을 함께 돌려 20번 중 6번 — 전부 첫 기다림이었다: 감시가 선 직후에 심은 앱이 4초 안에 목록에 서지 않았다).
 * 실측(macOS)으로는 이벤트가 늦는 것보다 **안 오는** 것이 문제였다. 감시가 서거나 감시 집합이 바뀐 직후의 변화는, 감시
 * 스트림이 비동기로 서는 사이에 빠질 수 있다(한 프로세스의 첫 감시에서 잦다 — watch.test.ts도 같은 것을 봤다). 온
 * 이벤트는 0.1초 안에 왔다. 그래서:
 *
 *   - 감시: 진짜 파일 시스템으로, 이 프로젝트의 이벤트가 **오는지만** 본다. 넉넉히 기다리되 한참 안 오면 같은 변화를
 *     다시 만든다 — 계약은 "언젠가는 알아챈다"이고, 앱에서는 다음 변화가 잡는다. 목록은 보지 않는다.
 *   - 목록: 감시가 넘기는 바로 그 이벤트를 **직접 넣고**, 기다림 없이 목록을 본다.
 *
 * 둘이 만나는 자리는 감시(DirWatchers)가 런타임에 이벤트를 넘기는 콜백이다 — 런타임이 만들 때 준 것이고 `rescan`으로
 * 간다. 감시 쪽은 거기서 듣기만 하고 런타임에 넘기지 않는다: 넘기면 이벤트 뒤의 다시 훑기가 감시 집합을 바꾸며 다음
 * 단계와 경주한다. 감시 집합은 `rt.refresh()`로 세운다 — 이벤트가 부르는 것과 같은 `rescan`이다.
 */
describe('폴더 감시', () => {
  const watcher = () => (rt as unknown as { watchers: { onChange: (key: string, dirs: string[]) => void } }).watchers
  /** 넉넉한 기한 — 부하 아래 늦는 것은 고장이 아니다 */
  const EVENT_DEADLINE_MS = 20_000
  /** 이만큼 안 오면 빠진 것으로 보고 같은 변화를 다시 만든다 (온 이벤트는 0.1초 안이었다) */
  const REDO_MS = 1_000

  /** 바꾸고, 그 폴더의 이벤트가 올 때까지 기다린다. `undo`는 같은 변화를 다시 만들 수 있게 되돌린다 */
  async function expectHeard(heard: string[][], dir: string, change: () => void, undo?: () => void): Promise<void> {
    heard.length = 0
    const got = () => heard.some((dirs) => dirs.includes(dir))
    const deadline = Date.now() + EVENT_DEADLINE_MS
    for (;;) {
      change()
      const redoAt = Math.min(Date.now() + REDO_MS, deadline)
      while (!got() && Date.now() < redoAt) await new Promise((r) => setTimeout(r, 25))
      if (got() || Date.now() >= deadline) break
      undo?.()
    }
    expect(got(), `${EVENT_DEADLINE_MS}ms 안에 '${dir}'의 이벤트가 오지 않았다 — 들은 것: ${JSON.stringify(heard)}`).toBe(true)
  }

  it('앱 폴더가 생기고, 매니페스트가 바뀌고, 폴더가 사라지면 감시가 이 프로젝트의 이벤트를 넘긴다', async () => {
    const heard: string[][] = []
    watcher().onChange = (key, dirs) => {
      if (key === 'p1') heard.push(dirs)
    }
    const apps = join(projRoot, ...PROJECT_APPS)

    // `.centralu`조차 없던 프로젝트에 앱이 생긴다 — 가장 깊은 조상(뿌리)을 보고 있었어야 한다
    rt.refresh()
    await expectHeard(heard, '', () => plantApp(apps, 'notes'), () => rmSync(join(projRoot, '.centralu'), { recursive: true }))

    // 앱이 선 뒤의 감시 집합 — 앱 폴더와 앱들의 폴더를 본다
    rt.refresh()
    await expectHeard(heard, '.centralu/apps/notes', () => plantApp(apps, 'notes', { name: 'Renamed notes' }))
    await expectHeard(heard, '.centralu/apps', () => rmSync(join(apps, 'notes'), { recursive: true }), () => plantApp(apps, 'notes'))
  }, 3 * EVENT_DEADLINE_MS + 5_000)

  it('이벤트를 받으면 목록이 따라간다 — 감시가 넘기는 이벤트를 직접 넣어, 기다림 없이 본다', () => {
    const deliver = watcher().onChange
    const apps = join(projRoot, ...PROJECT_APPS)
    rt.refresh()
    expect(rt.list().filter((a) => a.projectId === 'p1')).toEqual([])

    // 목록을 바꾸는 것은 이벤트다 — 넣기 전에는 그대로다
    plantApp(apps, 'notes')
    expect(byId('notes')).toBeUndefined()
    deliver('p1', [''])
    expect(byId('notes')?.name).toBe('App notes')

    plantApp(apps, 'notes', { name: 'Renamed notes' })
    expect(byId('notes')?.name).toBe('App notes')
    deliver('p1', ['.centralu/apps/notes'])
    expect(byId('notes')?.name).toBe('Renamed notes')

    rmSync(join(apps, 'notes'), { recursive: true })
    expect(byId('notes')).toBeDefined()
    deliver('p1', ['.centralu/apps'])
    expect(byId('notes')).toBeUndefined()
  })
})
