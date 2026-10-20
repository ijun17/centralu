/**
 * Store regression tests: external apps, the grid and pinned views.
 *
 * Ports go through `MockPlatform` (no ad-hoc mocking, or the contract falls apart). The
 * `pendingEvents` holding pen is module state, so it cannot be cleared between tests — each test
 * uses a different session id instead. Shared fixtures are in store.test-helpers.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { sessionGridPanel } from '@cc/core'
// eslint-disable-next-line no-restricted-imports -- the runtime ui knows only ports, but tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import { externalAppKey, gridAppViewKey, gridScreenAppKeys, registerPinnedFrame, useStore } from './store.js'
import { appInfo, resetStore, sessionInfo } from './store.test-helpers.js'

beforeEach(resetStore)

/**
 * Handing off and starting fresh (a dogfooding request — the way out of the 7-13 second resume delay
 * on an old thread). The dying session's written text becomes the new session's first message, its
 * name and settings carry over, and the old session is deleted all the way to its own original —
 * since #204 it goes to the session archive, and its tool file goes when it is deleted for good.
 * Destruction comes last — a failure deletes nothing.
 */
/**
 * An external app's "changed" (M4 B-5): the store only counts, per (project, app). Re-reading is the
 * open view's own job, through its state tool — the store never asks the host for it.
 */
describe('an external app\'s change signal (M4 B-5)', () => {
  it('a broadcast only bumps that (project, app)\'s counter', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)

    mock.emit({ type: 'external_app_state_changed', appId: 'notes', projectId: 'p1' } as NormalizedEvent)
    mock.emit({ type: 'external_app_state_changed', appId: 'notes', projectId: 'p1' } as NormalizedEvent)
    mock.emit({ type: 'external_app_state_changed', appId: 'notes', projectId: null } as NormalizedEvent)
    await vi.waitFor(() => expect(useStore.getState().externalAppChanges[externalAppKey(null, 'notes')]).toBe(1))

    expect(useStore.getState().externalAppChanges).toEqual({ 'p1/notes': 2, '_user/notes': 1 })
    // The `notes` app of two different projects are two different apps — their keys never collide
    expect(externalAppKey('p2', 'notes')).not.toBe(externalAppKey('p1', 'notes'))
  })

  it('a run signal (M4 D-6) only bumps the runs panel\'s counter — the counter the view listens to stays untouched', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.emit({ type: 'external_app_runs_changed', appId: 'notes', projectId: 'p1' } as NormalizedEvent)
    mock.emit({ type: 'external_app_runs_changed', appId: 'notes', projectId: null } as NormalizedEvent)
    await vi.waitFor(() => expect(useStore.getState().externalAppRunChanges).toEqual({ 'p1/notes': 1, '_user/notes': 1 }))
    // A read-only tool's chain also arrives through this signal — waking the view would bring back #190's loop
    expect(useStore.getState().externalAppChanges).toEqual({})
  })

  it('keeps the view instance that caused the change beside the counter — only when it came from a view; null when there is no session, app or owner', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const key = externalAppKey('p1', 'notes')
    const say = (cause?: Record<string, unknown>) =>
      mock.emit({ type: 'external_app_state_changed', appId: 'notes', projectId: 'p1', ...(cause ? { cause } : {}) } as NormalizedEvent)
    const seen = () => [useStore.getState().externalAppChanges[key], useStore.getState().externalAppChangedBy[key]]

    say({ kind: 'view', instanceId: 'frame-a' })
    await vi.waitFor(() => expect(seen()).toEqual([1, 'frame-a']))
    say({ kind: 'session', sessionId: 's1' })
    await vi.waitFor(() => expect(seen()).toEqual([2, null]))
    say({ kind: 'view', instanceId: 'frame-b' })
    await vi.waitFor(() => expect(seen()).toEqual([3, 'frame-b']))
    // A change with no owner (the app came up again, the host merged mixed sources) — everyone hears it
    say()
    await vi.waitFor(() => expect(seen()).toEqual([4, null]))
  })
})

/**
 * The external app list (M4 A-8): the store holds a copy of the host's `apps.list`. The broadcast
 * (`external_apps_changed`) never carries what changed, so the whole list is re-read. While an app is
 * coming up, broadcasts arrive back to back (coming up → up), so reads overlap. If an overlapping read
 * overwrites the new list with an old one, the sidebar shows a running app as "coming up" forever.
 */
describe('the external app list (M4 A-8)', () => {
  it('reads on the first attach, and re-reads every time a broadcast arrives', async () => {
    const mock = new MockPlatform()
    mock.externalAppList = [appInfo('notes')]
    await useStore.getState().attach(mock)
    expect(useStore.getState().externalApps.map((a) => a.appId)).toEqual(['notes'])

    mock.setExternalApps([appInfo('notes', { status: 'running' }), appInfo('timer', { projectId: null })])
    await vi.waitFor(() => expect(useStore.getState().externalApps).toHaveLength(2))
    expect(useStore.getState().externalApps[0]?.status).toBe('running')
  })

  it('another broadcast arriving mid-read triggers one more read after it finishes — the last list wins', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    const list = vi.spyOn(mock.apps, 'list')
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    // The first read holds the list as of that moment (coming up) and returns late
    list.mockImplementationOnce(async () => {
      const snap = structuredClone(mock.externalAppList)
      await gate
      return snap
    })

    mock.setExternalApps([appInfo('notes', { status: 'starting' })])
    mock.setExternalApps([appInfo('notes', { status: 'running' })])
    release()

    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(useStore.getState().externalApps[0]?.status).toBe('running'))
  })

  it('reattaching re-reads the list (a broadcast from the gap while disconnected never comes again)', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.externalAppList = [appInfo('notes', { status: 'failed', error: 'boom' })]
    mock.setConnectionState('disconnected')
    mock.setConnectionState('connected')
    await vi.waitFor(() => expect(useStore.getState().externalApps[0]?.status).toBe('failed'))
  })
})

/**
 * Apps on the grid (#288). The grid's list holds tagged references, and an app's panel shows a view of its own,
 * apart from the app's pinned view that the app view and the project screen share (owner decision: the same app can
 * stand in more than one place, each its own view, one process).
 */
describe('apps on the grid (#288)', () => {
  const live = async () => {
    const mock = new MockPlatform()
    const p = await mock.projects.add('/tmp/grid-apps')
    mock.sessions.set('ga-s1', sessionInfo('ga-s1', { projectId: p.id }))
    mock.externalAppList = [appInfo('slider', { projectId: p.id }), appInfo('notes', { projectId: null })]
    await useStore.getState().attach(mock)
    useStore.setState({ pinnedViews: [], focusedApp: null })
    return { mock, pid: p.id }
  }
  const app = (projectId: string | null, appId: string) => ({ kind: 'app' as const, projectId, appId })
  const keys = () => useStore.getState().pinnedViews.map((p) => p.key)

  it('a list of bare session ids from a host older than this build is read as session panels', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('ga-old', sessionInfo('ga-old'))
    // What `grid.get` answered before apps could stand on the grid
    Object.assign(mock.agents, { grid: async () => ['ga-old'] })
    await useStore.getState().attach(mock)
    expect(useStore.getState().gridPanels).toEqual([sessionGridPanel('ga-old')])
  })

  it('sessions, a project’s app and a user-folder app are saved in one order and come back from the host', async () => {
    const { mock, pid } = await live()
    const list = [app(null, 'notes'), sessionGridPanel('ga-s1'), app(pid, 'slider')]
    await useStore.getState().setGridPanels(list)
    expect(useStore.getState().gridPanels).toEqual(list)
    expect(await mock.agents.grid()).toEqual(list)
  })

  it('an app on the grid gets a view of its own, apart from its pinned view, and each opens its own instance', async () => {
    const { mock, pid } = await live()
    useStore.getState().ensureGridAppView(pid, 'slider')
    useStore.getState().ensureGridAppView(pid, 'slider')
    useStore.getState().ensurePinnedView(pid, 'slider')
    expect(keys()).toEqual([gridAppViewKey(pid, 'slider'), externalAppKey(pid, 'slider')])
    for (const k of keys()) await useStore.getState().startPinnedView(k)
    expect(mock.openedViews).toEqual([
      { appId: 'slider', projectId: pid },
      { appId: 'slider', projectId: pid },
    ])
    expect(new Set(useStore.getState().pinnedViews.map((p) => p.instanceId)).size).toBe(2)
  })

  it('taking an app panel off the grid tears its view down first, then releases it, and leaves the app’s pinned view alone', async () => {
    const { mock, pid } = await live()
    await useStore.getState().setGridPanels([app(pid, 'slider'), sessionGridPanel('ga-s1')])
    useStore.getState().ensureGridAppView(pid, 'slider')
    useStore.getState().ensurePinnedView(pid, 'slider')
    for (const k of keys()) await useStore.getState().startPinnedView(k)
    const gridView = useStore.getState().pinnedViews.find((p) => p.key === gridAppViewKey(pid, 'slider'))!
    const order: string[] = []
    const off = registerPinnedFrame(gridView.key, {
      teardown: async () => {
        order.push(`teardown, ${mock.closedViews.length} closed`)
        return 'answered'
      },
    })

    await useStore.getState().setGridPanels([sessionGridPanel('ga-s1')])
    await vi.waitFor(() => expect(keys()).toEqual([externalAppKey(pid, 'slider')]))
    off()
    expect(order).toEqual(['teardown, 0 closed'])
    expect(mock.closedViews).toEqual([gridView.instanceId])
    expect(useStore.getState().gridPanels).toEqual([sessionGridPanel('ga-s1')])
  })

  it('the grid lays views over its app panels only while it is on show, and only for apps the list has', async () => {
    const { pid } = await live()
    useStore.setState({
      gridPanels: [app(pid, 'slider'), sessionGridPanel('ga-s1'), app(pid, 'removed'), app(null, 'notes')],
      view: 'focus',
    })
    expect(gridScreenAppKeys(useStore.getState())).toEqual([])
    useStore.setState({ view: 'grid' })
    expect(gridScreenAppKeys(useStore.getState())).toEqual([gridAppViewKey(pid, 'slider'), gridAppViewKey(null, 'notes')])
  })
})

/**
 * A pinned view (M4 B-2): an opened view survives a focus change. Its instance is created once by the
 * host calling `home`, and released when closed. If it was closed while opening, the just-opened
 * instance is released too — otherwise a view nobody watches would hold onto the app forever.
 */
describe('a pinned view (M4 B-2)', () => {
  const live = async () => {
    const mock = new MockPlatform()
    mock.sessions.set('pin-s1', sessionInfo('pin-s1'))
    mock.externalAppList = [appInfo('slider')]
    await useStore.getState().attach(mock)
    useStore.setState({ pinnedViews: [], focusedApp: null })
    return mock
  }
  const pinned = () => useStore.getState().pinnedViews

  it('opening stands up a slot, going to look at a session leaves it in place, and opening it again creates nothing new', async () => {
    const mock = await live()
    useStore.getState().openApp('p1', 'slider')
    expect(useStore.getState()).toMatchObject({ view: 'app', focusedApp: { projectId: 'p1', appId: 'slider' }, focusedProjectId: 'p1' })
    await useStore.getState().startPinnedView('p1/slider')
    const opened = pinned()[0]
    expect(opened).toMatchObject({ key: 'p1/slider', phase: 'open', instanceId: expect.stringMatching(/^mock-view-/) })

    useStore.getState().focusSession('pin-s1')
    expect(useStore.getState().view).toBe('focus')
    expect(pinned()).toEqual([opened])

    useStore.getState().openApp('p1', 'slider')
    await useStore.getState().startPinnedView('p1/slider')
    expect(pinned()).toEqual([opened])
    expect(mock.openedViews).toEqual([{ appId: 'slider', projectId: 'p1' }])
  })

  it('closing releases the instance, removes the slot, and returns to the session that was being viewed', async () => {
    const mock = await live()
    useStore.getState().focusSession('pin-s1')
    useStore.getState().openApp('p1', 'slider')
    await useStore.getState().startPinnedView('p1/slider')
    const id = pinned()[0]!.instanceId

    useStore.getState().closeApp('p1/slider')
    expect(mock.closedViews).toEqual([id])
    expect(pinned()).toEqual([])
    expect(useStore.getState()).toMatchObject({ view: 'focus', focusedApp: null, focusedSessionId: 'pin-s1' })
  })

  it('a linked machine’s user-folder app opens on that machine, apart from this computer’s app of the same id (#82)', async () => {
    const mock = await live()
    useStore.getState().openApp(null, 'slider', { machine: 'm1' })
    expect(useStore.getState().focusedApp).toEqual({ projectId: null, appId: 'slider', machine: 'm1' })
    await useStore.getState().startPinnedView('m1:_user/slider')
    useStore.getState().openApp(null, 'slider')
    await useStore.getState().startPinnedView('_user/slider')
    expect(mock.openedViews).toEqual([
      { appId: 'slider', projectId: null, machine: 'm1' },
      { appId: 'slider', projectId: null },
    ])
    // Two views, one per machine: closing theirs leaves this computer's open
    expect(pinned().map((p) => p.key)).toEqual(['m1:_user/slider', '_user/slider'])
    useStore.getState().closeApp('m1:_user/slider')
    expect(pinned().map((p) => p.key)).toEqual(['_user/slider'])
  })

  it('removing a linked machine’s user-folder app names that machine; removing this computer’s names none (#82)', async () => {
    const mock = await live()
    const removed: unknown[][] = []
    vi.spyOn(mock.apps, 'remove').mockImplementation(async (...args: unknown[]) => void removed.push(args))
    expect(await useStore.getState().removeUserApp('slider', 'm1')).toBe(true)
    expect(await useStore.getState().removeUserApp('slider')).toBe(true)
    expect(removed).toEqual([
      ['slider', null, 'm1'],
      ['slider', null, undefined],
    ])
  })

  it('Restart of a linked machine’s user-folder app restarts it on that machine, not this computer’s app of the same id (#82)', async () => {
    const mock = await live()
    const restarts: unknown[][] = []
    vi.spyOn(mock.apps, 'restart').mockImplementation(async (...args: unknown[]) => void restarts.push(args))
    useStore.getState().openApp(null, 'slider', { machine: 'm1' })
    await useStore.getState().startPinnedView('m1:_user/slider')
    await useStore.getState().restartApp('m1:_user/slider')
    useStore.getState().openApp(null, 'slider')
    await useStore.getState().startPinnedView('_user/slider')
    await useStore.getState().restartApp('_user/slider')
    expect(restarts).toEqual([
      ['slider', null, 'm1'],
      ['slider', null, undefined],
    ])
  })

  it.each(['pinned', 'project panel', 'grid', 'linked user app', 'restored window'])(
    '%s waits for a replacement host after its instance-open answer is dropped', async (path) => {
      const mock = await live()
      if (path === 'restored window') {
        mock.workspaceSnapshot = { view: 'app', focusedApp: { projectId: 'p1', appId: 'slider' } }
        await useStore.getState().attach(mock)
      } else if (path === 'grid') useStore.getState().ensureGridAppView('p1', 'slider')
      else if (path === 'project panel') useStore.getState().ensurePinnedView('p1', 'slider')
      else if (path === 'linked user app') useStore.getState().openApp(null, 'slider', { machine: 'm1' })
      else useStore.getState().openApp('p1', 'slider')
      const key = pinned()[0]!.key
      const keys: (string | undefined)[] = []
      const recoveries: (boolean | undefined)[] = []
      const answer = { instanceId: 'kept-view', tool: 'home', resourceUri: 'ui://slider/main', toolInput: {}, toolResult: { content: [] }, runId: 'once' }
      mock.openViewProvider = async (_a, _p, openKey, recover) => {
        keys.push(openKey)
        recoveries.push(recover)
        if (keys.length === 1) {
          mock.setConnectionState('disconnected')
          throw Object.assign(new Error('Host restarted before an answer came'), { code: 'connection_lost' })
        }
        return answer
      }
      const opening = useStore.getState().startPinnedView(key)
      await Promise.resolve()
      expect(pinned()[0]).toMatchObject({ phase: 'opening', error: null })
      expect(keys).toHaveLength(1)
      mock.setConnectionState('resync_required')
      await opening
      expect(pinned()[0]).toMatchObject({ phase: 'open', instanceId: 'kept-view', error: null })
      expect(keys).toHaveLength(2)
      expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/)
      expect(keys[1]).toBe(keys[0])
      expect(recoveries).toEqual([false, true])
    },
  )

  it('closing it while it is opening also releases the just-opened instance', async () => {
    const mock = await live()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    mock.openViewProvider = async () => {
      await gate
      return { instanceId: 'late-view', tool: 'home', resourceUri: 'ui://slider/main', toolInput: {}, toolResult: { content: [] }, runId: 'r' }
    }
    useStore.getState().openApp('p1', 'slider')
    const opening = useStore.getState().startPinnedView('p1/slider')
    expect(pinned()[0]?.phase).toBe('opening')
    useStore.getState().closeApp('p1/slider')
    release()
    await opening
    expect(mock.closedViews).toEqual(['late-view'])
    expect(pinned()).toEqual([])
  })

  it('Restart releases the old instance, and reopens only **after** the host finishes restarting (B-6)', async () => {
    const mock = await live()
    useStore.getState().openApp('p1', 'slider')
    await useStore.getState().startPinnedView('p1/slider')
    const old = pinned()[0]!.instanceId
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    vi.spyOn(mock.apps, 'restart').mockImplementation(async () => {
      order.push('restart:begin')
      await gate
      order.push('restart:end')
    })
    const realOpen = mock.apps.openView
    vi.spyOn(mock.apps, 'openView').mockImplementation(async (appId, projectId) => {
      order.push('open')
      return realOpen(appId, projectId)
    })

    const restarting = useStore.getState().restartApp('p1/slider')
    expect(mock.closedViews).toEqual([old])
    // Even if the screen's effect tries to open it now (it is an app that can be opened), it does not open — restart tears down the app just brought up
    await useStore.getState().startPinnedView('p1/slider')
    release()
    await restarting
    expect(pinned()[0]?.phase).toBe('idle')
    await useStore.getState().startPinnedView('p1/slider')
    expect(order).toEqual(['restart:begin', 'restart:end', 'open'])
    expect(pinned()[0]).toMatchObject({ phase: 'open', instanceId: expect.not.stringMatching(old!) })
  })

  it('a pinned view that was being viewed is restored — an app not in the list leaves the focus view instead', async () => {
    const mock = new MockPlatform()
    mock.externalAppList = [appInfo('slider')]
    mock.workspaceSnapshot = { view: 'app', focusedApp: { projectId: 'p1', appId: 'slider' } }
    useStore.setState({ pinnedViews: [], focusedApp: null })
    await useStore.getState().attach(mock)
    expect(useStore.getState()).toMatchObject({ view: 'app', focusedApp: { projectId: 'p1', appId: 'slider' } })
    expect(pinned().map((p) => p.key)).toEqual(['p1/slider'])

    const gone = new MockPlatform()
    gone.workspaceSnapshot = { view: 'app', focusedApp: { projectId: 'p1', appId: 'slider' } }
    useStore.setState({ pinnedViews: [], focusedApp: null, view: 'focus' })
    await useStore.getState().attach(gone)
    expect(useStore.getState().view).toBe('focus')
    expect(pinned()).toEqual([])
  })
})

/**
 * Reopening to follow new code (M4 C-4). The decision comes down to one thing: the list's fingerprint
 * (`codeStamp`) — if it differs from the code that was up when the view opened, it is stale HTML. If
 * it was unknown at open time (the app came up for the first time at that instant), only the first
 * value learned is recorded: reading that as a change would reopen a view that had just opened.
 */
describe('reopening to follow new code (M4 C-4)', () => {
  const pinned = () => useStore.getState().pinnedViews

  it('records the fingerprint if it is unknown at open time, and once it later changes, tears down and reopens the same slot', async () => {
    const mock = new MockPlatform()
    mock.externalAppList = [appInfo('slider', { status: 'running' })]
    await useStore.getState().attach(mock)
    useStore.setState({ pinnedViews: [], focusedApp: null })
    useStore.getState().openApp('p1', 'slider')
    await useStore.getState().startPinnedView('p1/slider')
    const first = pinned()[0]!
    expect(first).toMatchObject({ phase: 'open', codeStamp: null })
    const teardown = vi.fn(async () => 'answered')
    registerPinnedFrame('p1/slider', { teardown })

    mock.setExternalApps([appInfo('slider', { status: 'running', codeStamp: 'aaaa' })])
    await vi.waitFor(() => expect(pinned()[0]?.codeStamp).toBe('aaaa'))
    expect(teardown).not.toHaveBeenCalled()
    expect(mock.closedViews).toEqual([])

    mock.setExternalApps([appInfo('slider', { status: 'running', codeStamp: 'bbbb' })])
    await vi.waitFor(() => expect(pinned()[0]?.phase).toBe('idle'))
    expect(teardown).toHaveBeenCalledTimes(1)
    expect(mock.closedViews).toEqual([first.instanceId])
    expect(pinned()).toEqual([expect.objectContaining({ key: 'p1/slider', instanceId: null, codeStamp: null, updatedAt: expect.any(Number) })])
    expect(useStore.getState().focusedApp).toEqual({ projectId: 'p1', appId: 'slider' })
    // Reopening the view receives the new fingerprint — after that it is quiet, since the fingerprint matches
    await useStore.getState().startPinnedView('p1/slider')
    expect(pinned()[0]).toMatchObject({ phase: 'open', codeStamp: 'bbbb', updatedAt: expect.any(Number) })
    // A view the person restarted themselves never shows "Updated" — that belongs only to a view that reopened with new code
    await useStore.getState().restartApp('p1/slider')
    expect(pinned()[0]).toMatchObject({ updatedAt: null, codeStamp: null })
  })
})

describe('pinned views claimed back after a reconnect (#392)', () => {
  it('claims the views it shows, keeps the ones the host still has, and opens again the ones it closed', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    useStore.getState().ensurePinnedView('p1', 'kept')
    useStore.getState().ensurePinnedView('p1', 'lost')
    useStore.getState().ensurePinnedView('p1', 'never')
    await useStore.getState().startPinnedView(externalAppKey('p1', 'kept'))
    await useStore.getState().startPinnedView(externalAppKey('p1', 'lost'))
    const of = (appId: string) => useStore.getState().pinnedViews.find((p) => p.key === externalAppKey('p1', appId))!
    const kept = of('kept').instanceId!
    const lost = of('lost').instanceId!
    // The window was away longer than the host waited: it closed the view it no longer saw claimed
    mock.pinnedInstances.delete(lost)

    mock.setConnectionState('disconnected')
    mock.setConnectionState('connected')

    await vi.waitFor(() => expect(of('lost').phase).toBe('idle'))
    // Only open views are claimed; one that never opened has nothing to claim
    expect(mock.heldViews).toEqual([[kept, lost]])
    expect(of('lost').instanceId).toBeNull()
    expect(of('kept')).toMatchObject({ phase: 'open', instanceId: kept })
    expect(of('never').phase).toBe('idle')
  })
})

describe('a parked in-conversation view lets go of its call (#392)', () => {
  it('a placeholder keeps neither the input nor the result, and reopening brings both back from the host', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('iv392', sessionInfo('iv392'))
    await useStore.getState().attach(mock)
    const big = 'x'.repeat(200_000)
    const base = { type: 'app_view', sessionId: 'iv392', callId: 'c1', appId: 'viewer', projectId: 'p1', tool: 'show' } as const
    mock.emit({ ...base, phase: 'open', instanceId: 'inst-iv392', toolInput: { text: big } } as NormalizedEvent)
    mock.emit({ ...base, phase: 'result', toolResult: { content: [{ type: 'text', text: big }] }, kept: true } as NormalizedEvent)
    const view = () => useStore.getState().inlineViews['iv392']!['c1']!
    expect(view().toolResult).toBeDefined()

    await useStore.getState().closeInlineView('iv392', 'c1', 'Scrolled away')
    expect(view()).toMatchObject({ state: 'parked', instanceId: null, kept: true })
    expect(view().toolInput).toBeUndefined()
    expect(view().toolResult).toBeUndefined()

    await useStore.getState().reopenInlineView('iv392', 'c1')
    expect(view().state).toBe('live')
    expect(view().toolInput).toEqual({ text: big })
    expect(view().toolResult).toEqual({ content: [{ type: 'text', text: big }] })
  })
})

describe('a conversation view opening across a host swap', () => {
  it('retries the session/call reopen after a dropped answer without repeating its app tool', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('iv-swap', sessionInfo('iv-swap'))
    await useStore.getState().attach(mock)
    const base = { type: 'app_view', sessionId: 'iv-swap', callId: 'c1', appId: 'viewer', projectId: 'p1', tool: 'show' } as const
    mock.emit({ ...base, phase: 'open', instanceId: 'first-inline', toolInput: { once: true } } as NormalizedEvent)
    mock.emit({ ...base, phase: 'result', toolResult: { content: [] }, kept: true } as NormalizedEvent)
    await useStore.getState().closeInlineView('iv-swap', 'c1', 'Scrolled away')
    const reopen = mock.apps.reopenInlineView
    let opened: Awaited<ReturnType<typeof reopen>>
    const retry = vi.spyOn(mock.apps, 'reopenInlineView').mockImplementation(async (...args) => {
      if (retry.mock.calls.length === 1) {
        opened = await reopen(...args)
        mock.setConnectionState('disconnected')
        throw Object.assign(new Error('Connection lost'), { code: 'connection_lost' })
      }
      return reopen(...args)
    })
    const opening = useStore.getState().reopenInlineView('iv-swap', 'c1')
    await vi.waitFor(() => expect(useStore.getState().connection).toBe('disconnected'))
    mock.setConnectionState('resync_required')
    await opening
    expect(useStore.getState().inlineViews['iv-swap']!['c1']).toMatchObject({ state: 'live', instanceId: opened!.instanceId })
    expect(retry).toHaveBeenCalledTimes(2)
    expect(mock.appToolCalls).toEqual([])
  })
})

describe('an orphaned in-conversation view is remembered only while its close is on its way (#392)', () => {
  it('is closed once while the close is pending, and again if the host still holds it afterwards', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('orph392', sessionInfo('orph392'))
    await useStore.getState().attach(mock)
    // The host holds a view this window is not drawing (the window reloaded)
    vi.spyOn(mock.apps, 'inlineViews').mockResolvedValue([
      { callId: 'c1', appId: 'viewer', projectId: 'p1', tool: 'show', kept: true, instanceId: 'orphan-392' },
    ])
    let fail: (e: Error) => void = () => {}
    const close = vi.spyOn(mock.apps, 'closeView').mockImplementationOnce(() => new Promise<void>((_, reject) => (fail = reject)))

    // Two reads while the first close is still on its way: one close
    await useStore.getState().loadHistory('orph392')
    await useStore.getState().loadHistory('orph392')
    expect(close).toHaveBeenCalledTimes(1)

    // That close never reached the host, which still holds the view: the next read closes it again
    fail(new Error('disconnected'))
    await vi.waitFor(async () => {
      await useStore.getState().loadHistory('orph392')
      expect(close).toHaveBeenCalledTimes(2)
    })
  })
})
