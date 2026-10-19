import { cpSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ObservedSession, SessionsAnswer } from './broker.js'
import { ExternalApps, resultText, type AppCaller, type AppRef } from './runtime.js'
import { fakeBrokerHost, memoryLedger, until } from './test-helpers.js'
import { eventually } from '../../../../../tooling/test-timing.js'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'

/**
 * The task ledger app (.centralu/apps/task-ledger), the real folder, run by the real external-app runtime: its tools as a
 * session and as its own panel call them, what it hears of the project's sessions, and what it tells the responsible
 * session through `notify`. The host is a script: it answers the app's polls and records the notices. GitHub is off, so
 * no `gh` is asked. The rules are task-ledger-logic.test.ts and task-ledger-engine.test.ts.
 */

const APP_DIR = fileURLToPath(new URL('../../../../../.centralu/apps/task-ledger', import.meta.url))

let root = ''
let dataRoot = ''
let projRoot = ''
let rt: ExternalApps | null = null

beforeEach(() => {
  root = tempRoot('cc-task-ledger-')
  dataRoot = join(root, 'data')
  projRoot = join(root, 'proj')
  mkdirSync(dataRoot)
  mkdirSync(join(projRoot, '.centralu', 'apps'), { recursive: true })
  cpSync(APP_DIR, join(projRoot, '.centralu', 'apps', 'task-ledger'), { recursive: true })
})

afterEach(async () => {
  await rt?.dispose()
  rt = null
  await removeTree(root)
})

const ref: AppRef = { projectId: 'p1', appId: 'task-ledger' }
const orchestrator: AppCaller = { kind: 'session', sessionId: 'orch' }
const worker: AppCaller = { kind: 'session', sessionId: 'w1' }
const panel: AppCaller = { kind: 'view' }

const row = (id: string, over: Partial<ObservedSession> = {}): ObservedSession => ({
  id,
  name: `session ${id}`,
  kind: 'worker',
  tool: 'claude',
  state: 'idle',
  live: true,
  waitingSince: null,
  lastSeq: 10,
  activeAt: Date.now(),
  parentId: null,
  askedBy: null,
  pending: { approvals: 0, questions: 0 },
  createdAt: 1,
  machine: null,
  appId: null,
  ...over,
})

/** The host: answers the app's polls from `push`, records notices */
function start() {
  const told: { sessionId: string; text: string }[] = []
  const polls: (string | undefined)[] = []
  const waiting: ((a: SessionsAnswer) => void)[] = []
  const queued: Omit<SessionsAnswer, 'cursor'>[] = []
  let n = 0
  const host = {
    told,
    polls,
    push: (a: Omit<SessionsAnswer, 'cursor'>) => {
      const open = waiting.shift()
      if (open) open({ ...a, cursor: `e.${++n}` })
      else queued.push(a)
    },
  }
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
    dataRoot,
    reservedIds: [],
    runs: memoryLedger(),
    timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  })
  rt.refresh()
  rt.attachBrokerHost(
    fakeBrokerHost({
      appNotice: async (sessionId, text) => void told.push({ sessionId, text }),
      watchSessions: (_projectId, cursor, _waitMs, signal) => {
        polls.push(cursor)
        const early = queued.shift()
        if (early) return Promise.resolve({ ...early, cursor: `e.${++n}` })
        return new Promise<SessionsAnswer>((resolve) => {
          waiting.push(resolve)
          signal.addEventListener('abort', () => resolve({ cursor: `e.${n}`, full: false, sessions: [], gone: [] }), { once: true })
        })
      },
    }),
  )
  return { rt, ...host }
}

async function call(r: ExternalApps, tool: string, args: Record<string, unknown> = {}, caller: AppCaller = panel) {
  const out = await r.call(ref, tool, args, caller)
  return { status: out.status, text: out.result ? resultText(out.result) : '', structured: out.result?.structuredContent as any, isError: out.result?.isError === true }
}

/** Waits until `read` (which asks the app) answers something `ok` accepts, and answers it */
async function untilAsked<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  return (await eventually(async () => {
    const v = await read()
    if (!ok(v)) throw new Error(`the last answer was ${JSON.stringify(v)}`)
    return { v }
  }, 8_000)).v
}

const saved = (): any => JSON.parse(readFileSync(join(dataRoot, 'app-data', 'p1', 'task-ledger', 'ledger.json'), 'utf8'))

describe('the task ledger app', () => {
  it('is an app of the project that declares what it needs, and shows agents four tools and its panel the rest', async () => {
    const { rt: r } = start()
    const listed = r.list().find((a) => a.appId === 'task-ledger')
    expect(listed).toMatchObject({ status: expect.stringMatching(/stopped|running|starting/), uses: { notices: true, sessions: ['observe'] } })
    expect((await r.tools(ref, 'model')).map((t) => t.name).sort()).toEqual(['ledger_add', 'ledger_list', 'ledger_take_charge', 'ledger_update'])
    expect((await r.tools(ref, 'app')).map((t) => t.name).sort()).toEqual(['ledger_add', 'ledger_adopt', 'ledger_list', 'ledger_settings', 'ledger_sweep', 'ledger_take_charge', 'ledger_update', 'show'])
  })

  it('hears of the sessions as it starts, with no cursor, and keeps asking from the cursor it was given', async () => {
    const h = start()
    h.push({ full: true, sessions: [row('w1')], gone: [] })
    const shown = await call(h.rt, 'show')
    expect(shown.status).toBe('ok')
    await until(() => h.polls.length, (c) => c >= 2)
    expect(h.polls.slice(0, 2)).toEqual([undefined, 'e.1'])
    const view = (await call(h.rt, 'show')).structured
    expect(view.observing).toMatchObject({ ok: true })
    expect(view.sessions.map((s: any) => s.id)).toEqual(['w1'])
  })

  it('tells the session that took charge, once, when a ready task has nobody, through notify', async () => {
    const h = start()
    h.push({ full: true, sessions: [row('w1')], gone: [] })
    expect((await call(h.rt, 'ledger_take_charge', { label: 'orchestrator' }, orchestrator)).text).toContain('responsible')
    await call(h.rt, 'ledger_add', { title: 'Fix login' }, orchestrator)
    const swept = await call(h.rt, 'ledger_sweep')
    expect(swept.status).toBe('ok')
    expect(h.told).toHaveLength(1)
    expect(h.told[0]).toMatchObject({ sessionId: 'orch' })
    expect(h.told[0]!.text).toContain('T1 "Fix login": ready, nobody is assigned.')
    await call(h.rt, 'ledger_sweep')
    expect(h.told).toHaveLength(1)
    expect(saved().settings.responsible).toMatchObject({ sessionId: 'orch', label: 'orchestrator' })
  })

  it('tells when the session a task is given to finishes, from what it heard of that session', async () => {
    const h = start()
    h.push({ full: true, sessions: [row('w1', { lastSeq: 10, state: 'working' })], gone: [] })
    await call(h.rt, 'ledger_take_charge', {}, orchestrator)
    await call(h.rt, 'ledger_add', { title: 'Mac checks' }, orchestrator)
    const updated = await call(h.rt, 'ledger_update', { id: 'T1', assignee: 'w1' }, orchestrator)
    expect(updated.text).toContain('T1 [running] Mac checks')
    await until(() => h.polls.length, (c) => c >= 2)
    await call(h.rt, 'ledger_sweep')
    expect(h.told.filter((t) => t.text.includes('Mac checks'))).toEqual([])
    h.push({ full: false, sessions: [row('w1', { lastSeq: 18, state: 'waiting_input' })], gone: [] })
    await untilAsked(async () => (await call(h.rt, 'show')).structured.attention.length, (n) => n === 1)
    await call(h.rt, 'ledger_sweep')
    expect(h.told.at(-1)!.text).toContain('T1 "Mac checks": its session finished, with a new answer.')
    // Looking at it takes it off the list
    await call(h.rt, 'ledger_update', { id: 'T1', seen: true }, orchestrator)
    expect((await call(h.rt, 'show')).structured.attention).toEqual([])
  })

  it('lists what an agent needs to read, and refuses a session that is not in the project', async () => {
    const h = start()
    h.push({ full: true, sessions: [row('w1', { name: 'mac-worker' })], gone: [] })
    await call(h.rt, 'show')
    await untilAsked(async () => (await call(h.rt, 'show')).structured.sessions.length, (n) => n === 1)
    await call(h.rt, 'ledger_add', { title: 'Mac checks', assignee: 'w1' }, orchestrator)
    await call(h.rt, 'ledger_add', { title: 'Docs' }, orchestrator)
    const refused = await call(h.rt, 'ledger_add', { title: 'Ghost', assignee: 'nobody' }, orchestrator)
    expect(refused.isError).toBe(true)
    expect(refused.text).toMatch(/There is no session nobody in this project/)
    const listed = await call(h.rt, 'ledger_list', {}, worker)
    expect(listed.text).toContain('Nobody is responsible yet')
    expect(listed.text).toContain('T1 [running] Mac checks · mac-worker')
    expect(listed.text).toContain('T2 [ready] Docs')
    expect(listed.structured.tasks.map((t: any) => t.id)).toEqual(['T1', 'T2'])
    expect((await call(h.rt, 'ledger_list', { attention: true }, worker)).structured.tasks.map((t: any) => t.id)).toEqual(['T2'])
  })

  it('lets the panel pick the responsible session among those that have used the ledger, and not one that has not', async () => {
    const h = start()
    await call(h.rt, 'ledger_list', {}, orchestrator)
    const refused = await call(h.rt, 'ledger_settings', { responsible: 'stranger' })
    expect(refused.isError).toBe(true)
    expect((await call(h.rt, 'ledger_settings', { responsible: 'orch' })).isError).toBe(false)
    expect((await call(h.rt, 'show')).structured.responsible).toMatchObject({ sessionId: 'orch' })
    expect((await call(h.rt, 'ledger_take_charge', {}, panel)).isError).toBe(true)
  })

  it('keeps its tasks in its data folder, not in the project, and finds them again after it restarts', async () => {
    const h = start()
    await call(h.rt, 'ledger_add', { title: 'Survives', next: 'be read again' }, orchestrator)
    expect(saved().tasks[0]).toMatchObject({ id: 'T1', title: 'Survives' })
    await h.rt.dispose()
    rt = null
    const again = start()
    expect((await call(again.rt, 'ledger_list', {}, orchestrator)).text).toContain('T1 [ready] Survives')
    // Nothing was written into the app's folder in the project (it is committed with the repository)
    expect(JSON.stringify(readFileSync(join(projRoot, '.centralu', 'apps', 'task-ledger', 'server.mjs'), 'utf8')).includes('Survives')).toBe(false)
  })

  it('keeps the app running while a task is open (the person sees why on its row)', async () => {
    const h = start()
    await call(h.rt, 'ledger_add', { title: 'Open' }, orchestrator)
    await until(() => h.rt.list().find((a) => a.appId === 'task-ledger')?.busy, (b) => !!b && /watching 1 task/.test(String(b)))
  })
})
