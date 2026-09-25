import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, type AppCaller, type AppRef, type BrokerHost, type CapabilityQuestion, type RuntimeTiming } from './runtime.js'
import { PROJECT_APPS, fakeBrokerHost, memoryLedger, plantApp, until } from './test-helpers.js'

/**
 * 폭주 막기 (M4 D-5) — 앱의 고리가 사람의 기계와 사용량을 끝없이 쓰지 못하게 중개가 센다. 진짜 앱 프로세스(픽스처)로 본다.
 *
 *   사슬의 깊이   앱 호출은 한 사슬에 3칸까지
 *   되풀이       한 사슬 위의 같은 (앱, 도구)는 다시 부르지 못한다 — 둘 다 사람에게 묻기 전에 거절한다
 *   에이전트     한 앱에 동시에 하나, 1분(창)에 다섯. 쓴 토큰은 부탁의 줄에 남고 앱마다 더해진다
 */

const FIXTURE = fileURLToPath(new URL('./test-fixtures/app.mjs', import.meta.url))

let root = ''
let rt: ExternalApps
let ledger: ReturnType<typeof memoryLedger>
let asked: CapabilityQuestion[] = []

const plant = (id: string, uses: Record<string, unknown>) =>
  plantApp(join(root, 'p1', ...PROJECT_APPS), id, { server: { command: process.execPath, args: [FIXTURE, '--mode', 'mediation'] }, uses })
const ref = (appId: string): AppRef => ({ projectId: 'p1', appId })
const VIEW: AppCaller = { kind: 'view' }

const make = (host: Partial<BrokerHost> = {}, timing: Partial<RuntimeTiming> = {}) => {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: join(root, 'p1'), trusted: true }],
    dataRoot: join(root, 'data'),
    reservedIds: [],
    runs: ledger,
    timing: { idleMs: 60_000, graceMs: 500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000, ...timing },
  })
  rt.refresh()
  rt.attachBrokerHost(
    fakeBrokerHost({
      askCapability: async (q) => {
        asked.push(q)
        return 'allow'
      },
      ...host,
    }),
  )
}

/** ask_broker 안에서 ask_broker를 부르는 부탁을 겹겹이 — [a, b, c]와 마지막 부탁이면 a가 b를, b가 c를 부르고 c가 마지막을 부탁한다 */
const nest = (apps: string[], last: { tool: string; args: Record<string, unknown> }): Record<string, unknown> =>
  apps.slice(1).reduceRight<Record<string, unknown>>(
    (inner, app) => ({ mode: 'run', tool: 'call_app', args: { app, tool: 'ask_broker', args: inner } }),
    { mode: 'run', ...last },
  )

/** 겹겹의 답에서 가장 안쪽 부탁의 답 — 각 층은 받은 답을 structured에 그대로 싣는다 */
const innermost = (structured: unknown): { isError: boolean; text: string } => {
  let at = structured as { isError: boolean; text: string; structured?: unknown }
  while (at.structured && typeof at.structured === 'object' && 'text' in at.structured) at = at.structured as typeof at
  return at
}

const call = async (first: string, body: Record<string, unknown>) => {
  const out = await rt.call(ref(first), 'ask_broker', body, VIEW)
  return innermost(out.result!.structuredContent)
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-broker-limits-')))
  mkdirSync(join(root, 'p1'))
  mkdirSync(join(root, 'data'))
  ledger = memoryLedger()
  asked = []
})

afterEach(async () => {
  await rt.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('사슬', () => {
  it('앱 호출은 한 사슬에 3칸까지다 — 넷째 칸은 뜨지도 않고, 사람에게 묻지도 않는다', async () => {
    plant('a', { apps: ['b'] })
    plant('b', { apps: ['c'] })
    plant('c', { apps: ['d'] })
    plant('d', {})
    make()
    // 3칸: a → b → c.echo
    expect(await call('a', nest(['a', 'b'], { tool: 'call_app', args: { app: 'c', tool: 'echo', args: { text: 'third' } } }))).toMatchObject({
      isError: false,
      text: 'echo: third',
    })
    // 4칸: a → b → c → d.echo
    const deep = await call('a', nest(['a', 'b', 'c'], { tool: 'call_app', args: { app: 'd', tool: 'echo', args: { text: 'fourth' } } }))
    expect(deep).toMatchObject({
      isError: true,
      text:
        'call_app refused: this chain would be 4 app calls deep (a.ask_broker → b.ask_broker → c.ask_broker → d.echo) — ' +
        'Centralu stops a chain at 3 so apps cannot call each other without end',
    })
    expect(ledger.rows.filter((r) => r.appId === 'd')).toEqual([])
    expect(asked.map((q) => `${q.app.appId}→${q.capability}`)).toEqual(['a→app:p1/b', 'b→app:p1/c'])
    // 거절도 한 줄이다 — c의 부탁으로, c의 실행 아래에 (D-6)
    const refused = ledger.rows.find((r) => r.kind === 'broker' && r.status === 'rejected')!
    expect(refused).toMatchObject({ appId: 'c', tool: 'call_app' })
    expect(ledger.rows.find((r) => r.id === refused.parentRunId)).toMatchObject({ appId: 'c', tool: 'ask_broker' })
  })

  it('한 사슬 위의 같은 (앱, 도구)는 다시 부르지 못한다 — 같은 앱의 다른 도구는 부른다', async () => {
    plant('a', { apps: ['b'] })
    plant('b', { apps: ['a'] })
    make()
    const loop = await call('a', nest(['a', 'b'], { tool: 'call_app', args: { app: 'a', tool: 'ask_broker', args: { mode: 'run', tool: 'host_data' } } }))
    expect(loop).toMatchObject({
      isError: true,
      text: 'call_app refused: a.ask_broker is already running in this chain (a.ask_broker → b.ask_broker → a.ask_broker) — calling it again would go round in a loop',
    })
    // b가 a를 부르는 능력은 묻지 않았다 — 어차피 거절될 부탁으로 사람을 부르지 않는다
    expect(asked.map((q) => `${q.app.appId}→${q.capability}`)).toEqual(['a→app:p1/b'])
    expect(await call('a', nest(['a', 'b'], { tool: 'call_app', args: { app: 'a', tool: 'echo', args: { text: 'back' } } }))).toMatchObject({
      isError: false,
      text: 'echo: back',
    })
  })
})

describe('에이전트', () => {
  it('한 앱에 동시에 하나 — 둘째는 곧바로 이유와 함께 거절되고, 첫째가 끝나면 다시 된다', async () => {
    plant('notes', { agent: true })
    const releases: (() => void)[] = []
    make({
      runAgent: async (req) => {
        await new Promise<void>((r) => releases.push(r))
        return { sessionId: 's', text: `ran ${req.prompt}` }
      },
    })
    const first = call('notes', { mode: 'run', tool: 'run_agent', args: { prompt: 'one' } })
    await until(() => releases.length, (n) => n === 1)
    // 둘째는 기다리지 않고 곧바로 답을 받는다 — 1초 안에 답이 없으면 줄을 선 것이다
    const pending = call('notes', { mode: 'run', tool: 'run_agent', args: { prompt: 'two' } })
    const second = await Promise.race([pending, new Promise((r) => setTimeout(() => r('still waiting after 1 s'), 1_000))])
    for (const r of releases.slice(1)) r()
    expect(second).toMatchObject({ isError: true })
    expect((second as { text: string }).text).toMatch(
      /^run_agent refused: App notes already has an agent running \(started \d+ seconds? ago\) — Centralu runs one agent per app at a time\. Ask again when it has finished\.$/,
    )
    expect(releases).toHaveLength(1)
    releases[0]!()
    expect(await first).toMatchObject({ isError: false, text: 'ran one' })
    const third = call('notes', { mode: 'run', tool: 'run_agent', args: { prompt: 'three' } })
    await until(() => releases.length, (n) => n === 2)
    releases[1]!()
    expect(await third).toMatchObject({ isError: false, text: 'ran three' })
  })

  it('창(1분) 안에 다섯까지 — 여섯째는 언제 다시 되는지와 함께 거절되고, 거절은 세지 않으며, 창이 지나면 다시 된다', async () => {
    plant('notes', { agent: true })
    let ran = 0
    make({ runAgent: async () => ({ sessionId: `s${++ran}`, text: 'ok' }) }, { agentRateWindowMs: 1_500 })
    for (let i = 0; i < 5; i++) expect((await call('notes', { mode: 'run', tool: 'run_agent', args: { prompt: `n${i}` } })).isError).toBe(false)
    const sixth = await call('notes', { mode: 'run', tool: 'run_agent', args: { prompt: 'n5' } })
    expect(sixth.text).toMatch(/^run_agent refused: App notes started 5 agents within 2 seconds, the most Centralu allows — ask again in \d seconds?, or put more of the work into one prompt$/)
    expect((await call('notes', { mode: 'run', tool: 'run_agent', args: { prompt: 'n6' } })).isError).toBe(true)
    expect(ran).toBe(5)
    await new Promise((r) => setTimeout(r, 1_600))
    expect((await call('notes', { mode: 'run', tool: 'run_agent', args: { prompt: 'n7' } })).isError).toBe(false)
    expect(ran).toBe(6)
  })

  it('쓴 토큰은 부탁의 줄에 남고(마지막으로 알려 준 누적값), 앱마다 더해진다 — 거절된 부탁은 세지 않는다', async () => {
    plant('notes', { agent: true })
    let n = 0
    make({
      runAgent: async (_req, ctx) => {
        n += 1
        ctx.onSession(`s${n}`)
        ctx.onUsage({ input: 100, output: 20 })
        ctx.onUsage({ input: 150 * n, output: 30 * n })
        return { sessionId: `s${n}`, text: 'ok' }
      },
    })
    await call('notes', { mode: 'run', tool: 'run_agent', args: { prompt: 'one' } })
    await call('notes', { mode: 'run', tool: 'run_agent', args: { prompt: 'two' } })
    // 선언 밖의 부탁 — 에이전트를 세우지 않았다
    await call('notes', { mode: 'run', tool: 'run_agent', args: { prompt: 'x', tool: 'codex' } })
    expect(rt.runs(ref('notes')).filter((r) => r.kind === 'broker').map((r) => [r.status, r.tokens])).toEqual([
      ['rejected', null],
      ['ok', { input: 300, output: 60 }],
      ['ok', { input: 150, output: 30 }],
    ])
    const use = rt.agentUse(ref('notes'))
    expect(use.day).toMatchObject({ runs: 2, tokens: { input: 450, output: 90 } })
    expect(use.month).toEqual(use.day)
  })
})
