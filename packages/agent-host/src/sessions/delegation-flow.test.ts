import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SessionInfo } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { ChildOwnership, type Delegation } from './child-ownership.js'
import { DelegationFlow, type DelegationHost } from './delegation-flow.js'

/*
 * The delegation flow over a host it reaches only through `DelegationHost` (#428). The host here is a proxy that fails
 * on any member a test did not give it, so each test also says what of the manager its path reads. The tools' own
 * behaviour is covered over the real manager (ask-project, start-agent, agent-start-requests, handoff-children, ...).
 */

let store: Store
let meta: Map<string, SessionInfo>
let children: ChildOwnership

const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo =>
  ({ id, name: id, kind: 'worker', projectId: 'p1', tool: 'claude', state: 'idle', permissionPreset: 'normal', ...extra }) as SessionInfo

/** The answers a handoff leaves, private to the flow */
type HandedOver = {
  handedOverAnswer(callerId: string, id: string): { ok: false; error: string } | undefined
  handedOverReply(callerId: string, id: string): { ok: false; error: string }
}
const handed = (flow: DelegationFlow) => flow as unknown as HandedOver

/** A host with only `given`; reading anything else throws, naming it */
function hostWith(given: Partial<DelegationHost>): DelegationHost {
  return new Proxy(given as DelegationHost, {
    get(target, key) {
      if (key in target) return target[key as keyof DelegationHost]
      throw new Error(`the flow read host.${String(key)}, which this test did not give it`)
    },
  })
}

beforeEach(() => {
  store = new Store()
  meta = new Map([['caller', session('caller')], ['heir', session('heir', { name: 'Heir' })], ['child', session('child', { name: 'Child' })]])
  children = new ChildOwnership(store)
})
afterEach(() => store.close())

describe('the gates read before anything is started', () => {
  it('a session with no project cannot ask another project', async () => {
    meta.set('loose', session('loose', { projectId: null }))
    const flow = new DelegationFlow(hostWith({ meta }))
    expect(await flow.askProject('loose', { project: 'p2', task: 'x' })).toEqual({ ok: false, error: 'This session belongs to no project, so it cannot ask another one' })
  })

  it('a session that was itself asked cannot ask again, unless auto opens that boundary', () => {
    meta.set('asked', session('asked', { askedBy: 'caller' }))
    const opened: string[] = []
    let open = false
    const flow = new DelegationFlow(hostWith({
      meta, children, store,
      autoBoundaryOpen: (id, boundary) => (opened.push(`${id}:${boundary ?? ''}`), open),
    }))
    expect(flow.askGateError('asked')).toMatch(/^This session was itself started or asked by another session/)
    open = true
    // Past the depth boundary, the project's trust is the next gate (the store has no such project: not trusted)
    expect(flow.askGateError('asked')).toBeNull()
    expect(opened).toEqual(['asked:delegation depth', 'asked:delegation depth', 'asked:delegate from an untrusted project'])
  })

  it('agent_session never acts on its own calling session', async () => {
    const flow = new DelegationFlow(hostWith({}))
    expect(await flow.agentSession('caller', { sessionId: 'caller', action: 'stop' })).toEqual({
      ok: false,
      error: 'agent_session cannot wait on, stop, delete or send to its own calling session.',
    })
  })

  it('a handle that looks like a start request but is not one here says so', async () => {
    const flow = new DelegationFlow(hostWith({ meta, children }))
    const r = await flow.agentSession('caller', { sessionId: 'ag-gone', action: 'status' })
    expect(r).toMatchObject({ ok: false })
    expect(r.ok === false && r.error).toMatch(/^No start_agent request ag-gone of this session is open here/)
  })
})

describe('what a handoff gave away', () => {
  it('the original that stayed hears where the work went, and the heir is not refused', async () => {
    children.recordHandedOver('child', 'caller', 'heir')
    const flow = new DelegationFlow(hostWith({ meta, children }))
    const r = await flow.agentSession('caller', { sessionId: 'child', action: 'status' })
    expect(r).toEqual({
      ok: false,
      error:
        'A handoff gave "Child" [child] to the session that took over from this one, "Heir" [heir]. ' +
        'It answers to that session now: this session no longer follows it, and nothing was stopped.',
    })
    expect(handed(flow).handedOverAnswer('heir', 'child')).toBeUndefined()
  })

  it('a wait the move ended always has an answer, even once the record is gone', () => {
    const flow = new DelegationFlow(hostWith({ meta, children }))
    expect(handed(flow).handedOverReply('caller', 'child')).toEqual({
      ok: false,
      error: '[child] was handed to another session, which follows it now: this session no longer does, and nothing was stopped.',
    })
  })
})

describe('the place a start holds', () => {
  it("a project's running children and its reserved starts count against the ceiling together", () => {
    const flow = new DelegationFlow(hostWith({ meta, children, uiPreferences: () => ({ agentCeiling: 2 }) as never }))
    const ceiling = (flow as unknown as { agentCeilingError(c: string, p: string): string | null }).agentCeilingError.bind(flow)
    const reserve = (flow as unknown as { reservePlace(c: string, p: string): { release: () => void } | { error: string } }).reservePlace.bind(flow)
    expect(ceiling('caller', 'p1')).toBeNull()
    children.setDelegation('caller>child', { callerId: 'caller', sessionId: 'child', agent: true, settled: false } as unknown as Delegation)
    const place = reserve('caller', 'p1')
    if (!('release' in place)) throw new Error('no place')
    const full =
      '2 agents started by this project\'s sessions are already working, the most at once. Wait for one (agent_session, action "wait") or stop one, then try again.'
    expect(ceiling('caller', 'p1')).toBe(full)
    expect(reserve('caller', 'p1')).toEqual({ error: full })
    place.release()
    place.release()
    expect(ceiling('caller', 'p1')).toBeNull()
  })

  it('releasing a place twice gives back one place, not two', () => {
    const flow = new DelegationFlow(hostWith({ meta, children, uiPreferences: () => ({ agentCeiling: 3 }) as never }))
    const reserve = (flow as unknown as { reservePlace(c: string, p: string): { release: () => void } | { error: string } }).reservePlace.bind(flow)
    children.setDelegation('caller>child', { callerId: 'caller', sessionId: 'child', agent: true, settled: false } as unknown as Delegation)
    const a = reserve('caller', 'p1')
    expect(reserve('caller', 'p1')).toHaveProperty('release')
    if (!('release' in a)) throw new Error('no place')
    a.release()
    a.release()
    expect(reserve('caller', 'p1')).toHaveProperty('release')
    expect(reserve('caller', 'p1')).toHaveProperty('error')
  })
})
