import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, resultText, type AgentRunRequest, type AppCaller, type AppRef, type BrokerHost } from './runtime.js'
import { PROJECT_APPS, plantApp, until } from './test-helpers.js'

/**
 * 중개 (M4 A-4) — 앱 도구를 부르는 단 하나의 길과, 앱이 밖으로 부탁하는 fd 3.
 *
 * 공개 범위·실행 id·취소·"바뀌었다" 알림을 **진짜 앱 프로세스**에 대고 본다. 앱이 무엇을 받았는지
 * (실행 id, 취소)는 앱이 스스로 적은 파일로 판정한다.
 */

const FIXTURE = fileURLToPath(new URL('./test-fixtures/app.mjs', import.meta.url))

let fixture = ''
let dataRoot = ''
let projRoot = ''
let appLogs = ''
let changed: AppRef[] = []
/** 알림마다 그 바뀜을 낸 호출의 주인 — `changed`와 같은 순서 */
let causes: (AppCaller | null)[] = []
let rt: ExternalApps

type Rec = { t: string; pid: number; runId?: string | null; mode?: string; text?: string }
const records = (id: string): Rec[] => {
  const f = join(appLogs, `${id}.jsonl`)
  if (!existsSync(f)) return []
  return readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec)
}

const plant = (id: string, over: Record<string, unknown> = {}) =>
  plantApp(join(projRoot, ...PROJECT_APPS), id, {
    server: { command: process.execPath, args: [FIXTURE, '--log', join(appLogs, `${id}.jsonl`), '--mode', 'mediation'] },
    ...over,
  })
const ref = (appId: string): AppRef => ({ projectId: 'p1', appId })
/** 그 앱에 지금 열려 있는 실행의 id — 호출이 앱에 보내질 때까지 기다린다 (런타임 내부를 엿본다) */
const openRunOf = (appId: string) =>
  until(
    () => [...(rt as unknown as { openRuns: Map<string, { entry: { ref: AppRef } }> }).openRuns].find(([, r]) => r.entry.ref.appId === appId)?.[0],
    (id) => id !== undefined,
  ) as Promise<string>
const VIEW: AppCaller = { kind: 'view' }
const SESSION: AppCaller = { kind: 'session', sessionId: 's1' }

/** 에이전트 몸통만 갈아 끼운 host (D-1의 자리) — 세션 대신 시험이 주는 함수가 부탁을 받는다 */
const agentHost = (runAgent: (req: AgentRunRequest, ctx: { signal: AbortSignal }) => Promise<{ text: string }>): BrokerHost => ({
  defaultAgentTool: () => 'claude',
  runAgent: async (req, ctx) => ({ sessionId: 'fake-session', ...(await runAgent(req, ctx)) }),
})

const make = (host?: BrokerHost) => {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
    dataRoot,
    reservedIds: [],
    timing: { idleMs: 60_000, graceMs: 1_000, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
    emitChanged: (r, cause) => {
      changed.push(r)
      causes.push(cause ?? null)
    },
  })
  rt.refresh()
  if (host) rt.attachBrokerHost(host)
  return rt
}

beforeEach(() => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-apps-med-')))
  dataRoot = join(fixture, 'data')
  projRoot = join(fixture, 'proj')
  appLogs = join(fixture, 'fixture-logs')
  for (const d of [dataRoot, projRoot, appLogs]) mkdirSync(d)
  changed = []
  causes = []
  plant('notes')
})

afterEach(async () => {
  await rt?.dispose()
  rmSync(fixture, { recursive: true, force: true })
})

describe('공개 범위 — 양쪽 방향', () => {
  it('에이전트용 목록에는 model 도구만, 화면용에는 app 도구만 오른다', async () => {
    make()
    const names = async (a?: 'model' | 'app') => (await rt.tools(ref('notes'), a)).map((t) => t.name).sort()
    expect(await names('model')).toEqual(['ask_broker', 'crash', 'echo', 'fail', 'model_only', 'slow', 'whoami'])
    expect(await names('app')).toEqual(['app_only', 'ask_broker', 'crash', 'echo', 'fail', 'slow', 'whoami'])
  })

  it('화면은 model 전용 도구를 못 부르고, 세션은 app 전용 도구를 못 부른다 — 앱에 닿지도 않는다', async () => {
    make()
    const viewToModel = await rt.call(ref('notes'), 'model_only', {}, VIEW)
    expect(viewToModel).toMatchObject({ status: 'rejected', result: null })
    expect(viewToModel.error).toContain('visibility')
    const sessionToApp = await rt.call(ref('notes'), 'app_only', {}, SESSION)
    expect(sessionToApp.status).toBe('rejected')

    expect((await rt.call(ref('notes'), 'app_only', {}, VIEW)).status).toBe('ok')
    expect((await rt.call(ref('notes'), 'model_only', {}, SESSION)).status).toBe('ok')
    // 기본값(둘 다)인 도구는 누구든 부른다
    expect((await rt.call(ref('notes'), 'echo', { text: 'hi' }, VIEW)).status).toBe('ok')
    expect((await rt.call(ref('notes'), 'echo', { text: 'hi' }, SESSION)).status).toBe('ok')
  })

  it('모양이 틀린 공개 범위는 기본값으로 읽지 않고 도구를 뺀다 — 틀린 쪽이 닫힌다', async () => {
    make()
    const out = await rt.call(ref('notes'), 'bad_visibility', {}, VIEW)
    expect(out).toMatchObject({ status: 'rejected' })
    expect(out.error).toContain('그런 도구가 없습니다')
    expect(rt.list()[0]!.warnings.join('\n')).toContain('bad_visibility')
  })
})

describe('실행 id', () => {
  it('호출마다 새 실행 id가 발급되고 tools/call의 _meta로 앱에 간다', async () => {
    make()
    const a = await rt.call(ref('notes'), 'whoami', {}, VIEW)
    const b = await rt.call(ref('notes'), 'whoami', {}, VIEW)
    expect(resultText(a.result!)).toBe(a.runId)
    expect(resultText(b.result!)).toBe(b.runId)
    expect(a.runId).not.toBe(b.runId)
  })
})

describe('결말과 "바뀌었다" 알림', () => {
  it('앱에 닿은 호출이 끝날 때마다 한 번 알리고, 거절에는 알리지 않는다', async () => {
    make()
    await rt.call(ref('notes'), 'echo', { text: 'x' }, VIEW)
    expect(changed).toEqual([ref('notes')])
    await rt.call(ref('notes'), 'model_only', {}, VIEW) // 거절
    expect(changed).toHaveLength(1)
    const failed = await rt.call(ref('notes'), 'fail', {}, VIEW)
    expect(failed).toMatchObject({ status: 'error', error: 'the thing failed' })
    expect(changed).toHaveLength(2)
  })

  /*
   * 읽기는 아무것도 바꾸지 않았다. 실측(65acb43): 템플릿 화면은 알림마다 읽기 도구(`show`)를 다시 부르는데, 그
   * 읽기가 또 알림을 내서 화면 하나가 초당 약 700번 `show`를 불렀다(3초에 실행 기록 2035줄).
   */
  it('읽기만 하는 도구(readOnlyHint: true)는 알리지 않고, 주석이 없는 도구는 부른 쪽을 주인으로 알린다', async () => {
    plantApp(join(projRoot, ...PROJECT_APPS), 'board', { server: { command: process.execPath, args: [FIXTURE, '--mode', 'attach'] } })
    make()
    const board = ref('board')
    const frame: AppCaller = { kind: 'view', instanceId: 'frame-1' }
    // peek은 readOnlyHint: true — 앱에 닿아 답했지만 아무것도 바꾸지 않았다
    expect((await rt.call(board, 'peek', {}, frame)).status).toBe('ok')
    expect((await rt.call(board, 'peek', {}, SESSION)).status).toBe('ok')
    expect(changed).toEqual([])
    // poke에는 readOnlyHint가 없다 — MCP의 기본값대로 바꿀 수 있는 도구로 친다
    expect((await rt.call(board, 'poke', { to: 1 }, frame)).status).toBe('ok')
    expect((await rt.call(board, 'poke', { to: 2 }, SESSION)).status).toBe('ok')
    expect(changed).toEqual([board, board])
    expect(causes).toEqual([frame, SESSION])
  })

  it('앱에 보내기 전에 끝난 호출(뜨는 동안 취소)은 알리지 않는다 — 아무것도 바뀌지 않았다', async () => {
    make()
    const ac = new AbortController()
    const p = rt.call(ref('notes'), 'slow', {}, SESSION, { signal: ac.signal })
    ac.abort()
    expect((await p).status).toBe('cancelled')
    expect(changed).toEqual([])
  })

  it('호출 중에 앱이 죽으면 error로 끝나고, 그 죽음은 크래시로 센다', async () => {
    make()
    const out = await rt.call(ref('notes'), 'crash', {}, SESSION)
    expect(out.status).toBe('error')
    await until(() => rt.list()[0]!.status, (s) => s === 'crashed')
    expect(rt.list()[0]!.error).toContain('fixture: dying mid-call')
  })
})

describe('취소', () => {
  it('부른 쪽이 취소하면 실행은 cancelled로 끝나고 앱은 notifications/cancelled를 받는다', async () => {
    make()
    const ac = new AbortController()
    const p = rt.call(ref('notes'), 'slow', {}, SESSION, { signal: ac.signal })
    await until(() => records('notes').some((r) => r.t === 'start'), (x) => x)
    setTimeout(() => ac.abort(), 300)
    const out = await p
    expect(out.status).toBe('cancelled')
    // 앱 쪽 핸들러의 신호가 섰다 — 취소가 선을 타고 앱까지 갔다
    await until(() => records('notes').find((r) => r.t === 'aborted'), (r) => r !== undefined)
    expect(records('notes').find((r) => r.t === 'aborted')!.runId).toBe(out.runId)
  })

  it('다른 앱이 부른 호출(caller=app)은 부모 실행이 취소되면 함께 취소된다', async () => {
    plant('other')
    make()
    const parentAc = new AbortController()
    const parent = rt.call(ref('notes'), 'slow', {}, SESSION, { signal: parentAc.signal })
    const parentId = await openRunOf('notes')
    const child = rt.call(ref('other'), 'slow', {}, { kind: 'app', parentRunId: parentId })
    await until(() => records('other').some((r) => r.t === 'start'), (x) => x)
    await new Promise((r) => setTimeout(r, 200))
    parentAc.abort()
    expect((await parent).status).toBe('cancelled')
    expect((await child).status).toBe('cancelled')
  })

  it('열려 있지 않은 부모를 댄 앱 호출은 거절한다', async () => {
    make()
    const out = await rt.call(ref('notes'), 'echo', { text: 'x' }, { kind: 'app', parentRunId: 'run_nope' })
    expect(out).toMatchObject({ status: 'rejected' })
    expect(out.error).toContain('부모 실행이 열려 있지 않습니다')
  })
})

describe('중개 서버 (fd 3)', () => {
  const brokerAnswer = async (appId: string, args: Record<string, unknown>) => {
    const out = await rt.call(ref(appId), 'ask_broker', args, SESSION)
    expect(out.status).toBe('ok')
    return resultText(out.result!)
  }

  it('자기 실행 id를 붙인 중개 호출은 받아 준다 — 선언하지 않은 부탁은 창구가 이유와 함께 거절한다', async () => {
    make()
    const text = await brokerAnswer('notes', { mode: 'run' })
    expect(text).toBe('broker isError=true: run_agent refused: this app did not declare "uses": { "agent": … } in centralu.app.json — an app may run an agent only if its manifest says so')
    expect(await brokerAnswer('notes', { mode: 'run', tool: 'call_app' })).toContain('call_app refused: "other" is not in this app\'s "uses.apps"')
    expect(await brokerAnswer('notes', { mode: 'run', tool: 'host_data' })).toContain('host_data is not available yet')
  })

  it('실행 id 없는 중개 호출은 거절한다 (앱이 스스로 깨어난 경우)', async () => {
    make()
    expect(await brokerAnswer('notes', { mode: 'none' })).toContain('rejected: a broker call must carry the run id')
  })

  it('지어낸 id, 끝난 실행의 id, 다른 앱의 살아 있는 id 모두 거절한다', async () => {
    plant('other')
    make()
    expect(await brokerAnswer('notes', { mode: 'given', runId: 'run_deadbeef' })).toContain('rejected: run_deadbeef is not an open run of this app')

    const finished = await rt.call(ref('notes'), 'whoami', {}, VIEW)
    expect(await brokerAnswer('notes', { mode: 'given', runId: finished.runId })).toContain(`rejected: ${finished.runId} is not an open run`)

    // 'other'에 살아 있는 실행을 하나 열어 두고, 그 id를 'notes'가 대 본다 — 파이프가 누구인지 말한다
    const ac = new AbortController()
    const live = rt.call(ref('other'), 'slow', {}, SESSION, { signal: ac.signal })
    const liveId = await openRunOf('other')
    expect(await brokerAnswer('notes', { mode: 'given', runId: liveId })).toContain(`rejected: ${liveId} is not an open run of this app`)
    ac.abort()
    await live
    expect(readFileSync(join(dataRoot, 'app-logs', 'p1', 'notes.log'), 'utf8')).toContain('broker rejected run_agent')
  })

  it('부모 실행이 취소되면 그 아래 중개 일도 취소된다 — 앱이 신호를 넘기지 않아도', async () => {
    let sawAbort = false
    let started = false
    rmSync(join(projRoot, ...PROJECT_APPS, 'notes'), { recursive: true })
    plant('notes', { uses: { agent: true } })
    make(
      agentHost(
        (_req, ctx) =>
          new Promise((resolve, reject) => {
            started = true
            ctx.signal.addEventListener('abort', () => {
              sawAbort = true
              reject(new Error('aborted'))
            })
            void resolve
          }),
      ),
    )
    const ac = new AbortController()
    const p = rt.call(ref('notes'), 'ask_broker', { mode: 'run-nosignal' }, SESSION, { signal: ac.signal })
    await until(() => started, (x) => x)
    ac.abort()
    expect((await p).status).toBe('cancelled')
    await until(() => sawAbort, (x) => x)
  })
})

describe('실행이 끝나면 그 아래 중개 일도 끝난다', () => {
  it('앱이 중개 호출을 기다리지 않고 답해도, 실행이 닫히는 순간 그 일은 취소된다', async () => {
    let started = false
    let sawAbort = false
    rmSync(join(projRoot, ...PROJECT_APPS, 'notes'), { recursive: true })
    plant('notes', { uses: { agent: true } })
    make(
      agentHost(
        (_req, ctx) =>
          new Promise((_resolve, reject) => {
            started = true
            ctx.signal.addEventListener('abort', () => {
              sawAbort = true
              reject(new Error('aborted'))
            })
          }),
      ),
    )
    const out = await rt.call(ref('notes'), 'ask_broker', { mode: 'run-detached' }, SESSION)
    expect(out.status).toBe('ok')
    await until(() => started, (x) => x)
    await until(() => sawAbort, (x) => x)
  })
})

describe('리소스 읽기 (화면의 ui:// 문서)', () => {
  it('앱을 띄워 리소스를 그대로 돌려준다', async () => {
    make()
    const r = await rt.readResource(ref('notes'), 'ui://fixture/view')
    expect(r.contents[0]).toMatchObject({ uri: 'ui://fixture/view', text: '<p>fixture view</p>' })
  })
})
