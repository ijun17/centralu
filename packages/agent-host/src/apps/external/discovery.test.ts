import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps } from './runtime.js'
import { MANIFEST_FILE } from './manifest.js'
import { PROJECT_APPS, plantApp, until } from './test-helpers.js'

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

    expect(byId('broken')).toMatchObject({ status: 'invalid', error: expect.stringContaining('JSON이 아닙니다') })
    expect(byId('renamed')).toMatchObject({ status: 'invalid', error: expect.stringContaining('폴더 이름(renamed)') })
    expect(byId('control')).toMatchObject({ status: 'invalid', error: expect.stringContaining('내장 앱의 이름') })
    expect(byId('half-made')).toMatchObject({ status: 'invalid', error: expect.stringContaining(`${MANIFEST_FILE}가 없습니다`) })
    expect(rt.list().map((a) => a.appId).sort()).toEqual(['broken', 'control', 'half-made', 'renamed'])
  })

  it('뿌리 밖을 가리키는 앱 폴더 링크는 따라가지 않는다 — 감시가 거절하는 것은 발견도 하지 않는다', () => {
    const outside = join(fixture, 'outside')
    plantApp(outside, 'escapee')
    const apps = join(projRoot, ...PROJECT_APPS)
    mkdirSync(apps, { recursive: true })
    symlinkSync(join(outside, 'escapee'), join(apps, 'escapee'), 'dir')
    rt.refresh()

    expect(byId('escapee')).toMatchObject({ status: 'invalid', error: expect.stringContaining('링크') })
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

describe('폴더 감시', () => {
  it('앱 폴더가 생기고, 매니페스트가 바뀌고, 폴더가 사라지는 것을 따라간다', async () => {
    rt.refresh()
    expect(rt.list().filter((a) => a.projectId === 'p1')).toEqual([])

    // `.centralu`조차 없던 프로젝트에 앱이 생긴다 — 가장 깊은 조상(뿌리)을 보고 있었어야 한다
    plantApp(join(projRoot, ...PROJECT_APPS), 'notes')
    await until(() => byId('notes')?.name, (n) => n === 'App notes')

    plantApp(join(projRoot, ...PROJECT_APPS), 'notes', { name: 'Renamed notes' })
    await until(() => byId('notes')?.name, (n) => n === 'Renamed notes')

    rmSync(join(projRoot, '.centralu', 'apps', 'notes'), { recursive: true })
    await until(() => byId('notes'), (a) => a === undefined)
  })
})
