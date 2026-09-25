import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, type RuntimeTiming } from './runtime.js'
import { SECRETS_FILE } from './secrets.js'
import { PROJECT_APPS, plantApp, until } from './test-helpers.js'

/**
 * 앱 프로세스의 수명 (M4 A-3) — **진짜 자식 프로세스로** 잰다.
 *
 * 픽스처 앱(test-fixtures/app.mjs)은 자기가 겪은 것(떴다, 어떤 메서드가 왔다, 어떤 환경을
 * 받았다, 손주를 띄웠다)을 파일에 적는다. 이 테스트는 host의 말이 아니라 그 파일과 OS의
 * 프로세스 표로 판정한다 — "떴다고 적었다"가 아니라 "떴다"를 본다.
 */

const FIXTURE = fileURLToPath(new URL('./test-fixtures/app.mjs', import.meta.url))

let fixture = ''
let dataRoot = ''
let projRoot = ''
let appLogs = ''
let trusted = true
let rt: ExternalApps

type Rec = { t: string; pid: number; at: number; method?: string; grandchild?: number; env?: Record<string, string | null> }
const records = (id: string): Rec[] => {
  const f = join(appLogs, `${id}.jsonl`)
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec)
}
const starts = (id: string) => records(id).filter((r) => r.t === 'start')

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** 픽스처를 띄우는 앱 하나를 심는다 */
const plant = (id: string, mode = 'normal', over: Record<string, unknown> = {}) =>
  plantApp(join(projRoot, ...PROJECT_APPS), id, {
    server: { command: process.execPath, args: [FIXTURE, '--log', join(appLogs, `${id}.jsonl`), '--mode', mode] },
    ...over,
  })

const ref = (appId: string) => ({ projectId: 'p1', appId })
const status = (id: string) => rt.list().find((a) => a.appId === id)?.status
const hostLog = (id: string) => {
  const f = join(dataRoot, 'app-logs', 'p1', `${id}.log`)
  return existsSync(f) ? readFileSync(f, 'utf8') : ''
}

const make = (timing: Partial<RuntimeTiming> = {}, env?: NodeJS.ProcessEnv) => {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted }],
    dataRoot,
    reservedIds: [],
    timing: { idleMs: 60_000, backoffBaseMs: 100, graceMs: 1_500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000, ...timing },
    ...(env ? { env } : {}),
  })
  rt.refresh()
  return rt
}

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-apps-life-')))
  dataRoot = join(fixture, 'data')
  projRoot = join(fixture, 'proj')
  appLogs = join(fixture, 'fixture-logs')
  for (const d of [dataRoot, projRoot, appLogs]) mkdirSync(d)
  trusted = true
})

afterEach(async () => {
  await rt?.dispose()
  rmSync(fixture, { recursive: true, force: true })
})

describe('처음 필요할 때 뜬다', () => {
  it('훑고 목록을 봐도 프로세스는 0개 — 도구 목록을 물을 때 하나 뜬다', async () => {
    plant('notes')
    make()
    expect(status('notes')).toBe('stopped')
    // 픽스처는 뜨고 100ms 남짓 뒤에 첫 줄을 쓴다 — 기동에서 몰래 띄웠다면 그 사이에 드러난다
    await new Promise((r) => setTimeout(r, 400))
    expect(starts('notes')).toHaveLength(0)

    const tools = await rt.tools(ref('notes'))
    expect(tools.map((t) => t.name)).toEqual(['echo'])
    expect(starts('notes')).toHaveLength(1)
    expect(status('notes')).toBe('running')
  })

  it('동시에 온 필요 다섯은 프로세스 하나를 띄운다 — 두 번 띄워 떠보지도 않는다', async () => {
    plant('notes')
    make()
    await Promise.all([1, 2, 3, 4, 5].map(() => rt.tools(ref('notes'))))
    expect(starts('notes')).toHaveLength(1)
  })

  it('신뢰하지 않은 프로젝트의 앱은 부탁을 받아도 뜨지 않는다', async () => {
    trusted = false
    plant('notes')
    make()
    await expect(rt.tools(ref('notes'))).rejects.toThrow(/신뢰하지 않은 프로젝트/)
    expect(starts('notes')).toHaveLength(0)
    expect(status('notes')).toBe('untrusted')
  })

  it('신뢰를 끄면 떠 있던 앱이 바로 내려간다', async () => {
    plant('notes')
    make()
    await rt.tools(ref('notes'))
    const pid = starts('notes')[0]!.pid
    trusted = false
    rt.refresh()
    await until(() => alive(pid), (a) => a === false)
    expect(status('notes')).toBe('untrusted')
  })
})

describe('규격 세대는 앱마다 기억한다 (S-4)', () => {
  it('첫 기동만 server/discover로 묻고, 쉬었다 다시 뜰 때는 기억한 세대로 바로 붙는다', async () => {
    plant('notes')
    make({ idleMs: 150 })
    await rt.tools(ref('notes'))
    const first = starts('notes')[0]!.pid
    await until(() => status('notes'), (s) => s === 'stopped')
    await rt.tools(ref('notes'))
    const second = starts('notes')[1]!.pid

    const methodsOf = (pid: number) => records('notes').filter((r) => r.t === 'method' && r.pid === pid).map((r) => r.method)
    expect(methodsOf(first)).toContain('server/discover')
    expect(methodsOf(second)).not.toContain('server/discover')
    expect(methodsOf(second)).toContain('tools/list')
    expect(hostLog('notes')).toMatch(/ready: pid \d+ era modern \(2026-07-28\) via cached verdict/)
  })
})

describe('크래시', () => {
  it('지수 백오프로 미루고, 세 번 연달아 실패하면 이유를 든 채 멈춘다', async () => {
    plant('broken', 'crash-on-start')
    // 기준을 크게 잡는다 — 픽스처가 뜨는 데만 170ms 남짓 걸려서, 작은 기준은 백오프 없이도 채워진다
    make({ backoffBaseMs: 400 })

    const failedAt: number[] = []
    for (let i = 0; i < 3; i++) {
      const err = await rt.tools(ref('broken')).catch((e: Error) => e)
      failedAt.push(Date.now())
      expect(err).toBeInstanceOf(Error)
      // 이유는 앱이 표준에러에 남긴 마지막 줄까지 싣는다
      expect((err as Error).message).toContain('fixture: cannot open the thing it needs')
      expect((err as Error).message).toContain('code 3')
    }
    const s = starts('broken')
    expect(s).toHaveLength(3)
    // 두 번째는 400ms, 세 번째는 800ms 뒤에야 떴다 (연속 실패 n → base × 2^(n-1))
    expect(s[1]!.at - failedAt[0]!).toBeGreaterThanOrEqual(390)
    expect(s[2]!.at - failedAt[1]!).toBeGreaterThanOrEqual(790)

    const info = rt.list().find((a) => a.appId === 'broken')!
    expect(info.status).toBe('failed')
    expect(info.error).toContain('fixture: cannot open the thing it needs')

    // 멈춘 앱은 더 띄우지 않는다
    await expect(rt.tools(ref('broken'))).rejects.toThrow(/3번 연달아 실패해 멈췄습니다/)
    expect(starts('broken')).toHaveLength(3)

    // 다시 시작하면 셈이 지워지고, 다음 필요가 띄운다
    await rt.restart(ref('broken'))
    expect(status('broken')).toBe('stopped')
    await rt.tools(ref('broken')).catch(() => {})
    expect(starts('broken')).toHaveLength(4)
  })
})

describe('쉬는 앱은 내린다', () => {
  it('진행 중인 호출도 열린 화면도 없으면 idleMs 뒤 프로세스가 끝난다', async () => {
    plant('notes')
    make({ idleMs: 200 })
    await rt.tools(ref('notes'))
    const pid = starts('notes')[0]!.pid
    expect(alive(pid)).toBe(true)
    await until(() => alive(pid), (a) => a === false)
    expect(status('notes')).toBe('stopped')
  })

  it('열린 화면이 있는 동안은 내리지 않는다 — 화면을 닫으면 그때부터 센다', async () => {
    plant('notes')
    make({ idleMs: 200 })
    const release = rt.retainView(ref('notes'))
    await rt.tools(ref('notes'))
    const pid = starts('notes')[0]!.pid
    await new Promise((r) => setTimeout(r, 600))
    expect(alive(pid)).toBe(true)
    release()
    await until(() => alive(pid), (a) => a === false)
  })
})

describe('종료 규칙 (S-5)', () => {
  it('표준 입력과 fd 3을 함께 닫으면 fd 3을 붙든 앱도 유예 안에 스스로 끝난다', async () => {
    plant('holder', 'hold-fd3')
    make({ graceMs: 3_000 })
    await rt.tools(ref('holder'))
    const pid = starts('holder')[0]!.pid

    const t0 = Date.now()
    await rt.restart(ref('holder'))
    expect(alive(pid)).toBe(false)
    // 유예(3초)를 다 쓰고 트리를 죽인 것이 아니다 — 스스로 끝났다
    expect(Date.now() - t0).toBeLessThan(1_500)
    expect(hostLog('holder')).not.toContain('did not exit within')
  })

  it('입력이 닫혀도 안 끝나는 앱은 유예 뒤 손주까지 끝낸다 — 고아가 남지 않는다', async () => {
    plant('stubborn', 'ignore-eof')
    make({ graceMs: 300 })
    await rt.tools(ref('stubborn'))
    const pid = starts('stubborn')[0]!.pid
    const grandchild = records('stubborn').find((r) => r.t === 'grandchild')!.grandchild!
    expect(alive(grandchild)).toBe(true)

    await rt.restart(ref('stubborn'))
    await until(() => [alive(pid), alive(grandchild)], ([a, b]) => !a && !b)
    expect(hostLog('stubborn')).toContain('did not exit within 300ms')
  })

  it('스스로 잘 끝난 앱이 남긴 손주도 거둔다 — 앱의 그룹째 끝낸다', async () => {
    plant('parent', 'grandchild')
    make()
    await rt.tools(ref('parent'))
    const pid = starts('parent')[0]!.pid
    const grandchild = records('parent').find((r) => r.t === 'grandchild')!.grandchild!

    await rt.restart(ref('parent'))
    expect(alive(pid)).toBe(false)
    expect(hostLog('parent')).not.toContain('did not exit within')
    await until(() => alive(grandchild), (a) => a === false)
  })

  it('host가 끝날 때(dispose) 떠 있던 앱이 전부 내려간다', async () => {
    plant('a1')
    plant('a2', 'ignore-eof')
    make()
    await Promise.all([rt.tools(ref('a1')), rt.tools(ref('a2'))])
    const pids = [starts('a1')[0]!.pid, starts('a2')[0]!.pid]
    await rt.dispose()
    await until(() => pids.map(alive), (xs) => xs.every((x) => !x), 6_000)
  })
})

describe('앱이 받는 것', () => {
  it('데이터 폴더(만들어 둔다)와 선언한 비밀만 받고, host의 변수는 받지 않는다', async () => {
    plant('notes', 'normal', { secrets: ['FIXTURE_SECRET'] })
    make({}, { ...process.env, CC_HOST_TOKEN: 'host-ws-token', CC_DATA_DIR: '/somewhere' })
    rt.setSecret(ref('notes'), 'FIXTURE_SECRET', 's3cret-value')
    rt.setSecret(ref('notes'), 'UNDECLARED_SECRET', 'not-for-this-app')
    await rt.tools(ref('notes'))

    const env = starts('notes')[0]!.env!
    const dataDir = join(dataRoot, 'app-data', 'p1', 'notes')
    expect(env).toMatchObject({
      CENTRALU_APP_ID: 'notes',
      CENTRALU_APP_DATA: dataDir,
      FIXTURE_SECRET: 's3cret-value',
      UNDECLARED_SECRET: null,
      CC_HOST_TOKEN: null,
      CC_DATA_DIR: null,
    })
    expect(statSync(dataDir).isDirectory()).toBe(true)
    expect(statSync(join(dataRoot, SECRETS_FILE)).mode & 0o777).toBe(0o600)
  })

  it('표준에러는 앱별 로그로 가고, 비밀 값은 이름으로 가려진다', async () => {
    plant('leaky', 'secret-to-stderr', { secrets: ['FIXTURE_SECRET'] })
    make()
    rt.setSecret(ref('leaky'), 'FIXTURE_SECRET', 's3cret-value')
    await rt.tools(ref('leaky'))
    await until(() => hostLog('leaky'), (l) => l.includes('about to use token='))
    expect(hostLog('leaky')).toContain('about to use token=[redacted:FIXTURE_SECRET]')
    expect(hostLog('leaky')).not.toContain('s3cret-value')
  })

  it('앱별 로그는 크기 상한에서 한 세대 밀려난다', async () => {
    plant('noisy', 'flood-stderr')
    make({ logMaxBytes: 4_096 })
    await rt.tools(ref('noisy'))
    const log = join(dataRoot, 'app-logs', 'p1', 'noisy.log')
    await until(() => existsSync(`${log}.1`), (x) => x)
    expect(statSync(log).size).toBeLessThanOrEqual(4_096 + 200)
  })
})

describe('도구 목록을 읽는 자리에서 이름 규칙을 지킨다', () => {
  it('이름에 `__`가 있는 도구는 목록에서 빠지고 이유가 경고로 남는다', async () => {
    plant('sneaky', 'bad-tool-name')
    make()
    expect((await rt.tools(ref('sneaky'))).map((t) => t.name)).toEqual(['echo'])
    expect(rt.list().find((a) => a.appId === 'sneaky')!.warnings.join('\n')).toContain('sneaky__tool')
  })
})
