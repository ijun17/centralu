import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MANIFEST_FILE } from '../apps/external/manifest.js'
import * as kit from '../apps/external/test-helpers.js'
import { SessionAppsHub, type AppSessionKey } from './session-apps.js'
import { FIXTURE_APP, attachWorld, type AttachWorld } from './session-apps.test-helpers.js'

/**
 * Which session receives which app (M4 A-5, decision 4) — verified against a real runtime and
 * real app processes.
 *
 *   a project's session    that project's apps, only if the project is trusted
 *   orchestrator           only the user-folder apps
 *   an unattached app      an invalid manifest, an untrusted project, an app halted after repeated failures
 *
 * And when that set changes (an app comes or goes, trust flips, the tool list changes), the
 * attached side hears about it.
 */

let w: AttachWorld
let hub: SessionAppsHub

const worker = (projectId: string | null, id = 'w1'): AppSessionKey => ({ id, kind: 'worker', projectId })
const ORCH: AppSessionKey = { id: 'o1', kind: 'orchestrator', projectId: null }
const servers = (key: AppSessionKey) => hub.attach(key).current().map((a) => a.server)

beforeEach(() => {
  w = attachWorld(kit, { maxFailures: 1 })
  w.plant('p1', 'notes')
  w.plant('p1', 'tasks')
  w.plant('p2', 'other')
  w.plant('user', 'helper')
  w.rt.refresh()
  // So an unmatched call (B-1) is not waited on for long — the production value is 5 seconds
  hub = new SessionAppsHub(w.rt, { toolListWaitMs: 10_000, callJoinWaitMs: 300 })
})

afterEach(async () => {
  hub.dispose()
  await w.dispose()
})

describe('decision 4 — which apps attach', () => {
  it('a project session receives only its own trusted project\'s apps, and the orchestrator receives only user-folder apps', () => {
    expect(servers(worker('p1'))).toEqual(['app-notes', 'app-tasks'])
    // A coordinating session is a project session too — the split is by project, not by kind
    expect(servers({ id: 'c1', kind: 'coordinator', projectId: 'p1' })).toEqual(['app-notes', 'app-tasks'])
    // An untrusted project's apps do not attach to that project's sessions either
    expect(servers(worker('p2'))).toEqual([])
    // User-folder apps go only to the orchestrator — a project's apps never go to the orchestrator
    expect(servers(ORCH)).toEqual(['app-helper'])
    // A session with no project (and that is not the orchestrator) receives nothing
    expect(servers(worker(null))).toEqual([])
  })

  it('an invalid manifest and an app halted after repeated failures do not attach, and come back once restarted', async () => {
    w.plant('p1', 'broken', ['--mode', 'crash-on-start'])
    writeFileSync(join(w.roots.p1, '.centralu', 'apps', 'tasks', MANIFEST_FILE), '{ not json')
    w.rt.refresh()
    const a = hub.attach(worker('p1'))
    expect(a.current().map((x) => x.server)).toEqual(['app-broken', 'app-notes'])

    let heard = 0
    a.onChange(() => heard++)
    // The fixture dies the moment it starts up — maxFailures is 1, so it halts after just one
    await w.rt.tools({ projectId: 'p1', appId: 'broken' }).catch(() => {})
    await kit.until(() => heard, (n) => n > 0)
    expect(a.current().map((x) => x.server)).toEqual(['app-notes'])

    await w.rt.restart({ projectId: 'p1', appId: 'broken' })
    await kit.until(() => heard, (n) => n > 1)
    expect(a.current().map((x) => x.server)).toEqual(['app-broken', 'app-notes'])
  })

  it('an imported app does not attach to the orchestrator before the person turns it on, calling it by name is refused, and turning it on attaches it (M4 E-3)', async () => {
    const source = kit.plantApp(join(w.root, 'src'), 'imp', { server: { command: process.execPath, args: [FIXTURE_APP, '--mode', 'attach'] } })
    const { token, review } = await w.rt.prepareImport(source)
    w.rt.commitImport(token, { enable: false })
    const a = hub.attach(ORCH)
    expect(a.current().map((x) => x.server)).toEqual(['app-helper'])
    // Even holding the old name, as a Codex thread would — the runtime blocks it again on every call
    const refused = await w.rt.call({ projectId: null, appId: 'imp' }, 'peek', {}, { kind: 'session', sessionId: 'o1' })
    expect(refused).toMatchObject({ status: 'rejected', error: expect.stringContaining('not enabled yet') })

    let heard = 0
    a.onChange(() => heard++)
    w.rt.enableApp({ projectId: null, appId: 'imp' }, review.reviewKey)
    await kit.until(() => heard, (n) => n > 0)
    expect(a.current().map((x) => x.server)).toEqual(['app-helper', 'app-imp'])
  })
})

describe('whether a session can reach an app, and why not (#308, apps.reach)', () => {
  const notes = { projectId: 'p1', appId: 'notes' }

  it('a session reaches the apps decision 4 gives it, and is told an app it is never given belongs elsewhere', () => {
    expect(hub.reach(worker('p1'), notes)).toEqual({ reachable: true })
    expect(hub.reach(ORCH, { projectId: null, appId: 'helper' })).toEqual({ reachable: true })
    // A building session reaches its own user-folder app, which decision 4 alone would not give it
    expect(hub.reach({ ...worker(null), builderOf: { projectId: null, appId: 'helper' } }, { projectId: null, appId: 'helper' })).toEqual({ reachable: true })

    const elsewhere = { reachable: false, reason: 'other-project' }
    expect(hub.reach(worker('p1'), { projectId: 'p2', appId: 'other' })).toEqual(elsewhere)
    expect(hub.reach(ORCH, notes)).toEqual(elsewhere)
    expect(hub.reach(worker(null), { projectId: null, appId: 'helper' })).toEqual(elsewhere)
    // A session that gets no apps at all (one an app stood up)
    expect(hub.reach(null, notes)).toEqual(elsewhere)
    expect(hub.reach(worker('p1'), { projectId: 'p1', appId: 'gone' })).toEqual({ reachable: false, reason: 'unavailable' })
  })

  it('an app the session would be given says what stops it: the project\'s trust, then the app\'s own state', () => {
    // p2 is untrusted: its own session is told so, not that the app belongs elsewhere
    expect(hub.reach(worker('p2'), { projectId: 'p2', appId: 'other' })).toEqual({ reachable: false, reason: 'untrusted' })
    writeFileSync(join(w.roots.p1, '.centralu', 'apps', 'tasks', MANIFEST_FILE), '{ not json')
    w.rt.refresh()
    expect(hub.reach(worker('p1'), { projectId: 'p1', appId: 'tasks' })).toEqual({ reachable: false, reason: 'app-unusable', status: 'invalid' })
  })

  it('what the live agent has decides last: a thread started without the app, or a bridge that failed', () => {
    const asked: string[] = []
    const live = (answer: 'attached' | 'restart' | 'failed') => ({
      appAttachment: (server: string) => (asked.push(server), answer),
    })
    expect(hub.reach(worker('p1'), notes, live('restart'))).toEqual({ reachable: false, reason: 'restart' })
    expect(hub.reach(worker('p1'), notes, live('failed'))).toEqual({ reachable: false, reason: 'bridge-failed' })
    expect(hub.reach(worker('p1'), notes, live('attached'))).toEqual({ reachable: true })
    expect(asked).toEqual(['app-notes', 'app-notes', 'app-notes'])
    // An agent that follows the set live (Claude) has no say, and one asleep has none either
    expect(hub.reach(worker('p1'), notes, {})).toEqual({ reachable: true })
    // The agent is not asked about an app the rule does not give the session
    expect(hub.reach(worker('p1'), { projectId: 'p2', appId: 'other' }, live('attached'))).toEqual({ reachable: false, reason: 'other-project' })
    expect(asked).toHaveLength(3)
  })
})

describe('hearing about it when the set of attached apps changes', () => {
  it('a notification arrives when an app folder appears or disappears, and current() follows along', async () => {
    const a = hub.attach(worker('p1'))
    let heard = 0
    a.onChange(() => heard++)

    /*
     * Rescanning calls the same function (rescan) that the folder watcher calls. It is called
     * directly here rather than waiting on the watcher's fs events — under parallel test runs,
     * macOS fs events were measured lagging by several seconds, and the watcher itself is
     * covered by discovery.test.ts. What is checked here is only "if a rescan finds a change, it
     * announces it."
     */
    w.plant('p1', 'fresh')
    w.rt.refresh()
    await kit.until(() => a.current().map((x) => x.server), (s) => s.includes('app-fresh'))
    expect(heard).toBeGreaterThan(0)

    const before = heard
    rmSync(join(w.roots.p1, '.centralu', 'apps', 'fresh'), { recursive: true, force: true })
    w.rt.refresh()
    await kit.until(() => a.current().map((x) => x.server), (s) => !s.includes('app-fresh'))
    expect(heard).toBeGreaterThan(before)
  })

  it('flipping trust off detaches every attached app, and flipping it back on reattaches them', async () => {
    const a = hub.attach(worker('p1'))
    let heard = 0
    a.onChange(() => heard++)

    w.trust.p1 = false
    w.rt.refresh()
    await kit.until(() => heard, (n) => n === 1)
    expect(a.current()).toEqual([])

    w.trust.p1 = true
    w.rt.refresh()
    await kit.until(() => heard, (n) => n === 2)
    expect(a.current().map((x) => x.server)).toEqual(['app-notes', 'app-tasks'])
  })

  it('does not announce a change that only concerns another session — a project session stays quiet even when a user-folder app is added', async () => {
    const a = hub.attach(worker('p1'))
    const o = hub.attach(ORCH)
    let heardA = 0
    let heardO = 0
    a.onChange(() => heardA++)
    o.onChange(() => heardO++)

    w.plant('user', 'second')
    w.rt.refresh()
    await kit.until(() => heardO, (n) => n > 0)
    expect(heardA).toBe(0)
  })
})

describe('the tool list', () => {
  it('is unknown at first (null), and reads only the agent tools by spinning up the app the first time it is needed — descriptions and annotations pass through unchanged', async () => {
    const a = hub.attach(worker('p1'))
    expect(a.current().find((x) => x.server === 'app-notes')?.tools).toBeNull()
    // Attaching alone does not spin up the app (performance budget: zero app processes while nothing is happening)
    expect(w.records('notes').filter((r) => r.t === 'start')).toEqual([])

    let heard = 0
    a.onChange(() => heard++)
    const tools = await a.tools('app-notes')
    const names = tools.map((t) => t.name).sort()
    // app_only is UI-only — it never appears in the agent's list. run_status is a tool the host added
    expect(names).toEqual(['echo', 'hold', 'peek', 'poke', 'run_status'])
    expect(tools.find((t) => t.name === 'peek')).toMatchObject({
      title: 'Peek',
      description: 'Reads the value without changing anything',
      annotations: { readOnlyHint: true, openWorldHint: false },
    })
    expect(tools.find((t) => t.name === 'poke')?.inputSchema).toMatchObject({
      type: 'object',
      properties: { to: { type: 'number', description: 'the new value' } },
    })

    // The list read is remembered — even after the app goes down, the next session knows the list without spinning the app up
    await kit.until(() => heard, (n) => n > 0)
    await w.rt.restart({ projectId: 'p1', appId: 'notes' })
    const b = hub.attach(worker('p1', 'w2'))
    expect(b.current().find((x) => x.server === 'app-notes')?.tools?.map((t) => t.name).sort()).toEqual(names)
    expect(w.records('notes').filter((r) => r.t === 'start')).toHaveLength(1)
  })

  it('announces it when the tools change after the app comes back up', async () => {
    const extra = join(w.root, 'extra.json')
    w.plant('p1', 'grows', ['--mode', 'attach', '--extra-from', extra])
    w.rt.refresh()
    const a = hub.attach(worker('p1'))
    await a.tools('app-grows')
    let heard = 0
    a.onChange(() => heard++)

    writeFileSync(extra, JSON.stringify(['added_later']))
    await w.rt.restart({ projectId: 'p1', appId: 'grows' })
    await a.tools('app-grows') // returns the remembered list — spinning the app up happens on the next need
    await w.rt.tools({ projectId: 'p1', appId: 'grows' }, 'model')
    await kit.until(() => heard, (n) => n > 0)
    expect(a.current().find((x) => x.server === 'app-grows')?.tools?.map((t) => t.name)).toContain('added_later')
  })
})

describe('calling', () => {
  it('a session\'s call reaches the runtime, and is recorded, with the caller set to that session', async () => {
    const a = hub.attach(worker('p1', 'sess-rec'))
    const out = await a.call('app-notes', 'poke', { to: 3 })
    expect(out).toMatchObject({ isError: false, content: [{ type: 'text', text: 'poked 3' }] })

    const runs = w.rt.runs({ projectId: 'p1', appId: 'notes' })
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ tool: 'poke', callerKind: 'session', callerSessionId: 'sess-rec', status: 'ok' })
  })

  it('an unattached app cannot be called even by its known name — it never reaches the runtime', async () => {
    const a = hub.attach(worker('p1'))
    // another project's app, a user-folder app
    for (const server of ['app-other', 'app-helper']) {
      const out = await a.call(server, 'echo', { text: 'x' })
      expect(out.isError).toBe(true)
      expect(JSON.stringify(out.content)).toContain('This app is not attached to this session')
    }
    expect(w.rt.runs({ projectId: 'p2', appId: 'other' })).toEqual([])
    expect(w.rt.runs({ projectId: null, appId: 'helper' })).toEqual([])
  })

  it('a call after trust is lost is blocked — checked again on every call, not only when it attached', async () => {
    const a = hub.attach(worker('p1'))
    w.trust.p1 = false
    w.rt.refresh()
    const out = await a.call('app-notes', 'echo', { text: 'x' })
    expect(out.isError).toBe(true)
    expect(w.rt.runs({ projectId: 'p1', appId: 'notes' })).toEqual([])
  })
})

/**
 * Joining a call to its conversation card (M4 B-1). The in-conversation UI stands beneath that
 * call's card — the attachment decides which card that is. If the adapter gives an id, that is
 * it; otherwise it is joined by the call start the adapter saw (`noteCall`) and by matching
 * (server, tool, args), in the order they arrived. The two notifications come by different paths
 * (Codex's stdout, the bridge's WebSocket), so it must work whichever one arrives first.
 */
describe('joining a call to its card id (B-1)', () => {
  const heard = () => {
    const calls: { tool: string; callId: Promise<string | null> }[] = []
    hub.onCall((c) => calls.push({ tool: c.tool, callId: c.callId }))
    return calls
  }

  it('the id the adapter gave is the card', async () => {
    const calls = heard()
    const a = hub.attach(worker('p1'))
    await a.call('app-notes', 'poke', { to: 1 }, { callId: 'toolu_1' })
    expect(await calls[0]!.callId).toBe('toolu_1')
  })

  it('joins to the call start the adapter saw first — ignoring key order and whether args are a string or an object', async () => {
    const calls = heard()
    const a = hub.attach(worker('p1'))
    a.noteCall('item-1', 'app-notes', 'poke', '{"to":2,"x":{"b":1,"a":2}}')
    a.noteCall('item-2', 'app-notes', 'poke', { to: 3 })
    await a.call('app-notes', 'poke', { to: 3 })
    await a.call('app-notes', 'poke', { x: { a: 2, b: 1 }, to: 2 })
    expect(await Promise.all(calls.map((c) => c.callId))).toEqual(['item-2', 'item-1'])
  })

  it('joins to a call start that arrives afterward, even if the call arrives first', async () => {
    const calls = heard()
    const a = hub.attach(worker('p1'))
    const p = a.call('app-notes', 'poke', { to: 4 })
    await kit.until(() => calls.length, (n) => n === 1)
    a.noteCall('item-4', 'app-notes', 'poke', { to: 4 })
    await p
    expect(await calls[0]!.callId).toBe('item-4')
  })

  it('a finished card (a call refused at approval) is excluded from joining — a retry with the same args does not attach to the old card', async () => {
    const calls = heard()
    const a = hub.attach(worker('p1'))
    a.noteCall('denied', 'app-notes', 'poke', { to: 5 })
    a.callEnded('denied')
    a.noteCall('retry', 'app-notes', 'poke', { to: 5 })
    await a.call('app-notes', 'poke', { to: 5 })
    expect(await calls[0]!.callId).toBe('retry')
  })

  it('is null if a match never arrives — the call still finishes normally', async () => {
    hub.dispose()
    hub = new SessionAppsHub(w.rt, { toolListWaitMs: 10_000, callJoinWaitMs: 100 })
    const calls = heard()
    const a = hub.attach(worker('p1'))
    // A start with a different tool or different args is not a match for this call
    a.noteCall('item-x', 'app-notes', 'peek', {})
    a.noteCall('item-y', 'app-notes', 'poke', { to: 99 })
    const out = await a.call('app-notes', 'poke', { to: 6 })
    expect(out.isError).toBe(false)
    expect(await calls[0]!.callId).toBeNull()
  })
})
