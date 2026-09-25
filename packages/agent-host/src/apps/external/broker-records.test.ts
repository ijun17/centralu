import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, type AppCaller, type AppRef, type BrokerHost } from './runtime.js'
import { PROJECT_APPS, fakeBrokerHost, memoryLedger, plantApp, until } from './test-helpers.js'

/**
 * 중개 부탁의 기록 (M4 D-6) — 앱이 fd 3으로 부탁한 것은 **어떻게 끝났든 한 줄**이다. 부탁한 앱의 `broker` 줄로, 부탁을
 * 일으킨 실행(부모) 아래에. 거절도, 틀린 부탁도, 취소도, 문지기가 받지 않은 부탁도. call_app이 부른 앱에 닿으면 그 앱의
 * 실행 줄이 곧 기록이다 — 같은 일을 두 줄로 적지 않는다. 진짜 앱 프로세스(픽스처)와 메모리 기록으로 본다.
 */

const FIXTURE = fileURLToPath(new URL('./test-fixtures/app.mjs', import.meta.url))

let root = ''
let rt: ExternalApps
let ledger: ReturnType<typeof memoryLedger>

const plant = (id: string, uses: Record<string, unknown>) =>
  plantApp(join(root, 'p1', ...PROJECT_APPS), id, { server: { command: process.execPath, args: [FIXTURE, '--mode', 'mediation'] }, uses })
const ref = (appId: string): AppRef => ({ projectId: 'p1', appId })
const SESSION: AppCaller = { kind: 'session', sessionId: 's1' }
const rowsOf = (appId: string) => ledger.rows.filter((r) => r.appId === appId)
const brokerRows = () => ledger.rows.filter((r) => r.kind === 'broker')

const make = (host: Partial<BrokerHost> = {}) => {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: join(root, 'p1'), trusted: true }],
    dataRoot: join(root, 'data'),
    reservedIds: [],
    runs: ledger,
    timing: { idleMs: 60_000, graceMs: 500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  })
  rt.refresh()
  rt.attachBrokerHost(fakeBrokerHost(host))
}

/** 앱이 처리 중인 호출 안에서 중개를 부른다 — 그 호출의 실행 id(부모)와 중개의 답 */
const ask = async (appId: string, tool: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}, signal?: AbortSignal) => {
  const out = await rt.call(ref(appId), 'ask_broker', { mode: 'run', tool, args, ...extra }, SESSION, signal ? { signal } : {})
  return { parent: out.runId, outcome: out, said: (out.result?.structuredContent ?? null) as { isError: boolean; text: string } | null }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-broker-records-')))
  mkdirSync(join(root, 'p1'))
  mkdirSync(join(root, 'data'))
  ledger = memoryLedger()
})

afterEach(async () => {
  await rt.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('부탁 하나에 줄 하나 — 부탁을 일으킨 실행 아래에', () => {
  it('에이전트 부탁은 들어오자마자 도는 줄이 서고, 세션이 서면 그 세션을 가리키며, 끝나면 결말이 적힌다', async () => {
    plant('notes', { agent: true })
    let release!: () => void
    make({
      runAgent: async (req, ctx) => {
        ctx.onSession('s-agent')
        await new Promise<void>((r) => (release = r))
        return { sessionId: 's-agent', text: `ran ${req.prompt}` }
      },
    })
    const pending = ask('notes', 'run_agent', { prompt: 'sum up' })

    const [running] = await until(brokerRows, (l) => l.length === 1 && l[0]!.sessionId !== null)
    const parent = rowsOf('notes').find((r) => r.kind === 'tool')!
    expect(running).toMatchObject({
      appId: 'notes', projectId: 'p1', kind: 'broker', tool: 'run_agent', callerKind: 'app', callerSessionId: null,
      parentRunId: parent.id, status: 'running', durationMs: null, sessionId: 's-agent', argsSummary: '{"prompt":"sum up"}',
    })
    release()
    const { parent: parentId, said } = await pending
    expect(said).toMatchObject({ isError: false, text: 'ran sum up' })
    expect(parentId).toBe(parent.id)
    expect(brokerRows()[0]).toMatchObject({ status: 'ok', error: null, sessionId: 's-agent' })
    expect(brokerRows()[0]!.durationMs).toBeGreaterThanOrEqual(0)
  })

  it('거절도 한 줄이다 — 선언 밖(host 데이터), 사람이 허락하지 않았다(에이전트)', async () => {
    plant('notes', { agent: true })
    make({ askCapability: async () => 'deny' })
    const undeclared = await ask('notes', 'host_data', { name: 'sessions.list' })
    const denied = await ask('notes', 'run_agent', { prompt: 'x' })
    expect(brokerRows().map((r) => [r.tool, r.status, r.parentRunId])).toEqual([
      ['host_data', 'rejected', undeclared.parent],
      ['run_agent', 'rejected', denied.parent],
    ])
    expect(brokerRows()[0]!.error).toContain(`host_data refused: "sessions.list" is not in this app's "uses.host"`)
    expect(brokerRows()[1]!.error).toContain('run_agent refused: the person did not allow App notes to run an agent')
    // 거절은 막힌 것이지 틀린 것이 아니다 — 원문을 남기지 않는다
    expect(ledger.failures).toEqual([])
  })

  it('틀린 부탁은 실패로 적히고 그 입력이 원문으로 남는다 — 앱을 고치는 에이전트가 읽는다', async () => {
    plant('notes', { agent: true })
    make()
    const { parent } = await ask('notes', 'run_agent', { prompt: 'x', schema: { type: 'array' } })
    const [row] = brokerRows()
    expect(row).toMatchObject({ tool: 'run_agent', status: 'error', parentRunId: parent })
    expect(row!.error).toContain('the schema must describe a JSON object at the top level')
    expect(ledger.failures).toEqual([{ runId: row!.id, args: '{"prompt":"x","schema":{"type":"array"}}', result: expect.stringContaining('the schema must describe') }])
  })

  it('call_app이 부른 앱에 닿으면 그 앱의 줄이 기록이다. 닿지 못한 부탁만 부탁한 앱의 줄로 남는다', async () => {
    plant('notes', { apps: ['other'] })
    plant('other', {})
    make()
    const reached = await ask('notes', 'call_app', { app: 'other', tool: 'echo', args: { text: 'hi' } })
    expect(reached.said).toMatchObject({ isError: false, text: 'echo: hi' })
    expect(rowsOf('other')).toMatchObject([{ kind: 'tool', tool: 'echo', callerKind: 'app', parentRunId: reached.parent, status: 'ok' }])
    expect(brokerRows()).toEqual([])

    const outside = await ask('notes', 'call_app', { app: 'third', tool: 'echo' })
    expect(brokerRows()).toMatchObject([{ appId: 'notes', tool: 'call_app', status: 'rejected', parentRunId: outside.parent }])
    expect(brokerRows()[0]!.error).toContain(`call_app refused: "third" is not in this app's "uses.apps"`)
  })

  it('부탁이 취소되면 그 줄은 취소로 닫힌다', async () => {
    plant('notes', { agent: true })
    let started = false
    make({
      runAgent: (_req, ctx) =>
        new Promise((_resolve, reject) => {
          started = true
          ctx.signal.addEventListener('abort', () => reject(new Error('the request was cancelled, so the agent was stopped')), { once: true })
        }),
    })
    const ac = new AbortController()
    const pending = ask('notes', 'run_agent', { prompt: 'x' }, {}, ac.signal)
    await until(() => started, (s) => s)
    ac.abort()
    expect((await pending).outcome.status).toBe('cancelled')
    const [row] = await until(brokerRows, (l) => l[0]?.status !== 'running')
    expect(row).toMatchObject({ tool: 'run_agent', status: 'cancelled', error: 'the request was cancelled, so the agent was stopped' })
  })
})

describe('문지기가 받지 않은 부탁도 한 줄이다 — 부모 없이', () => {
  it('실행 id가 없거나 열려 있지 않은 id를 내밀면 거절로 적히고, 내민 id는 부모가 되지 않는다', async () => {
    plant('notes', { agent: true })
    plant('other', { agent: true })
    make()
    await ask('notes', 'run_agent', { prompt: 'x' }, { mode: 'none' })
    // 다른 앱의 열린 실행 id를 내민다 — 그 id 아래에 줄을 끼워 넣지 못한다
    let otherRun = ''
    let release!: () => void
    await rt.dispose()
    make({
      runAgent: async () => {
        await new Promise<void>((r) => (release = r))
        return { sessionId: 's', text: 'done' }
      },
    })
    const holding = rt.call(ref('other'), 'ask_broker', { mode: 'run', tool: 'run_agent', args: { prompt: 'hold' } }, SESSION, { onRun: (id) => (otherRun = id) })
    await until(brokerRows, (l) => l.some((r) => r.appId === 'other' && r.status === 'running'))
    await ask('notes', 'run_agent', { prompt: 'x' }, { mode: 'given', runId: otherRun })
    release()
    await holding

    const refused = brokerRows().filter((r) => r.appId === 'notes')
    expect(refused.map((r) => [r.tool, r.status, r.parentRunId])).toEqual([
      ['run_agent', 'rejected', null],
      ['run_agent', 'rejected', null],
    ])
    expect(refused[0]!.error).toContain('rejected: a broker call must carry the run id')
    expect(refused[1]!.error).toBe(`rejected: ${otherRun} is not an open run of this app`)
    expect(ledger.rows.filter((r) => r.parentRunId === otherRun).map((r) => r.appId)).toEqual(['other'])
  })
})
