import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sessionLiveDefaults, type PermissionPreset, type SessionInfo } from '@cc/protocol'
import type { LinkedSessions } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { ChildOwnership } from './child-ownership.js'
import { RemoteAgents, type RemoteAgentsHost } from './remote-agents.js'

/**
 * What a hub puts on the link for a child on a linked machine (#1525). The machine may run a build from before `edits`,
 * whose schema refuses the whole start for a preset it does not know, so neither the child's preset nor the caller's
 * (`fromHub.callerPreset`) may be `edits`: both go as `normal`. `makeChild` is driven with the preset itself, as the
 * params sent over the link are what is under test, whatever an earlier step decided.
 */
let store: Store
beforeEach(() => {
  store = new Store()
  store.projects.addProject({ id: 'p1', path: '/p', name: 'p' })
  store.projects.setProjectTrusted('p1', true)
})
afterEach(() => store.close())

async function sentFor(preset: PermissionPreset): Promise<{ preset?: string; callerPreset?: string }> {
  const caller = { id: 'h1', name: 'Parent', projectId: 'p1', kind: 'worker', tool: 'claude', permissionPreset: preset, ...sessionLiveDefaults() } as unknown as SessionInfo
  const calls: { preset?: string; callerPreset?: string }[] = []
  const known = {
    createSession: async (_target: unknown, opts: { preset?: string; callerPreset?: string }) => {
      calls.push(opts)
      return { ok: false, error: 'stop here' } // the params are what matters; the start ends at once
    },
  }
  const reader = new Proxy(known, { get: (t, k) => (k in t ? t[k as keyof typeof t] : async () => ({ ok: true })) }) as unknown as LinkedSessions
  const agents = new RemoteAgents(
    { children: new ChildOwnership(store), store, linkedReader: reader, meta: new Map([[caller.id, caller]]), emit: () => {}, uiPreferences: () => ({}) } as unknown as RemoteAgentsHost,
    { agentCeilingError: () => null, reservePlace: () => ({ release: () => {} }) },
  )
  const makeChild = (agents as unknown as { makeChild: (...a: unknown[]) => Promise<unknown> }).makeChild.bind(agents)
  await makeChild('h1', caller, { task: 'T', machine: 'Box' }, { machine: { id: 'm1', name: 'Box' }, target: { id: 'm1.p', name: 'app' }, tool: 'claude', startedAt: 0, preset, there: null, unasked: false }, reader, () => {})
  expect(calls).toHaveLength(1)
  return calls[0]!
}

describe('a child on a linked machine (#1525)', () => {
  it('goes as normal for an edits caller, and the caller too: edits is never put on the link', async () => {
    expect(await sentFor('edits')).toMatchObject({ preset: 'normal', callerPreset: 'normal' })
  })

  it('keeps the other presets as before', async () => {
    expect(await sentFor('normal')).toMatchObject({ preset: 'normal', callerPreset: 'normal' })
    expect(await sentFor('safe')).toMatchObject({ preset: 'safe', callerPreset: 'safe' })
    expect(await sentFor('auto')).toMatchObject({ callerPreset: 'auto' })
  })
})
