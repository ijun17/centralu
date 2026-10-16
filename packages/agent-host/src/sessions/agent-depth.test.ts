import { describe, expect, it } from 'vitest'
import { agentDepthRefusal, sessionDepth } from './agent-depth.js'

type Link = { askedBy?: string; forkedFrom?: string }
const metaOf = (links: Record<string, Link>) => new Map(Object.entries(links))
const delegation = (callerId: string, sessionId: string, settled = false) => ({ callerId, sessionId, settled })

describe('how deep a session is below the one the person started (#867)', () => {
  it('a session the person started is 0; each start_agent child (askedBy) one deeper', () => {
    const meta = metaOf({ p: {}, c: { askedBy: 'p' }, g: { askedBy: 'c' }, gg: { askedBy: 'g' } })
    expect(['p', 'c', 'g', 'gg'].map((id) => sessionDepth(id, meta, []))).toEqual([0, 1, 2, 3])
  })

  it('a session working on a task another session gave it is one deeper than that session, until the task settles', () => {
    const meta = metaOf({ p: {}, c: { askedBy: 'p' }, other: {} })
    expect(sessionDepth('other', meta, [delegation('c', 'other')])).toBe(2)
    expect(sessionDepth('other', meta, [delegation('c', 'other', true)])).toBe(0)
  })

  it('the deepest link wins', () => {
    const meta = metaOf({ p: {}, c: { askedBy: 'p' }, g: { askedBy: 'c' }, x: { askedBy: 'p' } })
    expect(sessionDepth('x', meta, [delegation('g', 'x')])).toBe(3)
  })

  it('a fork whose requester is no longer known is at least 1; one with a live requester counts from it', () => {
    const meta = metaOf({ p: {}, c: { askedBy: 'p' }, f: { forkedFrom: 'p' } })
    expect(sessionDepth('f', meta, [])).toBe(1)
    expect(sessionDepth('f', meta, [delegation('c', 'f')])).toBe(2)
  })

  it('a deleted parent does not make a session shallower than it was started (#897 review)', () => {
    // g was started two levels down; its parent c is gone, so its links alone say 1
    const meta = metaOf({ p: {}, g: { askedBy: 'c' } })
    expect(sessionDepth('g', meta, [])).toBe(1)
    expect(sessionDepth('g', meta, [], (id) => (id === 'g' ? 2 : 0))).toBe(2)
    // A recorded ancestor counts for what hangs below it too
    expect(sessionDepth('x', metaOf({ x: { askedBy: 'g' } }), [], (id) => (id === 'g' ? 2 : 0))).toBe(3)
    // The links still win when they are deeper than the record
    expect(sessionDepth('g', metaOf({ p: {}, c: { askedBy: 'p' }, g: { askedBy: 'c' } }), [], (id) => (id === 'g' ? 1 : 0))).toBe(2)
  })

  it('two sessions giving each other tasks count once, not forever', () => {
    const meta = metaOf({ a: {}, b: {} })
    expect(sessionDepth('a', meta, [delegation('a', 'b'), delegation('b', 'a')])).toBe(2)
  })
})

describe('the refusal (#867)', () => {
  const host = (agentDepth: number | undefined, links: Record<string, Link>) => ({
    meta: metaOf(links),
    children: { delegations: new Map<string, ReturnType<typeof delegation>>() },
    uiPreferences: () => ({ agentDepth }),
    store: { appSetting: () => null, setAppSetting: () => {} },
  })
  const chain = { p: {}, c: { askedBy: 'p' }, g: { askedBy: 'c' }, gg: { askedBy: 'g' } }

  it('sweeps every setting against every depth: a session starts agents only above it; nothing saved is 1', () => {
    for (const limit of [undefined, 1, 2, 3]) {
      for (const [depth, id] of ['p', 'c', 'g', 'gg'].entries()) {
        const refused = agentDepthRefusal(host(limit, chain), id, 'start agents')
        expect(refused === null, `limit ${limit}, depth ${depth}`).toBe(depth < (limit ?? 1))
      }
    }
  })

  it('names the setting, where it is, and its value', () => {
    expect(agentDepthRefusal(host(2, chain), 'g', 'start agents')).toBe(
      'This session is 2 levels below a session the person started, and "How deep agents may start agents" in Settings → Orchestrator is 2, so it cannot start agents. Say in your answer what is needed instead; the person can raise that setting.',
    )
  })
})
