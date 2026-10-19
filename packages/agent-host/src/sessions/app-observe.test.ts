import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionInfo } from '@cc/protocol'
import type { ObservedSession } from '../apps/external/runtime.js'
import { appTemplateDir, scaffoldApp } from '../apps/external/scaffold.js'
import { until } from '../apps/external/test-helpers.js'
import { PROJECT_APPS, plantApp } from '../apps/external/test-helpers.js'
import { SLOW } from '../../../../tooling/test-timing.js'
import { brokerWorld, type BrokerWorld } from './app-broker.test-helpers.js'

/**
 * An app that observes its project hears the manager's own sessions (docs/plans/task-ledger.md): a real manager, runtime
 * and app process (expanded from the template), a fake agent. The feed's rules (cursor, ring, what counts as a change)
 * are `session-watch.test.ts`; this is that the events the manager really sends reach the app through the broker host.
 */

let w: BrokerWorld
type Heard = { full: boolean; sessions: ObservedSession[]; gone: string[] }

beforeEach(async () => {
  w = await brokerWorld({ plantApp, PROJECT_APPS })
})

afterEach(async () => {
  await w.dispose()
})

const board = { appId: 'project-board', projectId: null, name: 'Project board' }

/** A template app that writes what it hears of its project's sessions to `heard.json` */
function plantLedger(): void {
  const dir = join(w.repo, '.centralu', 'apps', 'ledger')
  mkdirSync(dirname(dir), { recursive: true })
  scaffoldApp(appTemplateDir(), dir, { id: 'ledger', name: 'ledger', description: 'ledger app' })
  const manifest = JSON.parse(readFileSync(join(dir, 'centralu.app.json'), 'utf8')) as Record<string, unknown>
  manifest.uses = { sessions: ['observe'] }
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
  const server = new McpServer({ name: 'ledger', version: '0' }, { capabilities: { tools: {} } })
  centralu.tool(server, 'ping', { description: 'Ping' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }))
  return server
})
`,
  )
  w.rt.refresh()
}

const heard = (): Heard[] => {
  try {
    return JSON.parse(readFileSync(join(w.dataRoot, 'app-data', w.projectId, 'ledger', 'heard.json'), 'utf8')) as Heard[]
  } catch {
    return []
  }
}
const last = (id: string) => heard().flatMap((h) => h.sessions).filter((s) => s.id === id).at(-1)

async function session(): Promise<SessionInfo> {
  return (await w.rpc('agents.createSession', { projectId: w.projectId, cwd: w.repo, tool: 'claude' })) as SessionInfo
}

async function start(): Promise<void> {
  plantLedger()
  const out = await w.rt.call({ projectId: w.projectId, appId: 'ledger' }, 'ping', {}, { kind: 'session', sessionId: 'x' })
  expect(out.status).toBe('ok')
}

// Each test starts a real app process and a manager: the limit is generous, for a loaded machine
describe("a project app hears the manager's sessions", { timeout: 20_000 * SLOW }, () => {
  it('hears the sessions that are there when it starts, and a new one', async () => {
    const a = await session()
    await start()
    await until(() => heard().length, (n) => n >= 1)
    expect(heard()[0]).toMatchObject({ full: true })
    expect(heard()[0]!.sessions.map((s) => s.id)).toEqual([a.id])
    const b = await session()
    await until(() => last(b.id), (s) => s?.state === 'idle')
  })

  it("hears a turn begin and end, with the answer's number, and no conversation", async () => {
    w.claude.onSend = (h) => {
      h.say('the answer: a secret in here')
      h.done()
    }
    const s = await session()
    await start()
    await until(() => last(s.id), (x) => !!x)
    const before = last(s.id)!
    await w.mgr.appNotice(s.id, 'please go on', board)
    const after = await until(() => last(s.id), (x) => x?.state === 'waiting_input' && x.lastSeq > before.lastSeq)
    expect(after).toMatchObject({ id: s.id, live: true, pending: { approvals: 0, questions: 0 }, parentId: null })
    expect(JSON.stringify(heard())).not.toContain('a secret in here')
    expect(JSON.stringify(heard())).not.toContain('please go on')
  })

  it('hears that a session was deleted', async () => {
    const s = await session()
    await start()
    await until(() => last(s.id), (x) => !!x)
    await w.rpc('agents.deleteSession', { sessionId: s.id })
    await until(() => heard().flatMap((h) => h.gone), (g) => g.includes(s.id))
  })

  it("hears nothing of another project's sessions", async () => {
    const other = join(w.root, 'other')
    mkdirSync(other)
    const { execFileSync } = await import('node:child_process')
    execFileSync('git', ['init', '-q', '-b', 'main', other])
    const otherId = ((await w.rpc('projects.add', { path: other })) as { id: string }).id
    const mine = await session()
    const theirs = (await w.rpc('agents.createSession', { projectId: otherId, cwd: other, tool: 'claude' })) as SessionInfo
    await start()
    await until(() => last(mine.id), (x) => !!x)
    await w.mgr.appNotice(theirs.id, 'hello', board)
    await until(() => w.mgr.listSessions().find((x) => x.id === theirs.id)?.state, (st) => st === 'working' || st === 'idle')
    expect(heard().flatMap((h) => h.sessions).map((x) => x.id)).not.toContain(theirs.id)
  })
})
