import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackgroundTask, PermissionPreset, RebuildCause, SessionInfo } from '@cc/protocol'
import type { SessionHandle } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { ChildOwnership } from './child-ownership.js'
import { RestartPolicy, type RestartHost } from './restart-policy.js'

/*
 * When a deferred restart is applied (#164, #648), on its own: the session manager's tests (background-tasks,
 * launch-settings, project trust) run the same rule through real turns.
 */

let store: Store
let meta: Map<string, SessionInfo>
let running: RestartHost['running']
let restarts: { id: string; cause?: RebuildCause }[]
let policy: RestartPolicy

const settings = { model: 'm1', effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal' as PermissionPreset }
const shell: BackgroundTask = { id: 't1', kind: 'shell', description: 'dev server', status: 'running' }

beforeEach(() => {
  vi.useFakeTimers()
  store = new Store()
  meta = new Map([['s', { id: 's', state: 'idle', backgroundTasks: [], ...settings } as unknown as SessionInfo]])
  running = new Map([['s', { ...settings }]])
  restarts = []
  const host: RestartHost = {
    store,
    meta,
    running,
    children: new ChildOwnership(store),
    handles: new Map([['s', {} as SessionHandle]]),
    backgroundTasksKey: (id) => `background_tasks:${id}`,
    inputsHeld: () => false,
    lettingGo: false,
    onEvent: () => {},
    rememberBackgroundTasks: () => {},
    scheduleDrain: () => {},
    restartSession: async (id, cause) => {
      restarts.push({ id, ...(cause ? { cause } : {}) })
      return { session: meta.get(id)!, resumed: true }
    },
  }
  policy = new RestartPolicy(host)
})
afterEach(() => {
  policy.clearBackgroundHold('s')
  store.close()
  vi.useRealTimers()
})

/** The hold a restart waits on, private to the policy */
const holds = () => (policy as unknown as { backgroundHolds: Map<string, unknown> }).backgroundHolds

const settle = async () => {
  await vi.advanceTimersByTimeAsync(0)
}

describe('a restart deferred to the end of a turn', () => {
  it('a model change restarts the process once the turn is over, naming the cause', async () => {
    meta.get('s')!.model = 'm2'
    policy.restartAfterTurn.add('s')
    meta.get('s')!.state = 'working'
    policy.applyDeferredRestart('s')
    await settle()
    expect(restarts).toEqual([])
    meta.get('s')!.state = 'idle'
    policy.applyDeferredRestart('s')
    expect(policy.deferredRestarts.has('s')).toBe(true)
    await settle()
    expect(restarts).toEqual([{ id: 's', cause: 'model_change' }])
    expect(policy.deferredRestarts.has('s')).toBe(false)
    expect(policy.restartAfterTurn.has('s')).toBe(false)
  })

  it('nothing drifted, nothing to restart', async () => {
    policy.restartAfterTurn.add('s')
    policy.applyDeferredRestart('s')
    await settle()
    expect(restarts).toEqual([])
    expect(policy.restartAfterTurn.has('s')).toBe(false)
  })

  it('an app change restarts the thread even with the settings unchanged', async () => {
    policy.restartAfterTurn.add('s')
    policy.appsRestartAfterTurn.add('s')
    policy.applyDeferredRestart('s')
    await settle()
    expect(restarts).toEqual([{ id: 's', cause: 'thread_restart' }])
  })
})

describe('background work (#648)', () => {
  it('a model change waits while background work runs, and is applied anyway after an hour', async () => {
    meta.get('s')!.model = 'm2'
    meta.get('s')!.backgroundTasks = [shell]
    policy.restartAfterTurn.add('s')
    policy.applyDeferredRestart('s')
    await settle()
    expect(restarts).toEqual([])
    expect(holds().has('s')).toBe(true)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(restarts).toEqual([{ id: 's', cause: 'model_change' }])
    expect(holds().has('s')).toBe(false)
  })

  it('a change of safety does not wait for it', async () => {
    meta.get('s')!.permissionPreset = 'safe'
    meta.get('s')!.backgroundTasks = [shell]
    policy.restartAfterTurn.add('s')
    policy.applyDeferredRestart('s')
    await settle()
    expect(restarts).toEqual([{ id: 's' }])
  })

  it('an adopted session with unknown work is taken as holding none after two hours', () => {
    policy.backgroundUnknown.set('s', Date.now())
    expect(policy.backgroundKnown('s')).toBe(false)
    vi.advanceTimersByTime(2 * 60 * 60 * 1000)
    expect(policy.backgroundKnown('s')).toBe(true)
    expect(policy.backgroundUnknown.has('s')).toBe(false)
  })

  it('forgetting a session drops its unknown mark, its hold and its stored list', async () => {
    store.settings.setAppSetting('background_tasks:s', '[]')
    meta.get('s')!.model = 'm2'
    meta.get('s')!.backgroundTasks = [shell]
    policy.restartAfterTurn.add('s')
    policy.applyDeferredRestart('s')
    policy.backgroundUnknown.set('s', Date.now())
    policy.forgetBackground('s')
    expect(holds().has('s')).toBe(false)
    expect(policy.backgroundUnknown.has('s')).toBe(false)
    expect(store.settings.appSetting('background_tasks:s')).toBeNull()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000)
    expect(restarts).toEqual([])
  })
})
