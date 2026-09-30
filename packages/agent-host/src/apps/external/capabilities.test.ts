import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, type AppCaller, type AppRef, type CapabilityQuestion, type RuntimeTiming } from './runtime.js'
import { MANIFEST_FILE } from './manifest.js'
import { PROJECT_APPS, fakeBrokerHost, memoryLedger, plantApp, until } from './test-helpers.js'

/**
 * Capability approval (M4 D-4) — the person is asked once, the **first** time an app uses a
 * capability (agent, another app, host data), the answer is remembered per (app, capability), and
 * it is asked again if the manifest's `uses` changes. Where the question shows up (a session's card
 * or a screen) and the person's answer are the host's job, so here a fake host receives them
 * instead — it records what was asked, and answers at the time the test decides. The manager side
 * (the card and the screen's question) is covered by sessions/app-capabilities.test.ts.
 */

const FIXTURE = fileURLToPath(new URL('./test-fixtures/app.mjs', import.meta.url))

let root = ''
let rt: ExternalApps
type Asked = { q: CapabilityQuestion; answer: (d: 'allow' | 'deny') => void; withdrawn: boolean }
let asked: Asked[] = []
/** The answer the person gives immediately — null means it does not answer and waits instead (the test answers via asked[i].answer) */
let autoAnswer: 'allow' | 'deny' | null = 'allow'

const dir = (id: string) => join(root, 'p1', ...PROJECT_APPS, id)
const plant = (id: string, uses: Record<string, unknown>) =>
  plantApp(join(root, 'p1', ...PROJECT_APPS), id, { server: { command: process.execPath, args: [FIXTURE, '--mode', 'mediation'] }, uses })
const ref = (appId: string): AppRef => ({ projectId: 'p1', appId })
const SESSION: AppCaller = { kind: 'session', sessionId: 's1' }

/** Calls the broker from inside a call the app is handling — returns the broker's answer */
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

describe('asks once on first use, and remembers the answer', () => {
  it('an allow lets the request through, and the next request for the same capability is not asked about', async () => {
    plant('notes', { agent: true })
    make()
    expect(await ask('notes', 'run_agent', { prompt: 'x' })).toMatchObject({ isError: false, text: 'agent ran on claude' })
    expect(await ask('notes', 'run_agent', { prompt: 'y' })).toMatchObject({ isError: false })
    expect(asked.map((a) => [a.q.capability, a.q.appName, a.q.text])).toEqual([['agent:claude', 'App notes', 'run an agent (Claude Code) in a new session']])
    expect(rt.permissions(ref('notes'))).toMatchObject([{ capability: 'agent:claude', decision: 'allow', current: true }])
  })

  it('a denial is also remembered — it is not asked again, and it states how to reverse it. Forgetting it asks again', async () => {
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

  it('asks separately per capability — allowing the agent does not also allow host data or another app', async () => {
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

  it('when the manifest\'s uses changes, the remembered answer is not used and it asks again', async () => {
    plant('notes', { agent: true })
    make()
    await ask('notes', 'run_agent', { prompt: 'x' })
    expect(asked).toHaveLength(1)
    // The declaration changes — the app's builder has restated what the app uses
    const manifest = JSON.parse(readFileSync(join(dir('notes'), MANIFEST_FILE), 'utf8'))
    writeFileSync(join(dir('notes'), MANIFEST_FILE), JSON.stringify({ ...manifest, uses: { agent: true, host: ['git.status'] } }))
    rt.refresh()
    await until(() => rt.permissions(ref('notes'))[0]?.current, (c) => c === false)
    await ask('notes', 'run_agent', { prompt: 'x' })
    expect(asked).toHaveLength(2)
  })
})

describe('waiting', () => {
  it('with no answer within the cap, closes as a denial and withdraws the question — since it was not an answer, nothing is remembered, and it asks again next time', async () => {
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

  it('the app\'s call stays alive while waiting on the person — a progress notification keeps it alive even past the app\'s own cap', async () => {
    plant('notes', { agent: true })
    autoAnswer = null
    make({ brokerKeepaliveMs: 100 })
    // The app's client gives up after 0.5 seconds of silence. The person answers after 1.2 seconds
    const pending = ask('notes', 'run_agent', { prompt: 'x' }, SESSION, { timeoutMs: 500 })
    await until(() => asked.length, (n) => n === 1)
    await new Promise((r) => setTimeout(r, 1_200))
    asked[0]!.answer('allow')
    expect(await pending).toMatchObject({ isError: false, text: 'agent ran on claude' })
  })

  it('two requests trying to use the same capability at once get only one question', async () => {
    // Exercised with host data — an agent runs only one at a time per app (D-5), so the second would be refused right after the question
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

  it('withdraws the question if the requesting call is cancelled', async () => {
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

describe('where the question is attributed — whoever started the chain', () => {
  it('a chain started from a session is attributed to that session; started from a screen, to that screen\'s app — passing through another app does not change what started it', async () => {
    plant('notes', { apps: ['other'] })
    plant('other', { agent: true })
    make()
    await ask('notes', 'call_app', { app: 'other', tool: 'ask_broker', args: { mode: 'run', tool: 'run_agent', args: { prompt: 'x' } } })
    await ask('notes', 'call_app', { app: 'other', tool: 'ask_broker', args: { mode: 'run', tool: 'run_agent', args: { prompt: 'x' } } }, { kind: 'view' })
    // notes calling other is a capability too (the first), and other using an agent is another (the second)
    expect(asked.map((a) => [a.q.app.appId, a.q.capability, a.q.origin])).toEqual([
      ['notes', 'app:p1/other', { kind: 'session', sessionId: 's1' }],
      ['other', 'agent:claude', { kind: 'session', sessionId: 's1' }],
    ])
    rt.forgetPermission(ref('other'), 'agent:claude')
    await ask('notes', 'call_app', { app: 'other', tool: 'ask_broker', args: { mode: 'run', tool: 'run_agent', args: { prompt: 'x' } } }, { kind: 'view' })
    expect(asked.at(-1)!.q).toMatchObject({ app: ref('other'), capability: 'agent:claude', origin: { kind: 'view', app: ref('notes') } })
  })
})
