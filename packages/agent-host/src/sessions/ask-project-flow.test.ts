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

  it('a session as deep as the agent depth cannot ask a project, auto included; the depth read at each call lets it (#867)', () => {
    meta.set('asked', session('asked', { askedBy: 'caller', permissionPreset: 'auto' }))
    const opened: string[] = []
    let agentDepth: number | undefined
    const flow = new AskProjectFlow(hostWith({
      meta, children, store,
      uiPreferences: () => ({ agentDepth }) as never,
      autoBoundaryOpen: (id, boundary) => (opened.push(`${id}:${boundary ?? ''}`), true),
    }))
    // No depth saved reads as 1; auto is never asked about the depth
    expect(flow.askGateError('asked')).toMatch(/^This session is 1 level below a session the person started, and "How deep agents may start agents" in Settings → Orchestrator is 1, so it cannot ask a project\./)
    agentDepth = 1
    expect(flow.askGateError('asked')).toMatch(/so it cannot ask a project/)
    expect(opened).toEqual([])
    agentDepth = 2
    // Past the depth, the project's trust is the next gate (the store has no such project: not trusted, auto opens it)
    expect(flow.askGateError('asked')).toBeNull()
    expect(opened).toEqual(['asked:delegate from an untrusted project'])
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

  /** An ask waiting on `m1.s1`, its outcome as the call would read it */
  const linkedAsk = () => {
    const outcomes: unknown[] = []
    const ask = { busy: false, settled: false, wake: new Set<() => void>(), settle: (r: unknown) => void outcomes.push(r) } as unknown as Parameters<AskProjectFlow['observeLinkedAsk']>[0]
    ask.settle = (r) => {
      ask.settled = true
      outcomes.push(r)
    }
    return { ask, outcomes }
  }

  it('a session deleted there ends the ask, which would otherwise wait for a turn that never ends (#428)', () => {
    const flow = new AskProjectFlow(hostWith({}))
    const { ask, outcomes } = linkedAsk()
    flow.observeLinkedAsk(ask, { type: 'message_delta' })
    flow.observeLinkedAsk(ask, { type: 'session_deleted' })
    expect(outcomes).toEqual([{ ok: false, error: 'the session was deleted there before its turn ended' }])
  })

  it('an interrupted turn there did not finish, as a local agent run reads it (#698, #428)', () => {
    const flow = new AskProjectFlow(hostWith({}))
    const stopped = linkedAsk()
    flow.observeLinkedAsk(stopped.ask, { type: 'message_delta' })
    flow.observeLinkedAsk(stopped.ask, { type: 'state_change', state: 'waiting_input', reason: 'interrupted' })
    expect(stopped.outcomes).toEqual([{ ok: false, error: 'the turn was stopped before it finished' }])
    const byTool = linkedAsk()
    flow.observeLinkedAsk(byTool.ask, { type: 'tool_call' })
    flow.observeLinkedAsk(byTool.ask, { type: 'state_change', state: 'waiting_input', reason: 'interrupted_by_tool' })
    expect(byTool.outcomes).toEqual([{ ok: false, error: 'its tool interrupted the turn before it finished' }])
  })

  it('a stop before the task\'s turn was seen running ends the turn before it, not this one (#428)', () => {
    const flow = new AskProjectFlow(hostWith({}))
    const { ask, outcomes } = linkedAsk()
    // The person stops the turn that was running when the task went in
    flow.observeLinkedAsk(ask, { type: 'state_change', state: 'waiting_input', reason: 'interrupted' })
    expect(outcomes).toEqual([])
    // The task's own turn then runs and ends
    flow.observeLinkedAsk(ask, { type: 'state_change', state: 'working' })
    flow.observeLinkedAsk(ask, { type: 'turn_complete' })
    expect(outcomes).toEqual([{ ok: true }])
  })
})
