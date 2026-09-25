import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ExternalAppInfo } from '@cc/protocol'
import { MANIFEST_FILE, MANIFEST_VERSION } from './manifest.js'
import { ExternalApps, type AppRef } from './runtime.js'
import { VERSIONS_KEPT, VERSIONS_REL } from './versions.js'
import { until } from './test-helpers.js'

/**
 * git 밖의 앱의 판 (M4 E-1) — 진짜 앱 프로세스(env-app.mjs)로 본다. 이 앱의 `version` 도구는 **뜰 때** 읽은 version.txt를 돌려준다:
 * 판이 떠진 것만이 아니라, 되돌린 뒤 앱이 정말 그 코드로 다시 떴는지를 앱의 입으로 듣는다.
 */

const APP = fileURLToPath(new URL('./test-fixtures/env-app.mjs', import.meta.url))

let root = ''
let dataRoot = ''
let rt: ExternalApps

const ref: AppRef = { projectId: null, appId: 'ver' }
const appDir = () => join(dataRoot, 'apps', 'ver')
const info = () => (rt.list() as ExternalAppInfo[]).find((a) => a.appId === 'ver' && a.projectId === null)
const manifest = (over: Record<string, unknown> = {}) => ({
  manifestVersion: MANIFEST_VERSION,
  id: 'ver',
  name: 'Versioned',
  version: '1.0.0',
  description: 'a user-folder app with versions',
  server: { command: process.execPath, args: [APP] },
  ...over,
})
const write = (rel: string, text: string) => {
  const p = join(appDir(), rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text)
}
/** 앱이 뜰 때 읽은 판 — 떠 있지 않으면 지금 띄워서 묻는다 */
const running = async () => {
  const out = await rt.call(ref, 'version', {}, { kind: 'view' })
  return out.result?.content.map((c) => (c.type === 'text' ? c.text : '')).join('') ?? `(${out.status}: ${out.error})`
}
/** 지금 파일로 다시 띄운다 — 사람의 Restart와 같다(내리고, 다음 부름이 띄운다) */
const startAgain = async () => {
  await rt.restart(ref)
  return running()
}

function make() {
  rt = new ExternalApps({
    projects: () => [],
    dataRoot,
    reservedIds: [],
    timing: { idleMs: 60_000, graceMs: 500, backoffBaseMs: 10, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  })
  rt.refresh()
  return rt
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-apps-versions-')))
  dataRoot = join(root, 'data')
  mkdirSync(join(dataRoot, 'apps', 'ver'), { recursive: true })
  writeFileSync(join(appDir(), MANIFEST_FILE), JSON.stringify(manifest(), null, 2))
  write('version.txt', 'v1')
})

afterEach(async () => {
  await rt?.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('판은 코드가 바뀌어 뜰 때 선다', () => {
  it('처음 뜰 때 한 판, 같은 코드로 다시 떠도 그대로, 고친 코드로 뜨면 한 판 더 — 최근 5벌만 남는다', async () => {
    make()
    expect(rt.snapshots(ref)).toEqual([])
    expect(await running()).toBe('v1')
    expect(rt.snapshots(ref)).toEqual([expect.objectContaining({ reason: 'started', current: true, files: 2 })])

    // 같은 코드 — 늘지 않는다
    expect(await startAgain()).toBe('v1')
    expect(rt.snapshots(ref)).toHaveLength(1)

    write('version.txt', 'v2')
    // 아직 뜨지 않았다 — 판은 뜨는 코드를 뜬다
    expect(rt.snapshots(ref)).toHaveLength(1)
    expect(rt.snapshots(ref)[0]!.current).toBe(false)
    expect(await startAgain()).toBe('v2')
    const two = rt.snapshots(ref)
    expect(two).toHaveLength(2)
    expect(two.map((s) => s.current)).toEqual([true, false])

    for (const v of ['v3', 'v4', 'v5', 'v6', 'v7']) {
      write('version.txt', v)
      expect(await startAgain()).toBe(v)
    }
    const kept = rt.snapshots(ref)
    expect(kept).toHaveLength(VERSIONS_KEPT)
    expect(readdirSync(join(dataRoot, VERSIONS_REL, '_user', 'ver')).filter((n) => !n.startsWith('.'))).toHaveLength(VERSIONS_KEPT)
    // 가장 오래된 둘(v1·v2)이 걷혔다 — 남은 판을 차례로 되돌려 보면 v7부터 v3까지다
    const versions: string[] = []
    for (const s of kept) {
      rt.restoreVersion(ref, s.id)
      versions.push(readFileSync(join(appDir(), 'version.txt'), 'utf8'))
    }
    expect(versions).toEqual(['v7', 'v6', 'v5', 'v4', 'v3'])
  })

  it('판은 앱 폴더 밖에 있고, 점으로 시작하는 이름과 node_modules는 뜨지 않는다', async () => {
    write('.env', 'SECRET=1')
    write('node_modules/dep/index.js', '// dep')
    write('ui/index.html', '<p>v1</p>')
    make()
    await running()
    const [snap] = rt.snapshots(ref)
    const files = join(dataRoot, VERSIONS_REL, '_user', 'ver', snap!.id, 'files')
    expect(readdirSync(files, { recursive: true }).sort()).toEqual([MANIFEST_FILE, 'ui', 'ui/index.html', 'version.txt'])
    expect(readdirSync(appDir())).not.toContain(VERSIONS_REL)
  })
})

describe('되돌리기', () => {
  it('판의 파일이 되쓰이고(판에 없던 코드 파일은 지워진다), 떠 있던 앱은 그 코드로 다시 뜨며, 되돌리기 직전의 코드도 판으로 남는다', async () => {
    make()
    expect(await running()).toBe('v1')
    const v1 = rt.snapshots(ref)[0]!
    write('version.txt', 'v2')
    write('extra.mjs', '// added in v2')
    write('.keep', 'not code')
    write('node_modules/dep/index.js', '// installed')
    expect(await startAgain()).toBe('v2')
    // v3은 고쳤지만 아직 뜨지 않았다 — 되돌리기가 이것을 잃으면 안 된다
    write('version.txt', 'v3')

    const back = rt.restoreVersion(ref, v1.id)
    expect(back.appId).toBe('ver')
    expect(readFileSync(join(appDir(), 'version.txt'), 'utf8')).toBe('v1')
    expect(existsSync(join(appDir(), 'extra.mjs'))).toBe(false)
    // 판이 다루지 않는 것은 그대로다
    expect(readFileSync(join(appDir(), '.keep'), 'utf8')).toBe('not code')
    expect(existsSync(join(appDir(), 'node_modules', 'dep', 'index.js'))).toBe(true)
    // 떠 있던 앱은 스스로 그 코드로 다시 뜬다 — 사람이 Restart를 누르지 않아도
    await until(() => info()?.status, (s) => s === 'running')
    expect(await running()).toBe('v1')

    const after = rt.snapshots(ref)
    expect(after.find((s) => s.reason === 'before restore')).toBeDefined()
    expect(after.find((s) => s.id === v1.id)?.current).toBe(true)
    // 되돌리기도 되돌릴 수 있다 — 직전의 v3으로
    rt.restoreVersion(ref, after.find((s) => s.reason === 'before restore')!.id)
    expect(readFileSync(join(appDir(), 'version.txt'), 'utf8')).toBe('v3')
  })

  it('연달아 실패해 멈춘 앱도 되돌리면 다시 뜬다 — 사람이 고른 코드다', async () => {
    make()
    expect(await running()).toBe('v1')
    const good = rt.snapshots(ref)[0]!
    writeFileSync(join(appDir(), MANIFEST_FILE), JSON.stringify(manifest({ server: { command: process.execPath, args: [APP, '--require-env'] } })))
    rt.refresh()
    for (let i = 0; i < 3; i++) await running()
    await until(() => info()?.status, (s) => s === 'failed')
    rt.restoreVersion(ref, good.id)
    expect(info()?.status).not.toBe('failed')
    expect(await running()).toBe('v1')
  })

  it('없는 판과 프로젝트 앱은 거절한다 — 프로젝트 앱의 판은 git이다', () => {
    make()
    expect(() => rt.restoreVersion(ref, 'nope')).toThrow('That version is no longer kept')
    expect(() => rt.restoreVersion({ projectId: 'p1', appId: 'ver' }, 'x')).toThrow("A project app's versions are its git history; restore it with git")
    expect(() => rt.snapshots({ projectId: 'p1', appId: 'ver' })).toThrow('Project apps are versioned by git')
  })
})

describe('가져온 앱의 판', () => {
  it('들어온 그대로가 첫 판이고, 다른 server의 판으로 되돌리면 다시 묻는다', async () => {
    rmSync(appDir(), { recursive: true })
    const src = join(root, 'src', 'imp')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, MANIFEST_FILE), JSON.stringify(manifest({ id: 'imp' })))
    writeFileSync(join(src, 'version.txt'), 'imported')
    make()
    const imp: AppRef = { projectId: null, appId: 'imp' }
    const { token, review } = await rt.prepareImport(src)
    rt.commitImport(token, { enable: true, reviewKey: review.reviewKey })
    const [first] = rt.snapshots(imp)
    expect(first).toMatchObject({ reason: 'imported', current: true })

    // 사람이 명령을 바꾸고 다시 켠 뒤 돌린다
    const dir = join(dataRoot, 'apps', 'imp')
    writeFileSync(join(dir, MANIFEST_FILE), JSON.stringify(manifest({ id: 'imp', server: { command: process.execPath, args: [APP, '--env', 'OTHER'] } })))
    rt.refresh()
    rt.enableApp(imp, rt.reviewApp(imp).reviewKey)
    expect((await rt.call(imp, 'version', {}, { kind: 'view' })).status).toBe('ok')
    expect(rt.snapshots(imp)).toHaveLength(2)

    // 들어온 판으로 되돌리면 server가 켠 때와 다르다 — 다시 묻는다
    const back = rt.restoreVersion(imp, first!.id)
    expect(back.status).toBe('unconfirmed')
    expect((await rt.call(imp, 'version', {}, { kind: 'view' })).status).toBe('rejected')
  })
})
