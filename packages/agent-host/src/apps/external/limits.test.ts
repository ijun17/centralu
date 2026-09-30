import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ExternalApps, type AppCaller, type AppRef, type BrokerHost, type CapabilityQuestion, type RuntimeTiming } from './runtime.js'
import { PROJECT_APPS, fakeBrokerHost, memoryLedger, plantApp, until } from './test-helpers.js'

/**
 * Runaway prevention (M4 D-5) — the broker counts calls so a cycle of apps cannot spend the
 * person's machine and usage without limit. Exercised with real app processes (fixtures).
 *
 *   chain depth  an app call chain goes at most 3 hops deep
 *   repetition   the same (app, tool) cannot be called again within one chain — both are refused
 *                before the person is even asked
 *   agent        at most one per app at a time, five within a one-minute window. Tokens spent are
 *                kept on the request's row and added up per app
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

/** Nests ask_broker calls inside ask_broker — given [a, b, c] and a last request, a calls b, b calls c, and c makes the last request */
const nest = (apps: string[], last: { tool: string; args: Record<string, unknown> }): Record<string, unknown> =>
  apps.slice(1).reduceRight<Record<string, unknown>>(
    (inner, app) => ({ mode: 'run', tool: 'call_app', args: { app, tool: 'ask_broker', args: inner } }),
    { mode: 'run', ...last },
  )

/** The innermost request's answer out of the nested answers — each layer carries the answer it received straight through in structured */
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

describe('chains', () => {
  it('an app call chain goes at most 3 hops deep — the fourth hop is never even started, and the person is never asked', async () => {
    plant('a', { apps: ['b'] })
    plant('b', { apps: ['c'] })
    plant('c', { apps: ['d'] })
    plant('d', {})
    make()
    // 3 hops: a → b → c.echo
    expect(await call('a', nest(['a', 'b'], { tool: 'call_app', args: { app: 'c', tool: 'echo', args: { text: 'third' } } }))).toMatchObject({
      isError: false,
      text: 'echo: third',
    })
    // 4 hops: a → b → c → d.echo
    const deep = await call('a', nest(['a', 'b', 'c'], { tool: 'call_app', args: { app: 'd', tool: 'echo', args: { text: 'fourth' } } }))
    expect(deep).toMatchObject({
      isError: true,
      text:
        'call_app refused: this chain would be 4 app calls deep (a.ask_broker → b.ask_broker → c.ask_broker → d.echo) — ' +
        'Centralu stops a chain at 3 so apps cannot call each other without end',
    })
    expect(ledger.rows.filter((r) => r.appId === 'd')).toEqual([])
    expect(asked.map((q) => `${q.app.appId}→${q.capability}`)).toEqual(['a→app:p1/b', 'b→app:p1/c'])
    // The refusal itself is also a row — c's request, under c's run (D-6)
    const refused = ledger.rows.find((r) => r.kind === 'broker' && r.status === 'rejected')!
    expect(refused).toMatchObject({ appId: 'c', tool: 'call_app' })
    expect(ledger.rows.find((r) => r.id === refused.parentRunId)).toMatchObject({ appId: 'c', tool: 'ask_broker' })
  })

  it('the same (app, tool) cannot be called again within one chain — a different tool on the same app can be', async () => {
    plant('a', { apps: ['b'] })
    plant('b', { apps: ['a'] })
    make()
    const loop = await call('a', nest(['a', 'b'], { tool: 'call_app', args: { app: 'a', tool: 'ask_broker', args: { mode: 'run', tool: 'host_data' } } }))
    expect(loop).toMatchObject({
      isError: true,
      text: 'call_app refused: a.ask_broker is already running in this chain (a.ask_broker → b.ask_broker → a.ask_broker) — calling it again would go round in a loop',
    })
    // b's capability to call a was never asked about — the person is not bothered with a request that would be refused anyway
    expect(asked.map((q) => `${q.app.appId}→${q.capability}`)).toEqual(['a→app:p1/b'])
    expect(await call('a', nest(['a', 'b'], { tool: 'call_app', args: { app: 'a', tool: 'echo', args: { text: 'back' } } }))).toMatchObject({
      isError: false,
      text: 'echo: back',
    })
  })
})

describe('agent', () => {
  it('one at a time per app — the second is refused immediately with a reason, and it becomes allowed again once the first finishes', async () => {
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
    // The second one gets its answer immediately, without waiting — if no answer comes within one second, it has been queued
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

  it('up to five within the window (one minute) — the sixth is refused with when it becomes allowed again, refusals do not count, and it becomes allowed once the window passes', async () => {
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

  it('tokens spent are kept on the request row (the last cumulative value reported) and added up per app — a refused request does not count', async () => {
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
    // A request outside the declaration — never started an agent
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
