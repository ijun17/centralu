/**
 * SessionManager through RPC with an in-memory adapter: creating, running, restarting and deleting sessions.
 * Shared fakes and the world each test starts from are in manager.test-helpers.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { GridPanel, NormalizedEvent, SessionInfo, StoredMessage, ToolName, TrashedSession, UsageHistory } from '@cc/protocol'
import { NormalizedEvent as NormalizedEventSchema } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { openCodeUsageReader } from '../adapters/opencode/usage.js'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'
import { createRpcHandler } from '../rpc.js'
import { FakeAdapter, managerWorld } from './manager.test-helpers.js'

let store: Store
let adapter: FakeAdapter
let codexAdapter: FakeAdapter
let mgr: SessionManager
let events: NormalizedEvent[]
let rpc: ReturnType<typeof createRpcHandler>

beforeEach(() => {
  ;({ store, adapter, codexAdapter, mgr, events, rpc } = managerWorld())
})

const addProject = () => rpc('projects.add', { path: tmpdir() }) as Promise<{ id: string; path: string }>

describe('registry defaults', () => {
  it('serves projects with no adapters and rejects session creation only when requested', async () => {
    const adapters = new Map<ToolName, AgentAdapter>()
    const emptyManager = new SessionManager(store, adapters, (e) => events.push(e))
    const emptyRpc = createRpcHandler(emptyManager, adapters)
    const project = (await emptyRpc('projects.add', { path: tmpdir() })) as { id: string; path: string }

    // A stale saved choice cannot turn an empty registry into a usable agent.
    store.projects.setProjectDefaultTool(project.id, 'claude')
    expect(await emptyRpc('projects.list', {})).toEqual([expect.objectContaining({ id: project.id, defaultTool: null })])
    expect(await emptyRpc('agents.detect', {})).toEqual([])
    await expect(emptyRpc('orchestrator.get', {})).rejects.toMatchObject({
      code: 'tool_not_installed', message: expect.stringContaining('No agent adapter is available'),
    })
    await expect(emptyManager.createSession({ projectId: project.id, cwd: project.path, tool: null, permissionPreset: 'normal' })).rejects.toMatchObject({
      code: 'tool_not_installed', message: expect.stringContaining('Install and configure an agent CLI'),
    })
    expect(emptyManager.listSessions()).toEqual([])
  })

  it('runs with a third adapter without changing manager code', async () => {
    const third = new FakeAdapter()
    third.tool = 'fixture-agent'
    third.descriptor = { ...third.descriptor, name: third.tool, label: 'Fixture agent' }
    const adapters = new Map<ToolName, AgentAdapter>([[third.tool, third]])
    const thirdManager = new SessionManager(store, adapters, (e) => events.push(e))
    const thirdRpc = createRpcHandler(thirdManager, adapters)
    const project = (await thirdRpc('projects.add', { path: tmpdir() })) as { id: string; path: string }

    expect(((await thirdRpc('projects.list', {})) as { id: string; defaultTool: string }[]).find((p) => p.id === project.id)?.defaultTool).toBe('fixture-agent')
    await thirdManager.orchestrator()
    expect(third.lastOpts?.sessionId).toBeTruthy()
  })
})

describe('session lifecycle', () => {
  /*
   * When the host dies, the session process dies with it. But the last state remains in the DB,
   * so on the next start there is no process at all yet the screen shows "working" forever
   * (dogfooding: stuck in working for over 40 minutes. The workaround at the time was
   * archive-then-restore, but archiving was later dropped).
   */
  it('corrects working/waiting_approval with no process at startup back to idle', async () => {
    const p = await addProject()
    const live = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('agents.send', { sessionId: live.id, text: 'hi' })
    expect((store.sessions.listSessions().find((s) => s.id === live.id)!).state).toBe('working')

    // Restart the host — create a new manager with the same store (there is not a single process).
    const restarted = new SessionManager(store, new Map<ToolName, AgentAdapter>([['claude', adapter]]), (e) => events.push(e))
    const after = (await createRpcHandler(restarted, new Map<ToolName, AgentAdapter>([['claude', adapter]]))('sessions.list', {})) as {
      id: string
      state: string
    }[]

    expect(after.find((s) => s.id === live.id)!.state).toBe('idle')
    // The DB must be corrected too, not just the screen — it must not come back to life on the next start.
    expect(store.sessions.listSessions().find((s) => s.id === live.id)!.state).toBe('idle')
  })

  /*
   * The context gauge was empty after a restart (issue #48).
   *
   * The value read was correct from the start — it just was not persisted. So on restart, that
   * session's gauge stayed empty **until it ran another turn**, and looked like a broken
   * instrument on screen. Unlike other while-alive fields such as approvals and questions, this
   * is not a fact about our process but **a fact about the conversation**, so it needs to outlive
   * the host.
   */
  it('context usage survives the host being turned off and on (#48)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    // The tool answers as the turn ends — the only moment this app receives this value.
    adapter.handleOf(s.id)!.emitContext(168_000, 200_000)

    // Restart the host — create a new manager with the same store (everything that was in memory is gone).
    const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter], ['codex', codexAdapter]])
    const restarted = new SessionManager(store, adapters, () => {})
    const after = (await createRpcHandler(restarted, adapters)('sessions.list', {})) as SessionInfo[]

    expect(after.find((x) => x.id === s.id)!.context).toEqual({ used: 168_000, window: 200_000, exactness: 'exact' })
    // A session that has never answered is still unknown — this is where the distinction between "—" and
    // "0%" begins.
    const quiet = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'codex' })) as { id: string }
    expect(store.sessions.listSessions().find((x) => x.id === quiet.id)!.context).toBeNull()
  })

  /*
   * /clear swaps out the conversation id (measured 2026-08-26): on /clear, claude issues a new
   * init with a **new session_id**, and the adapter updates the handle's externalId to that
   * value. If onEvent's catch-up does not carry this value through to the DB, the next resume
   * attaches with the old id and **the cleared conversation comes back to life.**
   * (codex, as measured, has nothing like /clear — its thread id does not change while it is alive)
   */
  it('when /clear changes the conversation id, the next event carries it through to the DB', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    expect(store.sessions.listSessions().find((x) => x.id === s.id)!.externalId).toBe('ext-1')

    const h = adapter.handleOf(s.id)!
    h.externalId = 'ext-after-clear' // The state the adapter updates to on the new init
    h.finishTurn() // The event flows as the /clear turn finishes

    expect(store.sessions.listSessions().find((x) => x.id === s.id)!.externalId).toBe('ext-after-clear')
  })

  it('create → send → event propagation', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('agents.send', { sessionId: s.id, text: 'hi' })
    expect(adapter.last!.sent).toEqual(['hi'])
    expect(events.some((e) => e.type === 'message_delta' && e.text === 'echo:hi')).toBe(true)
  })

  it('the first message becomes the session name (FR-18)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('agents.send', { sessionId: s.id, text: 'refactor the auth module' })
    const list = (await rpc('sessions.list', {})) as { id: string; name: string }[]
    expect(list[0]!.name).toBe('refactor the auth module')
    expect(events.some((e) => e.type === 'session_title')).toBe(true)
  })

  it('automatic updates stop after a manual rename', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('sessions.rename', { sessionId: s.id, name: 'My session' })
    await rpc('agents.send', { sessionId: s.id, text: 'a different prompt' })
    const list = (await rpc('sessions.list', {})) as { name: string }[]
    expect(list[0]!.name).toBe('My session')
  })

  /*
   * A rename must never fail while the UI shows a success face (issue #5). It used to silently
   * return when the session did not exist, and the RPC still answered {ok:true}.
   */
  it('renaming a nonexistent session comes back as a failure', async () => {
    await expect(rpc('sessions.rename', { sessionId: 'nope', name: 'My session' })).rejects.toThrow(/not found/i)
  })

  it('rejects an empty name — it would become a row in the list that points at nothing', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await expect(rpc('sessions.rename', { sessionId: s.id, name: '   ' })).rejects.toThrow(/empty/i)
    const list = (await rpc('sessions.list', {})) as { name: string }[]
    expect(list[0]!.name).toBe('New session')
  })

  it("a name the person set is reported with auto:false — the receiving side's basis for blocking automatic renaming", async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    await rpc('sessions.rename', { sessionId: s.id, name: 'Guard MCP' })
    const titles = events.filter((e) => e.type === 'session_title') as { title: string; auto: boolean }[]
    expect(titles.at(-1)).toMatchObject({ title: 'Guard MCP', auto: false })
  })

  it('operating on a nonexistent session gives session_not_found', async () => {
    await expect(rpc('agents.send', { sessionId: 'nope', text: 'x' })).rejects.toMatchObject({ code: 'session_not_found' })
  })

  it('detects concurrent sessions (the basis for the FR-2 warning)', async () => {
    const p = await addProject()
    await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })
    await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })
    expect(mgr.activeSessionsIn(p.id)).toHaveLength(2)
  })
})

describe('RPC in general', () => {
  it('returns capabilities and detect', async () => {
    expect(await rpc('agents.capabilities', { tool: 'claude' })).toMatchObject({ approvals: true })
    // Returns the registered adapters as they are (checks the content, not the count — this does not break
    // as the harness grows).
    // The detect result now carries the descriptor along with it — one bundle so the screen does not have
    // to look up the label separately.
    const found = (await rpc('agents.detect', {})) as { name: string; label: string }[]
    expect(found.map((x) => x.name)).toContain('claude')
    expect(found.find((x) => x.name === 'claude')?.label).toBe('Claude Code')
  })

  it('an unknown method is an error', async () => {
    await expect(rpc('nope.nope', {})).rejects.toThrow(/Unknown method/)
  })

  it('invalid parameters are caught by validation', async () => {
    await expect(rpc('agents.send', { sessionId: 123 })).rejects.toThrow()
  })
})

describe('deleting a session', () => {
  /*
   * #204: deleting moves the session to the session archive. This is the guard across the host's listing paths — every place a
   * person, an agent or an app lists or searches sessions — and of the way back. The apps' `sessions.list` reads the
   * same `listSessions` as the RPC here (app-host-data.test.ts holds its shape).
   */
  it('a deleted session is out of every list, search and agent tool, and comes back from the session archive as it was', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as SessionInfo
    await rpc('agents.send', { sessionId: s.id, text: 'the codename is BLUEBIRD' })
    await rpc('grid.set', { panels: [{ kind: 'session', sessionId: s.id }] })
    const orch = await mgr.orchestrator()
    // The reply may still be streaming when the session is deleted; it is written out then, so its time moves
    const said = (rows: unknown) => (rows as StoredMessage[]).map(({ seq, role, kind, payload }) => ({ seq, role, kind, payload }))
    const before = said(await rpc('messages.load', { sessionId: s.id, limit: 100 }))
    expect(before.length).toBeGreaterThan(0)
    const reach = async () => ({
      sessions: ((await rpc('sessions.list', {})) as SessionInfo[]).some((x) => x.id === s.id),
      grid: ((await rpc('grid.get', { tagged: true })) as GridPanel[]).some((x) => x.kind === 'session' && x.sessionId === s.id),
      search: ((await rpc('messages.search', { query: 'BLUEBIRD' })) as unknown[]).length > 0,
      listTool: JSON.stringify(await mgr.runOrchestratorTool(orch.id, 'list_sessions', {})).includes(s.id),
      recall: JSON.stringify(await mgr.runOrchestratorTool(orch.id, 'recall', { query: 'BLUEBIRD' })).includes(s.id),
      read: JSON.stringify(await mgr.runOrchestratorTool(orch.id, 'read_session', { sessionId: s.id })).includes('BLUEBIRD'),
    })
    expect(await reach()).toEqual({ sessions: true, grid: true, search: true, listTool: true, recall: true, read: true })

    await rpc('agents.deleteSession', { sessionId: s.id })
    expect(await reach()).toEqual({ sessions: false, grid: false, search: false, listTool: false, recall: false, read: false })

    // The way back: listed with what it holds, readable, restorable
    const trash = (await rpc('trash.list', {})) as { sessions: TrashedSession[]; bytes: number }
    expect(trash.sessions.map((x) => [x.id, x.project?.id, x.project?.exists, x.messages])).toEqual([[s.id, p.id, true, before.length]])
    expect(trash.bytes).toBeGreaterThan(0)
    expect(said(await rpc('trash.read', { sessionId: s.id }))).toEqual(before)
    await rpc('trash.restore', { sessionId: s.id })
    // Back in its lists and in search; the grid is layout and is not put back
    expect(await reach()).toEqual({ sessions: true, grid: false, search: true, listTool: true, recall: true, read: true })
    expect(said(await rpc('messages.load', { sessionId: s.id, limit: 100 }))).toEqual(before)
    expect(events.some((e) => e.type === 'session_created' && e.sessionId === s.id)).toBe(true)

    // Only deleting it for good, from the session archive, takes the conversation
    await rpc('agents.deleteSession', { sessionId: s.id })
    await rpc('trash.purge', { sessionId: s.id })
    expect(await rpc('messages.load', { sessionId: s.id, limit: 100 })).toEqual([])
    expect(((await rpc('trash.list', {})) as { sessions: unknown[] }).sessions).toEqual([])
    await expect(rpc('trash.read', { sessionId: s.id })).rejects.toThrow(/Not in the session archive/)
  })

  /**
   * The boundary does not let anything that is not an id through (#94).
   *
   * Deletion goes all the way to cleaning up attachments **without checking whether the session
   * exists** — so before this was fixed, a single `'../../Documents'` got back `{ ok: true }` while
   * an entire folder two levels above the data folder vanished. What this test measures is not
   * "it did not delete" but **"it never even got in"**: it has to end before the session lookup.
   */
  it('a delete request ends at the boundary when the session id is not a path segment (#94)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cc-del94-'))
    vi.stubEnv('CC_DATA_DIR', join(root, 'data'))
    const victim = join(root, 'Documents')
    mkdirSync(victim, { recursive: true })
    writeFileSync(join(victim, 'taxes.txt'), 'important')
    try {
      await expect(rpc('agents.deleteSession', { sessionId: '../../Documents' })).rejects.toThrow()
      expect(readdirSync(victim)).toEqual(['taxes.txt'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('restarting an agent', () => {
  it('swaps only the process and keeps the conversation record', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    await rpc('agents.send', { sessionId: s.id, text: 'First words' })
    const before = adapter.last!

    const r = (await rpc('agents.restartSession', { sessionId: s.id })) as { resumed: boolean }
    expect(r.resumed).toBe(true)
    expect(before.disposed).toBe(true) // The old process gets cleaned up.
    expect(adapter.last).not.toBe(before) // Swapped in a new process.
    expect(mgr.isLive(s.id)).toBe(true)

    const msgs = (await rpc('messages.load', { sessionId: s.id, limit: 100 })) as { payload: { text?: string } }[]
    expect(msgs.some((m) => m.payload.text === 'First words')).toBe(true)
  })
})

describe('automatic continuation', () => {
  it('sending a message revives the session and sends it, even with no process', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    // The state after a host restart: the record and external_id exist, only the process is missing.
    // Bring down only the process (the same state as a host restart) — this used to be produced by
    // archive/restore.
    await mgr.disposeAll()
    expect(mgr.isLive(s.id)).toBe(false)

    await rpc('agents.send', { sessionId: s.id, text: 'keep going' })

    expect(mgr.isLive(s.id)).toBe(true)
    expect(adapter.last!.sent).toContain('keep going')
  })

  it('a start the tool refused as not signed in keeps that code, so the screen can offer the sign-in', async () => {
    const p = await addProject()
    adapter.failCreate = Object.assign(new Error('The tool is not signed in'), { code: 'not_logged_in' })
    await expect(rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })).rejects.toMatchObject({ code: 'not_logged_in', message: expect.stringMatching(/not signed in/) })
    adapter.failCreate = Object.assign(new Error('something else'), { code: 'session_not_found' })
    await expect(rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })).rejects.toMatchObject({ code: 'internal' })
  })

  it('when it truly cannot resume, it throws a reason instead of swallowing it silently', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    // Bring down only the process (the same state as a host restart) — this used to be produced by
    // archive/restore.
    await mgr.disposeAll()
    // A situation where the tool itself fails to start.
    adapter.failCreate = 'Could not start the tool'

    await expect(rpc('agents.send', { sessionId: s.id, text: 'continue' })).rejects.toThrow(/Could not resume the conversation/)
    // A message that failed to send does not end up in the record either (it does not fabricate a
    // conversation that never happened).
    const msgs = (await rpc('messages.load', { sessionId: s.id, limit: 100 })) as { payload: { text?: string } }[]
    expect(msgs.some((m) => m.payload.text === 'continue')).toBe(false)
  })
})

/**
 * Permissions and the model are fixed when the tool process is launched.
 * Fixing only a live session's metadata leaves the screen saying "auto" while it keeps asking
 * for approval (dogfooding: "I switched permissions to auto, why is it still asking me").
 */
describe('a settings change actually takes effect', () => {
  /*
   * #659: the answer goes to the caller only, so every other window (and the person's own window when an agent made
   * the call) kept the old model and permission preset until a re-list. The sink here stands for every subscriber.
   */
  it('tells every subscriber the new model and permission preset, not only the caller (#659)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', model: 'fable', permissionPreset: 'normal',
    })) as { id: string }
    events.length = 0

    await rpc('agents.updateSettings', { sessionId: s.id, model: 'opus', permissionPreset: 'auto' })

    const changed = events.filter((e) => e.type === 'settings_changed' && e.sessionId === s.id)
    expect(changed).toHaveLength(1)
    expect(changed[0]).toMatchObject({ model: 'opus', permissionPreset: 'auto', person: true })
    expect(changed[0]).not.toHaveProperty('by')
    // What goes out is a valid frame, the way the transport checks it
    expect(NormalizedEventSchema.safeParse(changed[0]).success).toBe(true)

    // The next change is a full snapshot again, so a window that missed the first one still ends up right
    events.length = 0
    await rpc('agents.updateSettings', { sessionId: s.id, effort: 'high' })
    expect(events.filter((e) => e.type === 'settings_changed')).toMatchObject([{ model: 'opus', effort: 'high', permissionPreset: 'auto' }])
  })

  /*
   * #659 review: the orchestrator's settings tool on a linked machine reaches that machine's `agents.updateSettings`.
   * Without its origin the machine announced the change as a person's, and the hub's window raised no toast.
   */
  it("announces a change as the orchestrator's when the call says so, with no person flag (#659)", async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', model: 'fable' })) as { id: string }
    events.length = 0

    await rpc('agents.updateSettings', { sessionId: s.id, model: 'opus', by: 'orchestrator' })

    const changed = events.filter((e) => e.type === 'settings_changed')
    expect(changed).toMatchObject([{ model: 'opus', by: 'orchestrator' }])
    expect(changed[0]).not.toHaveProperty('person')
  })

  it('sends nothing for a session that does not exist (#659)', async () => {
    events.length = 0
    await expect(mgr.updateSettings('nope', { model: 'opus' })).rejects.toMatchObject({ code: 'session_not_found' })
    expect(events.filter((e) => e.type === 'settings_changed')).toEqual([])
  })

  it('changing permissions swaps out the live agent', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal',
    })) as { id: string }
    const before = adapter.last!

    await rpc('agents.updateSettings', { sessionId: s.id, permissionPreset: 'auto' })

    // It does not just quietly fix the metadata — it relaunches the process with the new settings.
    expect(before.disposed).toBe(true)
    expect(adapter.last).not.toBe(before)
    expect(mgr.listSessions().find((x) => x.id === s.id)!.permissionPreset).toBe('auto')
    expect(mgr.isLive(s.id)).toBe(true)
  })

  /*
   * Unlike effort, verbosity (#54) cannot be changed per turn (there is no place for it in
   * codex's turn/start). So **swapping the process** is the only way this setting takes effect,
   * and only checking that the new process actually launched with that value tells us the
   * plumbing runs all the way through.
   */
  it('changing verbosity swaps the process, and the new one launches with that value (#54)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal',
    })) as { id: string }
    const before = adapter.last!

    await rpc('agents.updateSettings', { sessionId: s.id, verbosity: 'low' })

    expect(before.disposed).toBe(true)
    expect(adapter.last).not.toBe(before)
    expect(adapter.lastOpts?.verbosity).toBe('low')
    expect(mgr.listSessions().find((x) => x.id === s.id)!.verbosity).toBe('low')
    expect(mgr.isLive(s.id)).toBe(true)
  })

  /*
   * A Claude goal survives a process swap inside the CLI (it restores it from the transcript) but says
   * nothing about it on the stream (measured 2026-10-03). The new process has to be told, or it would
   * not know the goal it runs and a met goal would leave the badge up.
   */
  it('a swapped process is handed the goal the session had (knownGoal)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal',
    })) as { id: string }
    const goal = { objective: 'the file done.txt exists', status: 'active', iterations: 1 }
    adapter.last!.emitEvent({ type: 'goal', sessionId: s.id, goal })

    await rpc('agents.updateSettings', { sessionId: s.id, verbosity: 'low' })

    expect(adapter.lastOpts?.resumeExternalId).toBe('ext-1')
    expect(adapter.lastOpts?.knownGoal).toEqual(goal)
  })

  it('saving the same value again does not touch the process', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal',
    })) as { id: string }
    const before = adapter.last!

    await rpc('agents.updateSettings', { sessionId: s.id, permissionPreset: 'normal' })

    expect(before.disposed).toBe(false)
    expect(adapter.last).toBe(before)
  })

  it('a sleeping session only has its metadata fixed (it launches with the new settings next time)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal',
    })) as { id: string }
    // Bring down only the process (the same state as a host restart) — this used to be produced by
    // archive/restore.
    await mgr.disposeAll()

    await rpc('agents.updateSettings', { sessionId: s.id, permissionPreset: 'auto' })
    expect(mgr.listSessions().find((x) => x.id === s.id)!.permissionPreset).toBe('auto')
    expect(mgr.isLive(s.id)).toBe(false)
  })
})

/**
 * The problem where the screen said "auto" but kept asking for approval (5th round of
 * dogfooding). Because the comparison baseline was meta (the screen's value), a session whose
 * meta was already auto got judged "nothing changed" even when reselected, and the process
 * running on the old settings was left in place.
 */
describe('settings drift is judged against the process, not the screen value', () => {
  it('when meta is already auto but the process is normal, reselecting the same value still swaps it', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'normal',
    })) as { id: string }
    const before = adapter.last!

    // Reproduces the drifted state an older version left behind: a session whose stored value alone changed
    // to auto.
    const internals = mgr as unknown as { meta: Map<string, { permissionPreset: string }> }
    internals.meta.get(s.id)!.permissionPreset = 'auto'

    // The user reselects "auto" on the screen (no change by the meta baseline).
    await rpc('agents.updateSettings', { sessionId: s.id, permissionPreset: 'auto' })

    expect(before.disposed).toBe(true)
    expect(adapter.last).not.toBe(before)
    expect(mgr.isLive(s.id)).toBe(true)
  })

  it('leaves it alone when the process and the screen value already match', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', permissionPreset: 'auto',
    })) as { id: string }
    const before = adapter.last!

    await rpc('agents.updateSettings', { sessionId: s.id, permissionPreset: 'auto' })

    expect(before.disposed).toBe(false)
    expect(adapter.last).toBe(before)
  })
})

/**
 * Even if one dispose fails on the shutdown path, the rest must still be cleaned up.
 * With Promise.all, a single rejection cuts off the whole thing and never reaches the cleanup
 * after it (terminal, DB).
 */
describe('disposeAll runs to completion even if one fails', () => {
  it('skips the failing session and cleans up the rest', async () => {
    const p = await addProject()
    const s1 = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const h1 = adapter.handleOf(s1.id)!
    const s2 = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const h2 = adapter.handleOf(s2.id)!
    h1.dispose = async () => {
      throw new Error('This process refuses to die')
    }

    await expect(mgr.disposeAll()).resolves.toBeUndefined()
    expect(h2.disposed).toBe(true)
    expect(mgr.isLive(s1.id)).toBe(false)
    expect(mgr.isLive(s2.id)).toBe(false)
  })
})

/**
 * If the adapter reports it died (adapter_crashed) but its handle stays in handles, send() only
 * checks handles.has and **pushes onto a dead queue, so the next message vanishes silently.**
 * Removing the handle turns send's "revive and send if there is none" path into automatic
 * recovery.
 */
describe('messaging a crashed session again revives it and sends', () => {
  it('when adapter_crashed arrives the handle is removed, and the next send goes to a new process', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const dead = adapter.handleOf(s.id)!
    // The process died — the adapter reports it (the same path as claude's stream ending in silence).
    ;(dead as unknown as { emit: (e: NormalizedEvent) => void }).emit({
      type: 'error',
      sessionId: s.id,
      error: { code: 'adapter_crashed', message: 'process ended unexpectedly', retryable: true },
    })

    expect(mgr.isLive(s.id)).toBe(false)
    expect(dead.disposed).toBe(true)

    // **The newly revived process** must receive this message, not the dead queue.
    await rpc('agents.send', { sessionId: s.id, text: 'words after the crash' })
    const revived = adapter.handleOf(s.id)!
    expect(revived).not.toBe(dead)
    expect(revived.sent).toContain('words after the crash')
    expect(dead.sent).not.toContain('words after the crash')
  })

  // A lock found after a lazy resume handed the handle out (#168, item 5) leaves a handle with no thread
  it('conversation_locked from a live handle removes it too, so the session reads as dormant', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const held = adapter.handleOf(s.id)!
    ;(held as unknown as { emit: (e: NormalizedEvent) => void }).emit({
      type: 'error',
      sessionId: s.id,
      error: { code: 'conversation_locked', message: 'This conversation is already open elsewhere', retryable: true },
    })

    expect(mgr.isLive(s.id)).toBe(false)
    expect(held.disposed).toBe(true)
  })
})

/*
 * A reconnected UI missed events — the list (SessionInfo) has to carry while-alive facts too, so
 * a session with state=waiting_approval can have its card redrawn and answered by requestId.
 * While these fields were missing, the approval card never came back after a reconnect
 * (measured).
 */
describe('while-alive facts are carried in the list', () => {
  const listed = async (id: string) =>
    ((await rpc('sessions.list', {})) as SessionInfo[]).find((x) => x.id === id)!

  it('an approval request is carried as pendingApproval, and cleared once resolved', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const h = adapter.handleOf(s.id)!

    h.emitApproval('req-1')
    let m = await listed(s.id)
    expect(m.state).toBe('waiting_approval')
    expect(m.pendingApproval).toEqual({
      requestId: 'req-1',
      detail: { kind: 'command', command: 'rm -rf node_modules', cwd: '/tmp' },
    })

    h.respondApproval('req-1', 'allow')
    m = await listed(s.id)
    expect(m.pendingApproval).toBeNull()
  })

  it('activity, limit, usage, and context are carried too, and the limit clears on recovery', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const h = adapter.handleOf(s.id)!
    const emit = (e: NormalizedEvent) => (h as unknown as { emit: (e: NormalizedEvent) => void }).emit(e)

    emit({ type: 'usage_update', sessionId: s.id, tokens: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 } })
    emit({ type: 'context_update', sessionId: s.id, used: 100, window: 1000, exactness: 'exact' })
    emit({ type: 'limit_reached', sessionId: s.id, resumeAt: '2026-08-19T12:00:00Z' })
    let m = await listed(s.id)
    expect(m.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 })
    expect(m.context).toEqual({ used: 100, window: 1000, exactness: 'exact' })
    expect(m.limit?.resumeAt).toBe('2026-08-19T12:00:00Z')

    // Once deltas flow again (recovery), the basis for the limit banner must disappear.
    h.emitDelta('working again')
    m = await listed(s.id)
    expect(m.limit).toBeNull()
  })

  it('answers the cache figures alone when the hub shows its own limits for this machine, and says which account it is logged in to (#726)', async () => {
    let reads = 0
    Object.assign(adapter, {
      listUsage: async () => (reads++, { plan: 'max', windows: [], daily: [] }),
      account: async () => ({ loggedIn: true, fingerprint: 'abc' }),
    })
    expect(await rpc('agents.usage', { tool: 'claude', limits: false })).toMatchObject({ supported: true, usage: null, cache: expect.anything() })
    expect(reads).toBe(0)
    expect(await rpc('agents.usage', { tool: 'claude' })).toMatchObject({ supported: true, usage: { plan: 'max' } })
    expect(reads).toBe(1)
    expect(await rpc('agents.account', { tool: 'claude' })).toEqual({ loggedIn: true, fingerprint: 'abc' })
    // A tool whose adapter does not say answers unknown, not an error
    expect(await rpc('agents.account', { tool: 'codex' })).toEqual({ loggedIn: null, fingerprint: null })
  })

  it('marks only a tool with no way to report usage as notReported, not a read that failed (#1616)', async () => {
    Object.assign(adapter, { listUsage: async () => Promise.reject(new Error('not logged in')) })
    const failed = await rpc('agents.usage', { tool: 'claude' })
    expect(failed).toMatchObject({ supported: false, reason: 'not logged in' })
    expect(failed).not.toHaveProperty('notReported')
    Object.assign(adapter, { listUsage: undefined })
    expect(await rpc('agents.usage', { tool: 'claude' })).toMatchObject({
      supported: false,
      reason: 'Claude Code does not report usage limits',
      notReported: true,
    })
  })

  it('does not say a tool with no adapter reports no limits: nothing is known about it, so it is unknown (#1616)', async () => {
    const r = await rpc('agents.usage', { tool: 'cursor' })
    expect(r).toMatchObject({ supported: false, reason: 'cursor does not support usage queries', usage: null })
    expect(r).not.toHaveProperty('notReported')
  })

  it('has one definition of a tool that reports no limits: its adapter has no listUsage; what it says itself is carried (#1623)', async () => {
    const totals = { scope: 'all time', rows: [{ id: 'input', label: 'Input', value: 5, unit: 'tokens' }] }
    const asks: unknown[] = []
    Object.assign(adapter, {
      listUsage: undefined,
      localUsage: async (ask?: unknown) => (asks.push(ask), { plan: 'Free', totals }),
    })
    const r = await rpc('agents.usage', { tool: 'claude' })
    expect(r).toMatchObject({ supported: false, notReported: true, usage: { plan: 'Free', windows: [], daily: [], totals } })
    expect(r).toHaveProperty('reason', 'Claude Code does not report usage limits')
    expect(r).not.toHaveProperty('provisional')
    // The adapter's reader keeps what it read; the host keeps nothing of its own, so each ask goes to it
    await rpc('agents.usage', { tool: 'claude' })
    expect(asks).toHaveLength(2)
    // A tool that has listUsage reports limits, whatever its snapshot says
    Object.assign(adapter, { listUsage: async () => ({ plan: 'max', windows: [], daily: [] }) })
    const limited = await rpc('agents.usage', { tool: 'claude' })
    expect(limited).toMatchObject({ supported: true, usage: { plan: 'max' } })
    expect(limited).not.toHaveProperty('notReported')
  })

  it('passes a provisional answer through, and asks the adapter to settle when the screen does (#1623)', async () => {
    const asks: unknown[] = []
    Object.assign(adapter, {
      listUsage: undefined,
      localUsage: async (ask?: { settle?: boolean }) => (asks.push(ask), ask?.settle ? { plan: 'Free' } : { plan: null, provisional: true }),
    })
    expect(await rpc('agents.usage', { tool: 'claude' })).toMatchObject({ notReported: true, provisional: true, usage: { plan: null } })
    const settled = await rpc('agents.usage', { tool: 'claude', settle: true })
    expect(settled).toMatchObject({ notReported: true, usage: { plan: 'Free' } })
    expect(settled).not.toHaveProperty('provisional')
    expect(asks).toEqual([{ settle: undefined }, { settle: true }])
  })

  it('keeps the totals a read produced, and after a restart answers them at once with the time they were read (#1623)', async () => {
    const read = { scope: 'all time', asOf: 1_700_000_000_000, rows: [{ id: 'sessions', label: 'Sessions', value: 1204, unit: 'count' }] }
    Object.assign(adapter, { listUsage: undefined, localUsage: async () => ({ plan: null, totals: read }) })
    await rpc('agents.usage', { tool: 'claude' })
    // Asked again with the same read (a stale answer returned): nothing is written again
    const saved = vi.spyOn(store.usage, 'saveLocalTotals')
    await rpc('agents.usage', { tool: 'claude' })
    expect(saved).not.toHaveBeenCalled()
    expect(store.usage.localTotals('claude')).toEqual(read)

    // A new process on the same store, whose command is still reading: the reader is offered the kept totals as its seed
    const seeds: unknown[] = []
    const slow = new FakeAdapter()
    Object.assign(slow, {
      listUsage: undefined,
      localUsage: async (ask?: { seed?: { totals?: unknown } }) => (seeds.push(ask?.seed?.totals), ask?.seed ?? { plan: null, provisional: true }),
    })
    const adapters = new Map<ToolName, AgentAdapter>([['claude', slow]])
    const next = new SessionManager(store, adapters, () => {})
    const handler = createRpcHandler(next, adapters)
    const restored = (await handler('agents.usage', { tool: 'claude' })) as { usage: { totals: unknown }; provisional?: boolean }
    expect(restored.usage.totals).toEqual(read)
    expect(restored).not.toHaveProperty('provisional')
    await handler('agents.usage', { tool: 'claude' })
    // Offered once: the reader keeps its own answer after that
    expect(seeds).toEqual([read, undefined])
    await next.disposeAll()
  })

  it('tells the screen an old answer is being read again, and a settle brings the new totals with their new time, after a restart or not (#1623)', async () => {
    const table = (sessions: number) => ['│Sessions' + String(sessions).padStart(40) + ' │', '│Messages' + '9'.padStart(40) + ' │'].join(String.fromCharCode(10))
    let clock = 1_000_000
    let release: (out: string) => void = () => {}
    const runs: string[] = []
    // The command ends when the test says, as a slow `opencode stats` does
    const run = (): Promise<string> => new Promise((resolve) => ((release = resolve), runs.push('run')))
    const world = (reader: ReturnType<typeof openCodeUsageReader>) => {
      const a = new FakeAdapter()
      Object.assign(a, { listUsage: undefined, localUsage: reader })
      const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
      const m = new SessionManager(store, adapters, () => {})
      return { ask: createRpcHandler(m, adapters), m }
    }
    const sessionsOf = (r: unknown) => (r as { usage: { totals: { asOf: number; rows: { id: string; value: number }[] } } }).usage.totals
    const first = world(openCodeUsageReader(run, () => clock))
    const firstRead = first.ask('agents.usage', { tool: 'claude', settle: true })
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    release(table(28))
    expect(sessionsOf(await firstRead)).toMatchObject({ asOf: clock, rows: [{ id: 'sessions', value: 28 }, { id: 'messages' }] })

    // Ten minutes on, with no restart: the old totals come back at once, marked provisional, while the command runs
    clock += 10 * 60_000
    const oldAt = sessionsOf(await first.ask('agents.usage', { tool: 'claude' })).asOf
    const stale = (await first.ask('agents.usage', { tool: 'claude' })) as { provisional?: boolean }
    expect(stale.provisional).toBe(true)
    await vi.waitFor(() => expect(runs).toHaveLength(2))
    // The screen's one more ask, with settle, ends when the command does, and carries the new totals and their time
    const settled = first.ask('agents.usage', { tool: 'claude', settle: true })
    clock += 12_000
    release(table(30))
    const fresh = (await settled) as { provisional?: boolean }
    expect(fresh.provisional).toBeUndefined()
    expect(sessionsOf(fresh)).toMatchObject({ asOf: clock, rows: [{ id: 'sessions', value: 30 }, { id: 'messages' }] })
    expect(sessionsOf(fresh).asOf).toBeGreaterThan(oldAt)
    expect(store.usage.localTotals('claude')?.asOf).toBe(clock)
    await first.m.disposeAll()

    // A restart a day later: the kept totals come back at once, provisional, and a settle brings the new read
    clock += 86_400_000
    const second = world(openCodeUsageReader(run, () => clock))
    const kept = (await second.ask('agents.usage', { tool: 'claude' })) as { provisional?: boolean }
    expect(kept.provisional).toBe(true)
    expect(sessionsOf(kept)).toMatchObject({ asOf: clock - 86_400_000, rows: [{ id: 'sessions', value: 30 }, { id: 'messages' }] })
    await vi.waitFor(() => expect(runs).toHaveLength(3))
    const settledAgain = second.ask('agents.usage', { tool: 'claude', settle: true })
    release(table(31))
    expect(sessionsOf(await settledAgain)).toMatchObject({ asOf: clock, rows: [{ id: 'sessions', value: 31 }, { id: 'messages' }] })
    await second.m.disposeAll()
  })

  it('does not keep a provisional answer, nor totals that say nothing of when they were read (#1623)', async () => {
    Object.assign(adapter, {
      listUsage: undefined,
      localUsage: async () => ({ plan: null, provisional: true, totals: { scope: 'all time', asOf: 5, rows: [] } }),
    })
    await rpc('agents.usage', { tool: 'claude' })
    expect(store.usage.localTotals('claude')).toBeNull()
    Object.assign(adapter, { localUsage: async () => ({ plan: null, totals: { scope: 'all time', rows: [] } }) })
    await rpc('agents.usage', { tool: 'claude' })
    expect(store.usage.localTotals('claude')).toBeNull()
  })

  it('answers with the totals even when the store cannot keep them (#1623)', async () => {
    const read = { scope: 'all time', asOf: 9, rows: [] }
    Object.assign(adapter, { listUsage: undefined, localUsage: async () => ({ plan: null, totals: read }) })
    vi.spyOn(store.usage, 'saveLocalTotals').mockImplementation(() => {
      throw new Error('disk full')
    })
    expect(await rpc('agents.usage', { tool: 'claude' })).toMatchObject({ notReported: true, usage: { totals: read } })
  })

  it('tells a tool whose command says nobody is logged in as any tool is, not as one with no limits (#1623)', async () => {
    Object.assign(adapter, { listUsage: undefined, localUsage: async () => ({ plan: null, loggedOut: true }) })
    const r = await rpc('agents.usage', { tool: 'claude' })
    expect(r).toMatchObject({ supported: false, reason: 'Claude Code is not logged in on this computer', usage: null })
    expect(r).not.toHaveProperty('notReported')
  })

  it('runs no command for a tool with no limits when only the cache is wanted, and survives one that throws (#1623)', async () => {
    let runs = 0
    Object.assign(adapter, {
      listUsage: undefined,
      localUsage: async () => {
        runs++
        throw new Error('boom')
      },
    })
    expect(await rpc('agents.usage', { tool: 'claude', limits: false })).toMatchObject({ notReported: true, usage: null })
    expect(runs).toBe(0)
    expect(await rpc('agents.usage', { tool: 'claude' })).toMatchObject({ supported: false, notReported: true, usage: null })
    expect(runs).toBe(1)
  })

  it('counts each model request into the prompt cache figures agents.usage answers with (docs/agent-host.md §6.1)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const h = adapter.handleOf(s.id)!
    const emit = (e: NormalizedEvent) => (h as unknown as { emit: (e: NormalizedEvent) => void }).emit(e)
    const tokens = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 }

    emit({ type: 'usage_update', sessionId: s.id, tokens, request: { inputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 30_000 } })
    emit({ type: 'usage_update', sessionId: s.id, tokens, request: { inputTokens: 5, cacheReadTokens: 30_000, cacheCreationTokens: 500 } })
    // A running reading without a request is not a request
    emit({ type: 'usage_update', sessionId: s.id, tokens })
    await listed(s.id)

    const r = (await rpc('agents.usage', { tool: 'claude' })) as { cache?: { writes: boolean; windows: { id: string; requests: number; cacheReadTokens: number; cacheCreationTokens: number; rebuilds: number; sessions: { sessionId: string; name: string }[] }[] } }
    expect(r.cache?.writes).toBe(true)
    const five = r.cache!.windows.find((w) => w.id === '5h')!
    expect(five).toMatchObject({ requests: 2, cacheReadTokens: 30_000, cacheCreationTokens: 30_500, rebuilds: 1 })
    expect(five.sessions).toMatchObject([{ sessionId: s.id, name: 'New session' }])
  })

  it('keeps the counted requests per hour and answers usage.history with them; a purge takes that session rows (§6.2)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const emit = (e: NormalizedEvent) => (adapter.handleOf(s.id)! as unknown as { emit: (e: NormalizedEvent) => void }).emit(e)
    const tokens = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 }
    emit({ type: 'usage_update', sessionId: s.id, tokens, request: { inputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 30_000, outputTokens: 70, cacheTtl: '1h' } })
    emit({ type: 'usage_update', sessionId: s.id, tokens, request: { inputTokens: 5, cacheReadTokens: 30_000, cacheCreationTokens: 500, outputTokens: 30 } })
    const history = async (by: 'session' | 'project') =>
      (await rpc('usage.history', { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 3_600_000).toISOString(), groupBy: 'day', by })) as UsageHistory

    // Asking flushes what is still in memory, so the answer already has both requests
    const bySession = await history('session')
    expect(bySession.rows).toMatchObject([
      { key: s.id, name: 'New session', requests: 2, inputTokens: 10, cacheReadTokens: 30_000, cacheCreationTokens: 30_500, cacheCreation1hTokens: 30_000, outputTokens: 100, rebuilds: 1, rebuildCauses: { cold_start: 1 } },
    ])
    expect((await history('project')).rows).toMatchObject([{ key: p.id }])

    // A new manager on the same store gets the cache figures back (the restart keeps them)
    const next = new SessionManager(store, new Map<ToolName, AgentAdapter>([['claude', adapter]]), () => {})
    const restored = (await createRpcHandler(next, new Map<ToolName, AgentAdapter>([['claude', adapter]]))('agents.usage', { tool: 'claude' })) as { cache: { windows: { id: string; requests: number }[] } }
    expect(restored.cache.windows.find((w) => w.id === 'today')!.requests).toBe(2)
    await next.disposeAll()

    // In the trash the session can come back, and so do its rows; only the purge takes them
    await rpc('agents.deleteSession', { sessionId: s.id })
    expect((await history('session')).rows).toHaveLength(1)
    // Requests counted but not yet written must not bring the rows back after the purge
    emit({ type: 'usage_update', sessionId: s.id, tokens, request: { inputTokens: 7, cacheReadTokens: 0 } })
    await rpc('trash.purge', { sessionId: s.id })
    expect((await history('session')).rows).toEqual([])
  })

  it('emptying the trash takes the usage rows too, also what was counted a moment before (§6.2)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const tokens = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 }
    ;(adapter.handleOf(s.id)! as unknown as { emit: (e: NormalizedEvent) => void }).emit({ type: 'usage_update', sessionId: s.id, tokens, request: { inputTokens: 7, cacheReadTokens: 0 } })
    await rpc('agents.deleteSession', { sessionId: s.id })
    await rpc('trash.empty', {})
    const range = { from: new Date(Date.now() - 86_400_000).toISOString(), to: new Date(Date.now() + 3_600_000).toISOString(), groupBy: 'day', by: 'session' }
    expect(((await rpc('usage.history', range)) as UsageHistory).rows).toEqual([])
    expect(store.usage.buckets(0, Date.now() + 3_600_000)).toEqual([])
  })

  it('names why each rebuild happened from what the host saw in that session (docs/agent-host.md §6.1)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const tokens = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 }
    const rebuild = async () => {
      const h = adapter.handleOf(s.id)!
      ;(h as unknown as { emit: (e: NormalizedEvent) => void }).emit({
        type: 'usage_update',
        sessionId: s.id,
        tokens,
        request: { inputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 30_000 },
      })
      await listed(s.id)
    }
    const causes = async () => {
      const r = (await rpc('agents.usage', { tool: 'claude' })) as { cache: { windows: { rebuildCauses?: Record<string, number> }[] } }
      return r.cache.windows[0]!.rebuildCauses
    }

    await rebuild()
    expect(await causes()).toEqual({ cold_start: 1 })

    await rpc('agents.updateSettings', { sessionId: s.id, model: 'some-other-model' })
    await rebuild()
    expect(await causes()).toEqual({ cold_start: 1, model_change: 1 })

    const h = adapter.handleOf(s.id)!
    ;(h as unknown as { emit: (e: NormalizedEvent) => void }).emit({ type: 'compaction', sessionId: s.id, failed: false })
    await rebuild()
    expect(await causes()).toEqual({ cold_start: 1, model_change: 1, compaction: 1 })

    await rpc('agents.restartSession', { sessionId: s.id })
    await rebuild()
    expect(await causes()).toEqual({ cold_start: 1, model_change: 1, compaction: 1, new_process: 1 })

    // A restart that says why (a Codex thread restarted for its apps) is named by that reason, not as a new process
    await mgr.restartSession(s.id, 'thread_restart')
    await rebuild()
    expect(await causes()).toEqual({ cold_start: 1, model_change: 1, compaction: 1, new_process: 1, thread_restart: 1 })
  })

  it('clears approvals and questions for dead requestIds when an error arrives', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    const h = adapter.handleOf(s.id)!
    const emit = (e: NormalizedEvent) => (h as unknown as { emit: (e: NormalizedEvent) => void }).emit(e)

    h.emitApproval('req-dead')
    emit({ type: 'question_request', sessionId: s.id, requestId: 'q-dead', questions: [] })
    emit({ type: 'error', sessionId: s.id, error: { code: 'internal', message: 'boom', retryable: false } })

    const m = await listed(s.id)
    expect(m.state).toBe('error')
    expect(m.pendingApproval).toBeNull()
    expect(m.pendingQuestions).toEqual([])
  })
})

/**
 * Deleting the tool's own original too (dogfooding: "actually delete it").
 *
 * Our delete used to clear only our DB, leaving the codex rollout (measured at 550MB) and claude
 * JSONL behind. deleteExternal removes the original only when the person explicitly checks the
 * box. Order is the contract: if deleting the original fails, our side is not deleted either —
 * because the worst outcome is answering "deleted" while the original survives.
 */
describe("deleting the tool's own original too (deleteExternal)", () => {
  class ExternallyDeletableAdapter extends FakeAdapter {
    deletedExternals: { externalId: string; cwd: string }[] = []
    failExternalDelete = false
    async deleteExternalConversation(externalId: string, cwd: string) {
      if (this.failExternalDelete) throw new Error('tool refused to delete')
      this.deletedExternals.push({ externalId, cwd })
    }
  }

  async function setupWith(a: FakeAdapter) {
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    const r = createRpcHandler(m, adapters)
    const p = (await r('projects.add', { path: tmpdir() })) as { id: string; path: string }
    const s = (await r('agents.createSession', {
      projectId: p.id,
      cwd: p.path,
      tool: 'claude',
      permissionPreset: 'normal',
    })) as SessionInfo
    return { m, r, s }
  }

  it('the conversation file waits in the session archive and is deleted with the session, with its externalId and cwd', async () => {
    const a = new ExternallyDeletableAdapter()
    const { m, r, s } = await setupWith(a)
    await r('agents.deleteSession', { sessionId: s.id, deleteExternal: true })
    // In the session archive, not gone: the tool's file is untouched until the person deletes it for good (#204)
    expect(a.deletedExternals).toEqual([])
    expect(m.listSessions().some((x) => x.id === s.id)).toBe(false)
    await r('trash.purge', { sessionId: s.id })
    expect(a.deletedExternals).toEqual([{ externalId: 'ext-1', cwd: tmpdir() }])
  })

  it('leaves the original untouched with no flag — the default is to keep it', async () => {
    const a = new ExternallyDeletableAdapter()
    const { r, s } = await setupWith(a)
    await r('agents.deleteSession', { sessionId: s.id })
    await r('trash.purge', { sessionId: s.id })
    expect(a.deletedExternals).toEqual([])
  })

  it('a conversation file the tool refuses to delete keeps the session in the session archive — "deleted" is never said over a live original', async () => {
    const a = new ExternallyDeletableAdapter()
    a.failExternalDelete = true
    const { m, r, s } = await setupWith(a)
    await r('agents.deleteSession', { sessionId: s.id, deleteExternal: true })
    await expect(m.purgeSession(s.id)).rejects.toThrow(/refused/)
    expect(((await r('trash.list', {})) as { sessions: { id: string }[] }).sessions.map((x) => x.id)).toEqual([s.id])
    expect(store.messages.loadMessages(s.id, 10)).toBeDefined() // The conversation is unchanged too.
  })

  it('says so when the adapter does not support it — quietly deleting only our side would be half a delete', async () => {
    const { m, s } = await setupWith(new FakeAdapter())
    await expect(m.trashSession(s.id, false, true)).rejects.toThrow(/does not support/)
    expect(m.listSessions().some((x) => x.id === s.id)).toBe(true)
  })

  it('a conversation pulled back from Past conversations meanwhile is not deleted with the archived copy', async () => {
    const a = new ExternallyDeletableAdapter()
    const { m, r, s } = await setupWith(a)
    await r('agents.deleteSession', { sessionId: s.id, deleteExternal: true })
    // The person imports the same conversation again: a live session now reads that file
    await r('agents.createSession', {
      projectId: s.projectId, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', permissionPreset: 'normal',
    })
    await m.purgeSession(s.id)
    expect(a.deletedExternals).toEqual([])
  })
})
