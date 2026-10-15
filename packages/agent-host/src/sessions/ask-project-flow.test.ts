import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionInfo } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { ChildOwnership } from './child-ownership.js'
import { AskProjectFlow, type AskProjectHost } from './ask-project-flow.js'

/*
 * The delegation flow over a host it reaches only through `AskProjectHost` (#428). The host here is a proxy that fails
 * on any member a test did not give it, so each test also says what of the manager its path reads. The tools' own
 * behaviour is covered over the real manager (ask-project, start-agent, agent-start-requests, handoff-children, ...).
 */

let store: Store
let meta: Map<string, SessionInfo>
let children: ChildOwnership

const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, name: id, kind: 'worker', projectId: 'p1', tool: 'claude', state: 'idle', permissionPreset: 'normal', ...extra }) as SessionInfo

/** A host with only `given`; reading anything else throws, naming it */
function hostWith(given: Partial<AskProjectHost>): AskProjectHost {
  return new Proxy(given as AskProjectHost, {
    get(target, key) {
      if (key in target) return target[key as keyof AskProjectHost]
      throw new Error(`the ask flow read host.${String(key)}, which this test did not give it`)
    },
  })
}

beforeEach(() => {
  store = new Store()
  meta = new Map([['caller', session('caller')], ['heir', session('heir', { name: 'Heir' })], ['child', session('child', { name: 'Child' })]])
  children = new ChildOwnership(store)
})
afterEach(() => store.close())

describe('the gates read before anything is asked', () => {
  it('a session with no project cannot ask another project', async () => {
    meta.set('loose', session('loose', { projectId: null }))
    const flow = new AskProjectFlow(hostWith({ meta }))
    expect(await flow.askProject('loose', { project: 'p2', task: 'x' })).toEqual({ ok: false, error: 'This session belongs to no project, so it cannot ask another one' })
  })

  it('a session that was itself asked cannot ask again, unless auto opens that boundary', () => {
    meta.set('asked', session('asked', { askedBy: 'caller' }))
    const opened: string[] = []
    let open = false
    const flow = new AskProjectFlow(hostWith({
      meta, children, store,
      autoBoundaryOpen: (id, boundary) => (opened.push(`${id}:${boundary ?? ''}`), open),
    }))
    expect(flow.askGateError('asked')).toMatch(/^This session was itself started or asked by another session/)
    open = true
    // Past the depth boundary, the project's trust is the next gate (the store has no such project: not trusted)
    expect(flow.askGateError('asked')).toBeNull()
    expect(opened).toEqual(['asked:delegation depth', 'asked:delegation depth', 'asked:delegate from an untrusted project'])
  })

})

describe('a linked machine (#700)', () => {
  it('a dropped link settles the asks waiting on that machine, and only those', () => {
    const flow = new AskProjectFlow(hostWith({}))
    const settled: string[] = []
    const ask = (id: string) => ({ settled: false, settle: (r: { ok: boolean; error?: string }) => void settled.push(`${id}: ${r.error}`) })
    const asks = flow.linkedAsks as Map<string, unknown>
    asks.set('m1.s1', ask('m1.s1'))
    asks.set('m2.s1', ask('m2.s1'))
    flow.observeLinkLoss({ id: 'm1', name: 'Laptop', status: 'disconnected' })
    flow.observeLinkLoss({ id: 'm2', name: 'Desktop', status: 'connected' })
    expect(settled).toEqual([
      'm1.s1: the link to Laptop dropped before the turn ended. The task was delivered and may still be running there; read the session once the link is back',
    ])
  })
})
