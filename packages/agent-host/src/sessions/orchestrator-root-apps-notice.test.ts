import type { SessionInfo } from '@cc/protocol'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Store } from '../dev-services/store.js'
import type { FakeAdapter } from './manager.test-helpers.js'
import { managerWorld, projectDirs } from './manager.test-helpers.js'
import type { SessionManager } from './manager.js'
import { ROOT_APPS_NOTICE } from './session-app-wiring.js'
import { APP_NAMES_PREFIX } from './session-apps.js'

/**
 * An orchestrator that had root apps attached before #1205 (each was given to it as an `mcp__app-<id>` server) reads
 * once, on its first turn by this build, why those names are gone and how to get the app back. Never again, and never
 * for an orchestrator that had none.
 */

let store: Store
let adapter: FakeAdapter
let mgr: SessionManager
let rpc: ReturnType<typeof managerWorld>['rpc']
const dir = projectDirs()

beforeEach(() => {
  ;({ store, adapter, mgr, rpc } = managerWorld())
})

const LINE = `[Centralu] ${ROOT_APPS_NOTICE}`

describe('the one-time line on root apps no longer attached (#1205)', () => {
  it('goes before the first turn of an orchestrator that had a root app, once', async () => {
    const orc = await mgr.orchestrator()
    // The names it saw: a user-folder app (still given) and a project's root app (given before #1205)
    store.settings.setAppSetting(`${APP_NAMES_PREFIX}${orc.id}`, JSON.stringify({ '_user/timer': 'app-timer', 'p1/board': 'app-board' }))
    await mgr.send(orc.id, 'what is on the board?')
    await mgr.send(orc.id, 'and now?')
    const sent = adapter.handleOf(orc.id)!.sent
    expect(sent[0]).toBe(`${LINE}\n\nwhat is on the board?`)
    expect(sent[1]).toBe('and now?')
    expect(ROOT_APPS_NOTICE).toContain('find_apps command')
    // The conversation keeps the person's words as they wrote them (the fake agent's echo aside)
    const said = store.messages.loadMessages(orc.id).filter((r) => r.role === 'user').map((r) => (r.payload as { text: string }).text)
    expect(said).toEqual(['what is on the board?', 'and now?'])
  })

  /*
   * A report is often an orchestrator's first turn of the day. What the model reads of it is Centralu's words about the
   * other session (#1186), and the line goes before them, as before any other turn's text, and is not used up unsaid
   */
  it("goes before a report's words when the report is the first turn", async () => {
    const orc = await mgr.orchestrator()
    const tools = adapter.lastOrchestratorTools!
    store.settings.setAppSetting(`${APP_NAMES_PREFIX}${orc.id}`, JSON.stringify({ 'p1/board': 'app-board' }))
    const cwd = dir('cc-notice-')
    const { id: projectId } = (await rpc('projects.add', { path: cwd })) as { id: string }
    const worker = (await rpc('agents.createSession', { projectId, cwd, tool: 'claude' })) as SessionInfo
    await tools.sendToSession(worker.id, 'tell me when done', true)
    adapter.handleOf(worker.id)!.finishTurn()
    await new Promise((r) => setTimeout(r, 0))
    const report = adapter.handleOf(orc.id)!.sent[0]!
    expect(report.startsWith(`${LINE}\n\n[Centralu] The assigned work finished.`)).toBe(true)
    expect(report).toContain(`sourceSessionId: ${worker.id}`)
  })

  it('is not said to an orchestrator that had only user-folder apps, nor later when it attaches a root app itself', async () => {
    const orc = await mgr.orchestrator()
    store.settings.setAppSetting(`${APP_NAMES_PREFIX}${orc.id}`, JSON.stringify({ '_user/timer': 'app-timer' }))
    await mgr.send(orc.id, 'hello')
    // It attaches a root app with attach_app, which writes its name in the book: that is not a root app it lost
    store.settings.setAppSetting(`${APP_NAMES_PREFIX}${orc.id}`, JSON.stringify({ '_user/timer': 'app-timer', 'p1/board': 'app-board' }))
    await mgr.send(orc.id, 'again')
    expect(adapter.handleOf(orc.id)!.sent).toEqual(['hello', 'again'])
  })

  it('is never said to a session that is not the orchestrator', async () => {
    const orc = await mgr.orchestrator()
    store.settings.setAppSetting(`${APP_NAMES_PREFIX}${orc.id}`, JSON.stringify({ 'p1/board': 'app-board' }))
    const cwd = dir('cc-notice-')
    const { id: projectId } = (await rpc('projects.add', { path: cwd })) as { id: string }
    const worker = (await rpc('agents.createSession', { projectId, cwd, tool: 'claude' })) as SessionInfo
    store.settings.setAppSetting(`${APP_NAMES_PREFIX}${worker.id}`, JSON.stringify({ 'p2/board': 'app-board' }))
    await mgr.send(worker.id, 'hi')
    expect(adapter.handleOf(worker.id)!.sent).toEqual(['hi'])
  })
})
