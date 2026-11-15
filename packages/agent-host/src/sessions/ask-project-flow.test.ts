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
      trustGate: (id, _projectId, boundary) => (opened.push(`${id}:${boundary}`), null),
    }))
    // No depth saved reads as 1; auto is never asked about the depth
    expect(flow.askGateError('asked')).toMatch(/^This session is 1 level below a session the person started, and "How deep agents may start agents" in Settings → Agents is 1, so it cannot ask a project\./)
    agentDepth = 1
    expect(flow.askGateError('asked')).toMatch(/so it cannot ask a project/)
    expect(opened).toEqual([])
    agentDepth = 2
    // Past the depth, the project's trust is the next gate
    expect(flow.askGateError('asked')).toBeNull()
    expect(opened).toEqual(['asked:asking another project'])
  })

})
