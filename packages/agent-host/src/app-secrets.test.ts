import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExternalAppInfo, NormalizedEvent, ToolName } from '@cc/protocol'
import type { AgentAdapter } from './adapters/contract.js'
import { onExternalAppListChanged } from './app-list-events.js'
import { storeRunLedger } from './app-run-ledger.js'
import { ExternalApps, type AppRef } from './apps/external/runtime.js'
import { SECRETS_FILE } from './apps/external/secrets.js'
import { PROJECT_APPS, plantApp, until } from './apps/external/test-helpers.js'
import { Store } from './dev-services/store.js'
import { createRpcHandler } from './rpc.js'
import { SessionManager } from './sessions/manager.js'

/**
 * 비밀 칸 (M4 E) — 사람이 넣은 값이 **host의 어디에도 새지 않는가**, 그리고 앱은 그 값을 받는가.
 *
 * 진짜 RPC 문(`createRpcHandler`), 진짜 저장소의 실행 기록(`storeRunLedger`), 진짜 앱 프로세스(env-app.mjs). 값이 지날 수
 * 있는 자리를 모두 모아 글자로 뒤진다: 앱의 로그 파일, 실행 기록(인자·오류·남긴 실패), 오류 묶음, 목록, 방송, host의
 * 콘솔, RPC의 답과 거절 문구. 앱은 일부러 값을 흘린다(뜰 때 표준에러, 실패 문구, 인자) — 흘리지 않는 앱으로는 가리는
 * 쪽을 시험할 수 없다.
 */

const APP = fileURLToPath(new URL('./apps/external/test-fixtures/env-app.mjs', import.meta.url))
/** 넣을 값 — 4자 이상이라 가림의 대상이다(짧은 값은 가리지 않는다, secrets.ts) */
const VALUE = 'sk-live-6f1d2c9a8b7e'

let root = ''
let dataRoot = ''
let projRoot = ''
let store: Store
let rt: ExternalApps
let rpc: ReturnType<typeof createRpcHandler>
let events: NormalizedEvent[] = []
let broadcasts = 0
let changedRefs: AppRef[] = []
let consoleText: string[] = []

const ref: AppRef = { projectId: 'p1', appId: 'keys' }
const info = () => (rt.list() as ExternalAppInfo[]).find((a) => a.appId === 'keys')!
const setSecret = (name: string, value: string | null) => rpc('apps.setSecret', { appId: 'keys', projectId: 'p1', name, value })
const envSeen = async () => {
  const out = await rt.call(ref, 'env', {}, { kind: 'session', sessionId: 's1' })
  const text = out.result?.content.map((c) => (c.type === 'text' ? c.text : '')).join('') ?? ''
  return { text, pid: Number(/pid=(\d+)/.exec(text)?.[1] ?? 0) }
}

function plant(args: string[], secrets = ['API_KEY']) {
  plantApp(join(projRoot, ...PROJECT_APPS), 'keys', {
    server: { command: process.execPath, args: [APP, '--env', 'API_KEY', ...args] },
    secrets,
  })
}

function make(timing: Record<string, number> = {}) {
  store = new Store()
  const adapters = new Map<ToolName, AgentAdapter>()
  const mgr = new SessionManager(store, adapters, (e) => events.push(e))
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
    dataRoot,
    reservedIds: [],
    runs: storeRunLedger(store),
    timing: { idleMs: 60_000, graceMs: 500, backoffBaseMs: 10, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000, ...timing },
    emitChanged: (r) => changedRefs.push(r),
  })
  rt.refresh()
  // host의 main과 같은 이음새 — 목록이 달라질 때마다 방송한다
  onExternalAppListChanged(rt, () => {
    broadcasts++
    events.push({ type: 'external_apps_changed' })
  })
  rpc = createRpcHandler(mgr, adapters, { externalApps: rt })
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-app-secrets-')))
  dataRoot = join(root, 'data')
  projRoot = join(root, 'proj')
  mkdirSync(dataRoot)
  mkdirSync(projRoot)
  events = []
  broadcasts = 0
  changedRefs = []
  consoleText = []
  // host의 콘솔도 뒤진다 — 값이 `[apps] …` 줄에 섞여 나가면 host.log에 남는다
  for (const m of ['error', 'log', 'warn'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void consoleText.push(a.map(String).join(' ')))
  }
})

afterEach(async () => {
  vi.restoreAllMocks()
  await rt?.dispose()
  store?.close()
  rmSync(root, { recursive: true, force: true })
})

describe('있음·없음은 보이고, 값은 보이지 않는다', () => {
  it('선언한 비밀이 비어 있으면 목록이 "없음"으로 말하고, 넣으면 "있음"이 되며 방송된다 — 값은 목록 어디에도 없다', async () => {
    plant([], ['API_KEY', 'OTHER_TOKEN'])
    make()
    expect(info().secrets).toEqual([
      { name: 'API_KEY', set: false },
      { name: 'OTHER_TOKEN', set: false },
    ])
    const before = broadcasts
    await expect(setSecret('API_KEY', VALUE)).resolves.toEqual({ ok: true })
    expect(info().secrets).toEqual([
      { name: 'API_KEY', set: true },
      { name: 'OTHER_TOKEN', set: false },
    ])
    await until(() => broadcasts, (n) => n > before)
    expect(JSON.stringify(rt.list())).not.toContain(VALUE)
    // 지우면 다시 없음이다
    await setSecret('API_KEY', null)
    expect(info().secrets?.[0]).toEqual({ name: 'API_KEY', set: false })
  })

  it('비밀을 선언하지 않은 앱에는 칸이 없다', () => {
    plant([], [])
    make()
    expect(info().secrets).toBeUndefined()
  })
})

describe('넣은 값은 다음 기동에 앱의 환경이 된다', () => {
  it('떠 있던 앱은 내려가고, 다음 부름이 새 값으로 띄운다 — 바꾸기와 지우기도 같다', async () => {
    plant([])
    make()
    const first = await envSeen()
    expect(first.text).toContain('API_KEY=(none)')

    await setSecret('API_KEY', VALUE)
    // 진행 중인 호출이 없으니 곧바로 내려간다 — 다음 부름이 새 프로세스를 띄운다
    const second = await envSeen()
    expect(second.text).toContain(`API_KEY=${VALUE}`)
    expect(second.pid).not.toBe(first.pid)

    await setSecret('API_KEY', 'sk-live-replaced-0000')
    expect((await envSeen()).text).toContain('API_KEY=sk-live-replaced-0000')

    await setSecret('API_KEY', null)
    expect((await envSeen()).text).toContain('API_KEY=(none)')
  })

  it('키가 없어 연달아 못 떠 멈춘 앱도, 값을 넣으면 다시 뜬다', async () => {
    plant(['--require-env'])
    make({ maxFailures: 1 })
    const refused = await rt.call(ref, 'env', {}, { kind: 'session', sessionId: 's1' })
    expect(refused.status).toBe('error')
    expect(info().status).toBe('failed')

    await setSecret('API_KEY', VALUE)
    expect(info().status).toBe('stopped')
    expect((await envSeen()).text).toContain(`API_KEY=${VALUE}`)
  })

  it('선언하지 않은 이름과 빈 값은 받지 않는다 — 거절 문구에도 값이 없다', async () => {
    plant([])
    make()
    await expect(setSecret('NOT_DECLARED', VALUE)).rejects.toThrow('This app does not declare a secret named NOT_DECLARED')
    await expect(setSecret('API_KEY', '')).rejects.toThrow('Enter a value, or clear the secret instead')
    // 너무 긴 값은 RPC의 모양 검사가 먼저 막는다 — 그 문구에도 값이 없다
    const long = VALUE.repeat(1000)
    const err = await setSecret('API_KEY', long).then(
      () => null,
      (e: Error) => e,
    )
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).not.toContain(VALUE)
    for (const e of [
      await setSecret('NOT_DECLARED', VALUE).catch((x: Error) => x),
      await setSecret('API_KEY', `${VALUE}\0`).catch((x: Error) => x),
    ]) {
      expect((e as Error).message).not.toContain(VALUE)
    }
    expect(info().secrets?.[0]?.set).toBe(false)
  })
})

describe('값은 host의 어디에도 남지 않는다', () => {
  it('앱이 값을 표준에러·실패 문구·인자로 흘려도 로그·실행 기록·오류 묶음·목록·방송·콘솔·RPC의 답에 이름만 남는다', async () => {
    plant(['--leak'])
    make()
    const reply = await setSecret('API_KEY', VALUE)
    // 앱은 값을 받았다 — 받지 못한 앱으로는 가림을 시험할 수 없다
    expect((await envSeen()).text).toContain(VALUE)
    await rt.call(ref, 'echo', { text: `the key is ${VALUE}` }, { kind: 'view' })
    await rt.call(ref, 'leak_fail', {}, { kind: 'session', sessionId: 's1' })
    const logFile = join(dataRoot, 'app-logs', 'p1', 'keys.log')
    await until(() => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''), (t) => t.includes('about to fail'))
    const bundles = await until(() => rt.errors(ref).latest, (b) => !!b && b.stderr.some((l) => l.includes('about to fail')))

    const places: Record<string, string> = {
      'app log': readFileSync(logFile, 'utf8'),
      'run records': JSON.stringify(await rpc('apps.runs', { appId: 'keys', projectId: 'p1', limit: 100 })),
      'error bundles': JSON.stringify(await rpc('apps.errors', { appId: 'keys', projectId: 'p1' })) + JSON.stringify(bundles),
      'app list': JSON.stringify(await rpc('apps.list', {})),
      broadcasts: JSON.stringify(events) + JSON.stringify(changedRefs),
      'host console': consoleText.join('\n'),
      'setSecret reply': JSON.stringify(reply),
    }
    for (const [where, text] of Object.entries(places)) expect(text, where).not.toContain(VALUE)
    // 이름으로 가려져 있다 — 흘린 자리가 사라진 것이 아니라 이름이 섰다
    expect(places['app log']).toContain('[redacted:API_KEY]')
    expect(places['run records']).toContain('[redacted:API_KEY]')
    expect(places['error bundles']).toContain('[redacted:API_KEY]')

    // 값이 사는 곳은 이 파일 하나, 권한 0600이다
    const file = join(dataRoot, SECRETS_FILE)
    expect(readFileSync(file, 'utf8')).toContain(VALUE)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })
})
