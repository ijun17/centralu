import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, type AppCaller, type AppRef, type CapabilityQuestion, type RuntimeTiming } from './runtime.js'
import { MANIFEST_FILE } from './manifest.js'
import { PROJECT_APPS, fakeBrokerHost, memoryLedger, plantApp, until } from './test-helpers.js'

/**
 * 능력 승인 (M4 D-4) — 앱이 능력(에이전트, 다른 앱, host 데이터)을 **처음** 쓸 때 사람에게 한 번 묻고, 답을 (앱, 능력)마다
 * 기억하고, 매니페스트의 `uses`가 바뀌면 다시 묻는다. 물음이 어디에 서는지(세션의 카드인가 화면인가)와 사람의 답은 host의
 * 몫이라 여기서는 가짜 host가 받는다 — 무엇을 물었는지 적고, 시험이 정한 때에 답한다. 매니저 쪽(카드와 화면의 물음)은
 * sessions/app-capabilities.test.ts가 본다.
 */

const FIXTURE = fileURLToPath(new URL('./test-fixtures/app.mjs', import.meta.url))

let root = ''
let rt: ExternalApps
type Asked = { q: CapabilityQuestion; answer: (d: 'allow' | 'deny') => void; withdrawn: boolean }
let asked: Asked[] = []
/** 사람이 곧바로 하는 답 — null이면 답하지 않고 기다린다(시험이 asked[i].answer로 답한다) */
let autoAnswer: 'allow' | 'deny' | null = 'allow'

const dir = (id: string) => join(root, 'p1', ...PROJECT_APPS, id)
const plant = (id: string, uses: Record<string, unknown>) =>
  plantApp(join(root, 'p1', ...PROJECT_APPS), id, { server: { command: process.execPath, args: [FIXTURE, '--mode', 'mediation'] }, uses })
const ref = (appId: string): AppRef => ({ projectId: 'p1', appId })
const SESSION: AppCaller = { kind: 'session', sessionId: 's1' }

/** 앱이 처리 중인 호출 안에서 중개를 부른다 — 중개의 답을 돌려받는다 */
const ask = async (appId: string, tool: string, args: Record<string, unknown>, caller: AppCaller = SESSION, extra: Record<string, unknown> = {}) => {
  const out = await rt.call(ref(appId), 'ask_broker', { mode: 'run', tool, args, ...extra }, caller)
  return out.result!.structuredContent as { isError: boolean; text: string; structured: unknown }
}

const make = (timing: Partial<RuntimeTiming> = {}) => {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: join(root, 'p1'), trusted: true }],
    dataRoot: join(root, 'data'),
    reservedIds: [],
    runs: memoryLedger(),
    timing: { idleMs: 60_000, graceMs: 500, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000, ...timing },
  })
  rt.refresh()
  rt.attachBrokerHost(
    fakeBrokerHost({
      runAgent: async (req) => ({ sessionId: 's-agent', text: `agent ran on ${req.tool}` }),
      hostData: async () => ({ sessions: [] }),
      askCapability: (q, signal) =>
        new Promise((resolve) => {
          const a: Asked = { q, answer: (d) => resolve(d), withdrawn: false }
          asked.push(a)
          signal.addEventListener('abort', () => {
            a.withdrawn = true
            resolve(null)
          }, { once: true })
          if (autoAnswer) setTimeout(() => resolve(autoAnswer!), 5)
        }),
    }),
  )
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-capabilities-')))
  mkdirSync(join(root, 'p1'))
  mkdirSync(join(root, 'data'))
  asked = []
  autoAnswer = 'allow'
})

afterEach(async () => {
  await rt.dispose()
  rmSync(root, { recursive: true, force: true })
})

describe('처음 쓸 때 한 번 묻고, 답을 기억한다', () => {
  it('허락하면 부탁이 이어지고, 같은 능력의 다음 부탁은 묻지 않는다', async () => {
    plant('notes', { agent: true })
    make()
    expect(await ask('notes', 'run_agent', { prompt: 'x' })).toMatchObject({ isError: false, text: 'agent ran on claude' })
    expect(await ask('notes', 'run_agent', { prompt: 'y' })).toMatchObject({ isError: false })
    expect(asked.map((a) => [a.q.capability, a.q.appName, a.q.text])).toEqual([['agent:claude', 'App notes', 'run an agent (Claude Code) in a new session']])
    expect(rt.permissions(ref('notes'))).toMatchObject([{ capability: 'agent:claude', decision: 'allow', current: true }])
  })

  it('거절도 기억한다 — 다시 묻지 않고, 되돌리는 길을 말한다. 잊으면 다시 묻는다', async () => {
    plant('notes', { agent: true })
    autoAnswer = 'deny'
    make()
    const first = await ask('notes', 'run_agent', { prompt: 'x' })
    expect(first.isError).toBe(true)
    expect(first.text).toBe(
      "run_agent refused: the person did not allow App notes to run an agent (Claude Code) in a new session. They can change this in the app's Runs panel (Permissions → Forget), and Centralu asks again when the app's manifest changes what it uses.",
    )
    expect((await ask('notes', 'run_agent', { prompt: 'x' })).isError).toBe(true)
    expect(asked).toHaveLength(1)

    rt.forgetPermission(ref('notes'), 'agent:claude')
    autoAnswer = 'allow'
    expect((await ask('notes', 'run_agent', { prompt: 'x' })).isError).toBe(false)
    expect(asked).toHaveLength(2)
  })

  it('능력마다 따로 묻는다 — 에이전트를 허락했다고 host 데이터나 다른 앱까지 허락한 것이 아니다', async () => {
    plant('notes', { agent: true, apps: ['other'], host: ['sessions.list'] })
    plant('other', {})
    make()
    await ask('notes', 'run_agent', { prompt: 'x' })
    await ask('notes', 'host_data', { name: 'sessions.list' })
    await ask('notes', 'call_app', { app: 'other', tool: 'echo', args: { text: 'x' } })
    expect(asked.map((a) => [a.q.capability, a.q.text])).toEqual([
      ['agent:claude', 'run an agent (Claude Code) in a new session'],
      ['host:sessions.list', "read the list of this project's sessions (the names you see in the sidebar and their states, not the conversations)"],
      ['app:p1/other', 'call the app "App other"'],
    ])
  })

  it('매니페스트의 uses가 바뀌면 기억한 답을 쓰지 않고 다시 묻는다', async () => {
    plant('notes', { agent: true })
    make()
    await ask('notes', 'run_agent', { prompt: 'x' })
    expect(asked).toHaveLength(1)
    // 선언이 바뀐다 — 앱을 만든 쪽이 앱이 무엇을 쓰는지 다시 말했다
    const manifest = JSON.parse(readFileSync(join(dir('notes'), MANIFEST_FILE), 'utf8'))
    writeFileSync(join(dir('notes'), MANIFEST_FILE), JSON.stringify({ ...manifest, uses: { agent: true, host: ['git.status'] } }))
    rt.refresh()
    await until(() => rt.permissions(ref('notes'))[0]?.current, (c) => c === false)
    await ask('notes', 'run_agent', { prompt: 'x' })
    expect(asked).toHaveLength(2)
  })
})

describe('기다림', () => {
  it('상한 안에 답이 없으면 거절로 닫고 물음을 거둔다 — 답이 아니므로 기억하지 않고, 다음에 다시 묻는다', async () => {
    plant('notes', { agent: true })
    autoAnswer = null
    make({ capabilityQuestionMs: 400 })
    const out = await ask('notes', 'run_agent', { prompt: 'x' })
    expect(out.isError).toBe(true)
    expect(out.text).toContain('run_agent refused: the person did not answer within 1 second whether App notes may run an agent')
    expect(out.text).toContain('Nothing was remembered — Centralu asks again next time.')
    expect(asked[0]!.withdrawn).toBe(true)
    expect(rt.permissions(ref('notes'))).toEqual([])
    autoAnswer = 'allow'
    expect((await ask('notes', 'run_agent', { prompt: 'x' })).isError).toBe(false)
    expect(asked).toHaveLength(2)
  })

  it('사람을 기다리는 동안 앱의 호출은 살아 있다 — 앱의 상한을 넘겨도 진행 알림이 다시 세운다', async () => {
    plant('notes', { agent: true })
    autoAnswer = null
    make({ brokerKeepaliveMs: 100 })
    // 앱의 클라이언트는 0.5초 말이 없으면 포기한다. 사람은 1.2초 뒤에 답한다
    const pending = ask('notes', 'run_agent', { prompt: 'x' }, SESSION, { timeoutMs: 500 })
    await until(() => asked.length, (n) => n === 1)
    await new Promise((r) => setTimeout(r, 1_200))
    asked[0]!.answer('allow')
    expect(await pending).toMatchObject({ isError: false, text: 'agent ran on claude' })
  })

  it('같은 능력을 동시에 쓰려는 부탁 둘에는 물음이 하나만 선다', async () => {
    // host 데이터로 본다 — 에이전트는 한 앱에 하나씩만 돌아(D-5) 둘째가 물음 뒤에 거절된다
    plant('notes', { host: ['sessions.list'] })
    autoAnswer = null
    make()
    const a = ask('notes', 'host_data', { name: 'sessions.list' })
    const b = ask('notes', 'host_data', { name: 'sessions.list' })
    await until(() => asked.length, (n) => n === 1)
    await new Promise((r) => setTimeout(r, 300))
    expect(asked).toHaveLength(1)
    asked[0]!.answer('allow')
    expect((await a).isError).toBe(false)
    expect((await b).isError).toBe(false)
  })

  it('부탁한 호출이 취소되면 물음을 거둔다', async () => {
    plant('notes', { agent: true })
    autoAnswer = null
    make()
    const ac = new AbortController()
    const pending = rt.call(ref('notes'), 'ask_broker', { mode: 'run', tool: 'run_agent', args: { prompt: 'x' } }, SESSION, { signal: ac.signal })
    await until(() => asked.length, (n) => n === 1)
    ac.abort()
    expect((await pending).status).toBe('cancelled')
    await until(() => asked[0]!.withdrawn, (w) => w)
  })
})

describe('물음이 설 자리 — 사슬을 시작한 쪽', () => {
  it('세션에서 시작했으면 그 세션, 화면에서 시작했으면 그 화면의 앱이다 — 다른 앱을 거쳐도 처음이 기준이다', async () => {
    plant('notes', { apps: ['other'] })
    plant('other', { agent: true })
    make()
    await ask('notes', 'call_app', { app: 'other', tool: 'ask_broker', args: { mode: 'run', tool: 'run_agent', args: { prompt: 'x' } } })
    await ask('notes', 'call_app', { app: 'other', tool: 'ask_broker', args: { mode: 'run', tool: 'run_agent', args: { prompt: 'x' } } }, { kind: 'view' })
    // notes가 other를 부르는 것도 능력이다(첫째), other가 에이전트를 쓰는 것도 능력이다(둘째)
    expect(asked.map((a) => [a.q.app.appId, a.q.capability, a.q.origin])).toEqual([
      ['notes', 'app:p1/other', { kind: 'session', sessionId: 's1' }],
      ['other', 'agent:claude', { kind: 'session', sessionId: 's1' }],
    ])
    rt.forgetPermission(ref('other'), 'agent:claude')
    await ask('notes', 'call_app', { app: 'other', tool: 'ask_broker', args: { mode: 'run', tool: 'run_agent', args: { prompt: 'x' } } }, { kind: 'view' })
    expect(asked.at(-1)!.q).toMatchObject({ app: ref('other'), capability: 'agent:claude', origin: { kind: 'view', app: ref('notes') } })
  })
})
