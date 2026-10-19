import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { Socket } from 'node:net'
import { dirname, join } from 'node:path'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { memoryCapabilityBook } from './capabilities.js'
import type { ObservedSession, SessionsAnswer } from './broker.js'
import { BrokerDesk, WATCH_ANSWERS_PER_MINUTE, WATCH_WAIT_MAX_MS, type DeskApps } from './desk.js'
import { parseManifest, type AppManifest } from './manifest.js'
import { ExternalApps, resultText, type AppRef } from './runtime.js'
import { appTemplateDir, scaffoldApp } from './scaffold.js'
import { fakeBrokerHost, memoryLedger, until } from './test-helpers.js'
import { removeTree, tempRoot } from '../../temp-dir.test-helpers.js'
import { SLOW } from '../../../../../tooling/test-timing.js'

/**
 * An app hears of its project's sessions (docs/plans/task-ledger.md): with `uses.sessions: ["observe"]` declared it polls
 * `watch_sessions` with no run id and gets what changed after the cursor of its last answer. Exercised with an app
 * expanded from the template (the helper, the broker, the desk are the product's own); the session side is a host that
 * answers as the script says, and the manager's is `sessions/app-observe.test.ts`.
 */

let root = ''
let dataRoot = ''
let projRoot = ''
let rt: ExternalApps | null = null

beforeEach(() => {
  root = tempRoot('cc-app-observe-')
  dataRoot = join(root, 'data')
  projRoot = join(root, 'proj')
  mkdirSync(dataRoot)
  mkdirSync(projRoot)
})

afterEach(async () => {
  await rt?.dispose()
  rt = null
  await removeTree(root)
})

const ref = (appId: string): AppRef => ({ projectId: 'p1', appId })

const row = (id: string, over: Partial<ObservedSession> = {}): ObservedSession => ({
  id,
  name: id,
  kind: 'worker',
  tool: 'claude',
  state: 'idle',
  live: true,
  waitingSince: null,
  lastSeq: 1,
  activeAt: 1,
  parentId: null,
  askedBy: null,
  pending: { approvals: 0, questions: 0 },
  createdAt: 1,
  machine: null,
  appId: null,
  ...over,
})

/** A template app that writes every change it hears to `heard.json` in its data folder, starting as it loads */
function plant(id: string, { sessions = ['observe'] as string[] | null } = {}): void {
  const dir = join(projRoot, '.centralu', 'apps', id)
  mkdirSync(dirname(dir), { recursive: true })
  scaffoldApp(appTemplateDir(), dir, { id, name: id, description: `${id} app` })
  const manifest = JSON.parse(readFileSync(join(dir, 'centralu.app.json'), 'utf8')) as Record<string, unknown>
  if (sessions) manifest.uses = { sessions }
  writeFileSync(join(dir, 'centralu.app.json'), JSON.stringify(manifest, null, 2))
  writeFileSync(
    join(dir, 'server.mjs'),
    `import { McpServer, serveStdio, z, centralu } from './runtime/centralu-app-runtime.mjs'
const heard = []
centralu.observeSessions(async (change) => {
  heard.push(change)
  await centralu.writeJson('heard.json', heard)
})
serveStdio(() => {
  const server = new McpServer({ name: '${id}', version: '0' }, { capabilities: { tools: {} } })
  centralu.tool(server, 'ping', { description: 'Ping' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
  return server
})
`,
  )
}

/** What the host's poll receives, and the answers it gives: the test decides when the next one comes */
function host() {
  const polls: { projectId: string; cursor: string | undefined; waitMs: number }[] = []
  const waiting: ((a: SessionsAnswer) => void)[] = []
  const queued: Omit<SessionsAnswer, 'cursor'>[] = []
  let n = 0
  const ended = { cancelled: 0 }
  return {
    polls,
    ended,
    /** Answers the poll that is open, or the next one to come */
    answer: (a: Omit<SessionsAnswer, 'cursor'>) => {
      const open = waiting.shift()
      if (open) open({ ...a, cursor: `e.${++n}` })
      else queued.push(a)
    },
    watchSessions: (projectId: string, cursor: string | undefined, waitMs: number, signal: AbortSignal) => {
      polls.push({ projectId, cursor, waitMs })
      const early = queued.shift()
      if (early) return Promise.resolve({ ...early, cursor: `e.${++n}` })
      return new Promise<SessionsAnswer>((resolve) => {
        waiting.push(resolve)
        signal.addEventListener(
          'abort',
          () => {
            ended.cancelled += 1
            resolve({ cursor: `e.${n}`, full: false, sessions: [], gone: [] })
          },
          { once: true },
        )
      })
    },
  }
}

function runtime(h: ReturnType<typeof host>): ExternalApps {
  rt = new ExternalApps({
    projects: () => [{ id: 'p1', path: projRoot, trusted: true }],
    dataRoot,
    reservedIds: [],
    runs: memoryLedger(),
    timing: { idleMs: 60_000, graceMs: 1_000, backoffBaseMs: 20, probeTimeoutMs: 3_000, connectTimeoutMs: 10_000 },
  })
  rt.refresh()
  rt.attachBrokerHost(fakeBrokerHost({ watchSessions: h.watchSessions }))
  return rt
}

async function start(r: ExternalApps, appId: string): Promise<void> {
  const out = await r.call(ref(appId), 'ping', {}, { kind: 'session', sessionId: 's1' })
  expect(resultText(out.result!)).toBe('pong')
}

const heardBy = (appId: string) => {
  const file = join(dataRoot, 'app-data', 'p1', appId, 'heard.json')
  return () => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as { full: boolean; sessions: ObservedSession[]; gone: string[] }[]
    } catch {
      return []
    }
  }
}

describe('an app that declares uses.sessions: ["observe"]', () => {
  it('hears the whole project first, then each change, handing the host the cursor of its last answer', async () => {
    plant('ledger')
    const h = host()
    const r = runtime(h)
    h.answer({ full: true, sessions: [row('a'), row('b')], gone: [] })
    await start(r, 'ledger')
    const heard = heardBy('ledger')
    await until(heard, (v) => v.length === 1)
    expect(heard()[0]).toMatchObject({ full: true, sessions: [{ id: 'a' }, { id: 'b' }] })

    h.answer({ full: false, sessions: [row('a', { state: 'working' })], gone: ['b'] })
    await until(heard, (v) => v.length === 2)
    expect(heard()[1]).toMatchObject({ full: false, sessions: [{ id: 'a', state: 'working' }], gone: ['b'] })

    // The first poll held no cursor; each after it held the one the answer before gave
    await until(() => h.polls.length, (n) => n >= 3)
    expect(h.polls.slice(0, 3).map((p) => p.cursor)).toEqual([undefined, 'e.1', 'e.2'])
    expect(h.polls.every((p) => p.projectId === 'p1')).toBe(true)
  })

  it('is not woken by an answer with nothing in it, and goes on polling', async () => {
    plant('ledger')
    const h = host()
    const r = runtime(h)
    h.answer({ full: true, sessions: [row('a')], gone: [] })
    h.answer({ full: false, sessions: [], gone: [] })
    await start(r, 'ledger')
    await until(() => h.polls.length, (n) => n >= 3)
    expect(heardBy('ledger')()).toHaveLength(1)
  })

  it('stops hearing when the app goes (its poll is cancelled, not left open in the host)', async () => {
    plant('ledger')
    const h = host()
    const r = runtime(h)
    h.answer({ full: true, sessions: [row('a')], gone: [] })
    await start(r, 'ledger')
    await until(() => h.polls.length, (n) => n >= 2)
    await r.dispose()
    rt = null
    // The poll the host held open ended with the pipe: nothing is left waiting for an answer nobody reads
    await until(() => h.ended.cancelled, (n) => n === 1)
  })
})

describe('what the person is shown', () => {
  it('lists the declaration with the app, so the trust card can say what trusting the project allows', () => {
    plant('ledger')
    plant('plain', { sessions: null })
    const r = runtime(host())
    const listed = (id: string) => r.list().find((a) => a.appId === id)
    expect(listed('ledger')?.uses).toEqual({ sessions: ['observe'] })
    expect(listed('plain')?.uses).toBeUndefined()
  })
})

describe('an app that does not declare it, or cannot have it', () => {
  it('is refused with the reason, and the host is never asked', async () => {
    plant('quiet', { sessions: null })
    const h = host()
    const r = runtime(h)
    await start(r, 'quiet')
    await until(() => readFileSync(join(dataRoot, 'app-logs', 'p1', 'quiet.log'), 'utf8'), (t) => /does not declare "uses": \{ "sessions": \["observe"\] \}/.test(t))
    expect(h.polls).toEqual([])
  })

  it('leaves no run row, however many polls the app makes (they would bury its Runs panel)', async () => {
    plant('ledger')
    const h = host()
    const r = runtime(h)
    h.answer({ full: true, sessions: [row('a')], gone: [] })
    await start(r, 'ledger')
    await until(() => h.polls.length, (n) => n >= 2)
    expect(r.runs(ref('ledger'), 50).map((x) => x.tool)).toEqual(['ping'])
  })
})

describe('an older Centralu, which has no such request', () => {
  it('is said once on stderr and the loop ends, not tried again every few seconds for as long as the app runs', async () => {
    plant('ledger')
    const dir = join(projRoot, '.centralu', 'apps', 'ledger')
    const child = spawn('node', ['server.mjs'], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe', 'overlapped'], env: { PATH: process.env.PATH! } })
    const fd3 = child.stdio[3] as Socket
    // The host's side of fd 3 as a build from before this change has it: `busy` and the rest, no `watch_sessions`
    const closeBroker = (() => {
      const serve = serveStdio(
        () => {
          const server = new McpServer({ name: 'old-broker', version: '0' }, { capabilities: { tools: {} } })
          server.registerTool('busy', { description: 'busy' }, async () => ({ content: [{ type: 'text', text: 'not busy' }] }))
          return server
        },
        { transport: new StdioServerTransport(fd3, fd3) },
      )
      return () => void serve.close().catch(() => {})
    })()
    let stderr = ''
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (d: string) => (stderr += d))
    try {
      await until(() => stderr, (t) => /observeSessions: .*watch_sessions/.test(t))
      // The loop's first retry would come after one second
      await new Promise((r) => setTimeout(r, 2_500 * SLOW))
      expect(stderr.match(/centralu\.observeSessions:/g)).toHaveLength(1)
    } finally {
      closeBroker()
      fd3.destroy()
      const exited = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
  })
})

describe("the desk's own checks on a poll", () => {
  function desk(answer: () => Promise<SessionsAnswer> = async () => ({ cursor: 'e.1', full: true, sessions: [], gone: [] })) {
    const asked: { projectId: string; waitMs: number }[] = []
    const apps = { redactor: () => (t: string) => t } as unknown as DeskApps
    const d = new BrokerDesk(apps, memoryCapabilityBook(), () => ({ questionMs: 1_000, agentRateWindowMs: 60_000 }), memoryLedger())
    d.attach(
      fakeBrokerHost({
        watchSessions: async (projectId, _cursor, waitMs) => {
          asked.push({ projectId, waitMs })
          return answer()
        },
      }),
    )
    const app = (uses: AppManifest['uses'], projectId: string | null = 'p1') => ({ ref: { projectId, appId: 'ledger' }, name: 'ledger', manifest: { uses } as AppManifest })
    return { d, asked, app }
  }
  const never = new AbortController().signal

  it('refuses an app of the user folder, which has no project', async () => {
    const { d, asked, app } = desk()
    expect(await d.watch(app({ sessions: ['observe'] }, null), {}, never)).toMatchObject({ refused: expect.stringMatching(/has no project/) })
    expect(asked).toEqual([])
  })

  it('refuses a name it does not give, as it does an undeclared one', async () => {
    const { d, asked, app } = desk()
    expect(await d.watch(app({ sessions: ['message'] }), {}, never)).toMatchObject({ refused: expect.stringMatching(/does not declare/) })
    expect(await d.watch(app({}), {}, never)).toMatchObject({ refused: expect.stringMatching(/does not declare/) })
    expect(asked).toEqual([])
  })

  it('asks the host for the app\'s own project, and holds how long it waits to the limit', async () => {
    const { d, asked, app } = desk()
    const a = app({ sessions: ['observe'] })
    expect(await d.watch(a, { waitMs: 1_000_000 }, never)).toMatchObject({ answer: { full: true } })
    await d.watch(a, { waitMs: 300 }, never)
    await d.watch(a, {}, never)
    expect(asked).toEqual([
      { projectId: 'p1', waitMs: WATCH_WAIT_MAX_MS },
      { projectId: 'p1', waitMs: 300 },
      { projectId: 'p1', waitMs: 20_000 },
    ])
  })

  it('allows one poll at a time per app, and frees the place when it ends, failed or not', async () => {
    let release: (a: SessionsAnswer) => void = () => {}
    let fail = false
    const { d, app } = desk(() => (fail ? Promise.reject(new Error('the host is restarting')) : new Promise<SessionsAnswer>((r) => (release = r))))
    const a = app({ sessions: ['observe'] })
    const first = d.watch(a, {}, never)
    expect(await d.watch(a, {}, never)).toMatchObject({ refused: expect.stringMatching(/already open/) })
    // Another app has its own place
    release({ cursor: 'e.1', full: true, sessions: [], gone: [] })
    expect(await first).toMatchObject({ answer: { cursor: 'e.1' } })
    fail = true
    expect(await d.watch(a, {}, never)).toMatchObject({ refused: expect.stringMatching(/restarting/) })
    fail = false
    const again = d.watch(a, {}, never)
    release({ cursor: 'e.2', full: false, sessions: [], gone: [] })
    expect(await again).toMatchObject({ answer: { cursor: 'e.2' } })
  })

  it('stops an app that polls without waiting, at the limit and not before it', async () => {
    const { d, asked, app } = desk()
    const a = app({ sessions: ['observe'] })
    for (let i = 0; i < WATCH_ANSWERS_PER_MINUTE; i++) expect(await d.watch(a, { waitMs: 0 }, never), `poll ${i + 1}`).toHaveProperty('answer')
    expect(await d.watch(a, { waitMs: 0 }, never)).toMatchObject({ refused: expect.stringMatching(new RegExp(`${WATCH_ANSWERS_PER_MINUTE} polls in the last minute`)) })
    expect(asked).toHaveLength(WATCH_ANSWERS_PER_MINUTE)
  })
})

describe('the manifest', () => {
  const manifest = (uses: unknown) =>
    JSON.stringify({ manifestVersion: 1, id: 'ledger', name: 'Ledger', version: '1', description: 'd', server: { command: 'node', args: ['server.mjs'] }, uses })

  it('reads uses.sessions, and warns of a name this build does not give (an older build reading a newer manifest still runs the app)', () => {
    const ok = parseManifest(manifest({ sessions: ['observe'] }))
    expect(ok).toMatchObject({ ok: true, warnings: [] })
    const newer = parseManifest(manifest({ sessions: ['observe', 'message'] }))
    expect(newer).toMatchObject({ ok: true })
    expect(newer.warnings.join('\n')).toMatch(/uses\.sessions: Centralu has no capability "message" — it can give: observe/)
  })

  it('refuses a name that is not the shape of one, and does not call uses.sessions an unknown field', () => {
    expect(parseManifest(manifest({ sessions: ['Bad Name'] }))).toMatchObject({ ok: false })
    expect(parseManifest(manifest({ sessions: 'observe' }))).toMatchObject({ ok: false })
    expect(parseManifest(manifest({ sessions: ['observe'] })).warnings.join()).not.toMatch(/unknown field/)
  })
})
