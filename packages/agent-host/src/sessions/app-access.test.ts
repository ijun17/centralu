import { sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as kit from '../apps/external/test-helpers.js'
import { AppAccess, readShared, writeShared, type AppAccessStore } from './app-access.js'
import { SessionAppsHub, type AppSessionKey } from './session-apps.js'
import { attachWorld, type AttachWorld } from './session-apps.test-helpers.js'

/**
 * Another project's app tools, on demand (#371 part A) — against a real runtime and real app
 * processes. Two trusted projects (p1, p2) and the user folder:
 *
 *   p1     notes                       a session here is the caller
 *   p2     board (shared), secret       the other project
 *   user   helper                      the person's own folder: available without a share switch
 *
 * The consent card is part B's (`ensureProjectAccess`); here a fake answers it, and the test pins
 * what this module does with each answer.
 */

let w: AttachWorld
let hub: SessionAppsHub
let access: AppAccess
let consents: Set<string>
let asks: { sessionId: string; to: string; text: string }[]
let answer: 'always' | 'once' | 'deny'
let when: 'now' | 'next_turn'
const projects = [
  { id: 'p1', name: 'Alpha', trusted: true },
  { id: 'p2', name: 'Beta', trusted: true },
]
const sessions = new Map<string, AppSessionKey>()

const session = (id: string, projectId: string | null): AppSessionKey => {
  const key: AppSessionKey = { id, kind: 'worker', projectId }
  sessions.set(id, key)
  return key
}

function newAccess(boundaryOpen?: () => boolean): AppAccess {
  const store: AppAccessStore = {
    settings: {
      appSetting: (k) => w.store.settings.appSetting(k),
      setAppSetting: (k, v) => w.store.settings.setAppSetting(k, v),
      deleteAppSetting: (k) => w.store.settings.deleteAppSetting(k),
    },
    permissions: { getProjectConsent: (from, to) => (consents.has(`${from}>${to}`) ? { from, to } : null) },
  }
  return new AppAccess({
    hub,
    store,
    ...(boundaryOpen ? { boundaryOpen } : {}),
    session: (id) => sessions.get(id) ?? null,
    projects: () => projects,
    ensureAccess: async (sessionId, to, what) => {
      const from = sessions.get(sessionId)!.projectId!
      if (consents.has(`${from}>${to}`)) return { ok: true }
      asks.push({ sessionId, to, text: what.text })
      if (answer === 'deny') return { ok: false, error: 'The person declined.' }
      if (answer === 'always') consents.add(`${from}>${to}`)
      return { ok: true }
    },
    attachedChanged: (id) => {
      hub.sessionAppsChanged(id)
      return when
    },
    toolListWaitMs: 10_000,
  })
}

beforeEach(() => {
  const holder: { w?: AttachWorld } = {}
  w = holder.w = attachWorld(kit, {}, { shared: (ref) => readShared(holder.w!.store.settings, ref) })
  w.trust.p2 = true
  w.plant('p1', 'notes')
  w.plant('p2', 'board')
  w.plant('p2', 'secret')
  w.plant('user', 'helper')
  w.rt.refresh()
  writeShared(w.store.settings, { projectId: 'p2', appId: 'board' }, true)
  consents = new Set()
  asks = []
  answer = 'always'
  when = 'now'
  sessions.clear()
  hub = new SessionAppsHub(w.rt, {
    toolListWaitMs: 10_000,
    callJoinWaitMs: 300,
    onDemand: { attached: (id) => access.attached(id), allowed: (s, a) => access.allowed(s, a) },
  })
  access = newAccess()
})

afterEach(async () => {
  access.dispose()
  hub.dispose()
  await w.dispose()
})

const refs = (sessionId: string) => {
  const r = access.find(sessionId)
  if (!r.ok) throw new Error(r.error)
  return r.apps.map((a) => a.ref)
}

describe('finding apps (find_apps)', () => {
  it("lists another project's app only while it is shared, the person's own apps always, and never this project's own", () => {
    session('w1', 'p1')
    expect(refs('w1')).toEqual(['Beta/board', 'helper'])
    writeShared(w.store.settings, { projectId: 'p2', appId: 'board' }, false)
    expect(refs('w1')).toEqual(['helper'])
    writeShared(w.store.settings, { projectId: 'p2', appId: 'secret' }, true)
    expect(refs('w1')).toEqual(['Beta/secret', 'helper'])
  })

  it("does not list a shared app of a project the person has not trusted — it does not run there either", () => {
    session('w1', 'p1')
    w.trust.p2 = false
    w.rt.refresh()
    expect(refs('w1')).toEqual(['helper'])
  })

  it('narrows by every word of the query, and says why when a session cannot attach at all', () => {
    session('w1', 'p1')
    session('o', null)
    expect(access.find('w1', 'beta board').ok && (access.find('w1', 'beta board') as { apps: { ref: string }[] }).apps.map((a) => a.ref)).toEqual(['Beta/board'])
    expect(access.find('o')).toEqual({ ok: false, error: 'Only a session in a project can attach apps from other projects.' })
    projects[0]!.trusted = false
    try {
      expect(access.find('w1')).toMatchObject({ ok: false, error: expect.stringContaining('not trusted') })
    } finally {
      projects[0]!.trusted = true
    }
  })
})

describe('attaching and detaching', () => {
  it("attaching makes the app's tools appear on the session, under its own server, and detaching takes them away", async () => {
    const key = session('w1', 'p1')
    const a = hub.attach(key)
    let heard = 0
    a.onChange(() => heard++)
    expect(a.current().map((x) => x.server)).toEqual(['app-notes'])

    const r = await access.attach('w1', 'Beta/board')
    expect(r).toMatchObject({ ok: true, server: 'app-board', when: 'now' })
    expect((r as { tools: string[] }).tools.sort()).toEqual(['echo', 'hold', 'peek', 'poke'])
    expect(a.current().map((x) => x.server)).toEqual(['app-notes', 'app-board'])
    expect(heard).toBeGreaterThan(0)
    // The app's agent tools, plus the host's run_status — the same as an app the rule gives
    expect((await a.tools('app-board')).map((t) => t.name).sort()).toEqual(['echo', 'hold', 'peek', 'poke', 'run_status'])
    // Already attached is said, not attached twice
    expect(await access.attach('w1', 'Beta/board')).toMatchObject({ ok: true, already: true, server: 'app-board' })
    expect(refs('w1')).toEqual(['helper'])

    expect(access.detach('w1', 'Beta/board')).toEqual({ ok: true, server: 'app-board', when: 'now' })
    expect(a.current().map((x) => x.server)).toEqual(['app-notes'])
    expect((await a.call('app-board', 'peek', {})).isError).toBe(true)
    // Its own project's app is not one detach_app can take away
    expect(access.detach('w1', 'notes')).toMatchObject({ ok: false, error: expect.stringContaining("this session's own apps") })
  })

  it("records a call with the calling session and the app's own project, and runs the app in its own place", async () => {
    session('w1', 'p1')
    const a = hub.attach(sessions.get('w1')!)
    await access.attach('w1', 'Beta/board')
    const out = await a.call('app-board', 'poke', { to: 3 })
    expect(out.isError).toBe(false)
    const rows = w.rt.runs({ projectId: 'p2', appId: 'board' })
    expect(rows[0]).toMatchObject({ tool: 'poke', callerKind: 'session', callerSessionId: 'w1', status: 'ok' })
    // One process, started in its own folder in the other project. `sep`, because Windows reports `\p2\`
    expect(w.records('board').find((r) => r.t === 'start')).toMatchObject({ cwd: expect.stringContaining(`${sep}p2${sep}`) })
  })

  it("names an app from another project apart from this project's own app of the same id", async () => {
    w.plant('p1', 'board')
    w.rt.refresh()
    const a = hub.attach(session('w1', 'p1'))
    expect(await access.attach('w1', 'Beta/board')).toMatchObject({ ok: true, server: 'app-board-2' })
    expect(a.current().map((x) => x.server)).toEqual(['app-board', 'app-notes', 'app-board-2'])
  })

  it("a user-folder app attaches without a card or a share switch", async () => {
    const a = hub.attach(session('w1', 'p1'))
    expect(await access.attach('w1', 'helper')).toMatchObject({ ok: true, server: 'app-helper' })
    expect(asks).toEqual([])
    expect(a.current().map((x) => x.server)).toEqual(['app-notes', 'app-helper'])
  })

  // A value another build may write there (#384): only `1` shares, so a word this build does not know is a refusal
  it('reads anything but 1 in the share switch as not shared', () => {
    const ref = { projectId: 'p2', appId: 'board' }
    for (const [value, shared] of [['1', true], ['true', false], ['yes', false], ['2', false], ['', false]] as const) {
      w.store.settings.setAppSetting('app_shared:p2/board', value)
      expect(readShared(w.store.settings, ref)).toBe(shared)
    }
  })

  it('refuses an app that is not shared, and says only the person can share it', async () => {
    session('w1', 'p1')
    expect(await access.attach('w1', 'Beta/secret')).toMatchObject({ ok: false, error: expect.stringContaining('not shared') })
    expect(asks).toEqual([])
  })

  it('says when the agent gets the tools — the next turn for an agent that keeps its servers (Codex)', async () => {
    session('w1', 'p1')
    when = 'next_turn'
    expect(await access.attach('w1', 'Beta/board')).toMatchObject({ ok: true, when: 'next_turn' })
    expect(access.detach('w1', 'app-board')).toMatchObject({ ok: true, when: 'next_turn' })
  })
})

describe('consent per pair of projects', () => {
  it('asks once per pair: "always" covers every later attachment from that project, and the reverse pair still asks', async () => {
    writeShared(w.store.settings, { projectId: 'p2', appId: 'secret' }, true)
    writeShared(w.store.settings, { projectId: 'p1', appId: 'notes' }, true)
    session('w1', 'p1')
    session('w2', 'p1')
    session('v1', 'p2')
    await access.attach('w1', 'Beta/board')
    expect(asks).toEqual([{ sessionId: 'w1', to: 'p2', text: expect.stringMatching(/^use its app /) }])
    access.detach('w1', 'Beta/board')
    await access.attach('w1', 'Beta/board')
    await access.attach('w2', 'Beta/secret')
    expect(asks).toHaveLength(1)
    // p1 → p2 says nothing about p2 → p1
    await access.attach('v1', 'Alpha/notes')
    expect(asks.map((a) => `${a.sessionId}>${a.to}`)).toEqual(['w1>p2', 'v1>p1'])
  })

  it('"once" attaches for this session only, and a denial attaches nothing', async () => {
    session('w1', 'p1')
    session('w2', 'p1')
    answer = 'once'
    expect(await access.attach('w1', 'Beta/board')).toMatchObject({ ok: true })
    expect(hub.attach(sessions.get('w1')!).current().map((x) => x.server)).toContain('app-board')
    answer = 'deny'
    expect(await access.attach('w2', 'Beta/board')).toEqual({ ok: false, error: 'The person declined.' })
    expect(hub.attach(sessions.get('w2')!).current().map((x) => x.server)).toEqual(['app-notes'])
    expect(asks).toHaveLength(2)
  })

  it('turning sharing off, or revoking the pair, detaches the app — and a call by its old name is refused', async () => {
    const a = hub.attach(session('w1', 'p1'))
    await access.attach('w1', 'Beta/board')
    expect(a.current().map((x) => x.server)).toContain('app-board')

    consents.clear()
    w.rt.sharingChanged()
    await kit.until(() => a.current().map((x) => x.server), (s) => !s.includes('app-board'))
    expect((await a.call('app-board', 'peek', {})).content).toEqual([{ type: 'text', text: 'This app is not attached to this session: app-board' }])

    consents.add('p1>p2')
    w.rt.sharingChanged()
    await kit.until(() => a.current().map((x) => x.server), (s) => s.includes('app-board'))
    writeShared(w.store.settings, { projectId: 'p2', appId: 'board' }, false)
    w.rt.sharingChanged()
    await kit.until(() => a.current().map((x) => x.server), (s) => !s.includes('app-board'))
  })
})

describe('how long an attachment lasts', () => {
  /*
   * The row is read and written by more than one build (#384). An attachment a newer build stored with a consent this
   * one does not know is not used (a consent that cannot be read grants nothing), and it used to be dropped by the next
   * attach or detach, which rewrote the list with only what this build could read.
   */
  it('an attachment stored with a consent this build does not know grants nothing, and is kept through an attach and a detach', async () => {
    session('w1', 'p1')
    const newer = { projectId: 'p2', appId: 'secret', server: 'app-secret', consent: 'standing' }
    w.store.settings.setAppSetting('session_apps:w1', JSON.stringify([newer]))
    access.dispose()
    access = newAccess()
    expect(access.attached('w1')).toEqual([])

    await access.attach('w1', 'Beta/board')
    expect(access.attached('w1')).toEqual([{ ref: { projectId: 'p2', appId: 'board' }, server: 'app-board' }])
    expect(JSON.parse(w.store.settings.appSetting('session_apps:w1')!)).toContainEqual(newer)
    access.detach('w1', 'Beta/board')
    expect(JSON.parse(w.store.settings.appSetting('session_apps:w1')!)).toEqual([newer])
  })

  it('outlives the host process (kept in the store) and goes when the session is deleted', async () => {
    session('w1', 'p1')
    await access.attach('w1', 'Beta/board')
    access.dispose()
    access = newAccess()
    expect(access.attached('w1')).toEqual([{ ref: { projectId: 'p2', appId: 'board' }, server: 'app-board' }])
    hub.sessionGone('w1')
    expect(access.attached('w1')).toEqual([])
    access.dispose()
    access = newAccess()
    expect(access.attached('w1')).toEqual([])
  })
})

/**
 * A project that is an app (#1141) takes the user-folder app's place: the orchestrator gets it, another project's
 * session finds and attaches it without a share switch or a card, and its own project's sessions get it with the rest of
 * their project's apps.
 */
describe('a project that is an app (#1141)', () => {
  it("another project's root app is found and attached without a share switch or a card, as a user-folder app is, and its tools work", async () => {
    w.plantRoot('p2', 'kanban')
    w.rt.refresh()
    const a = hub.attach(session('w1', 'p1'))
    expect(refs('w1')).toEqual(['Beta/board', 'Beta/kanban', 'helper'])
    expect(await access.attach('w1', 'Beta/kanban')).toMatchObject({ ok: true, server: 'app-kanban' })
    expect(asks).toEqual([])
    expect((await a.call('app-kanban', 'poke', { to: 1 })).isError).toBe(false)
    // By its bare id too, as when it was a user-folder app
    expect(access.detach('w1', 'Beta/kanban')).toMatchObject({ ok: true })
    expect(await access.attach('w1', 'kanban')).toMatchObject({ ok: true, server: 'app-kanban' })
    expect(asks).toEqual([])
  })

  it("an untrusted project's root app reaches no other session, not even one under auto, nor the orchestrator; its own project's session under auto still gets it (an inner shared app keeps #603's rule)", async () => {
    w.trust.p2 = false
    w.plantRoot('p2', 'kanban')
    w.rt.refresh()
    // Every session's boundary is open (auto, #603): it opens an untrusted project's apps to that project's own sessions only
    access.dispose()
    hub.dispose()
    hub = new SessionAppsHub(w.rt, {
      toolListWaitMs: 10_000,
      callJoinWaitMs: 300,
      boundaryOpen: () => true,
      onDemand: { attached: (id) => access.attached(id), allowed: (s, a) => access.allowed(s, a) },
    })
    access = newAccess(() => true)
    session('w1', 'p1')
    expect(refs('w1')).toEqual(['Beta/board', 'helper'])
    expect(await access.attach('w1', 'Beta/kanban')).toMatchObject({ ok: false, error: expect.stringContaining('not trusted') })
    const orchestrator: AppSessionKey = { id: 'o', kind: 'orchestrator', projectId: null }
    expect(hub.refsFor(orchestrator).map((h) => h.server)).toEqual(['app-helper'])
    expect(hub.reach(orchestrator, { projectId: 'p2', appId: 'kanban' })).toMatchObject({ reachable: false, reason: 'untrusted' })
    expect(hub.refsFor(session('w2', 'p2')).map((h) => h.server)).toContain('app-kanban')
  })

  it("the orchestrator gets every root app and no project's inner app; its own project's sessions get it; two of one id are named apart", () => {
    w.plant('user', 'kit')
    w.plantRoot('p1', 'kit')
    w.plantRoot('p2', 'kit')
    w.rt.refresh()
    const orchestrator: AppSessionKey = { id: 'o', kind: 'orchestrator', projectId: null }
    expect(hub.refsFor(orchestrator).map((h) => [h.server, h.ref.projectId])).toEqual([
      ['app-helper', null],
      ['app-kit', null],
      ['app-kit-2', 'p1'],
      ['app-kit-3', 'p2'],
    ])
    // A session of p1 gets its project's apps, its root app among them, under their own names
    expect(hub.refsFor(session('w1', 'p1')).map((h) => h.server)).toEqual(['app-kit', 'app-notes'])
    // The name a session's app answers to is the one it is listed under
    expect(hub.reach(orchestrator, { projectId: 'p2', appId: 'kit' })).toEqual({ reachable: true })
  })
})

