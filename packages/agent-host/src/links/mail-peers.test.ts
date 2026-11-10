import { describe, expect, it } from 'vitest'
import { mailPeers } from './mail-peers.js'

/** The directory a hub keeps of its machines' sessions for mail (`mailPeers`, #2067 item 3), from the rows they pushed */

describe("a hub's mail directory of a machine's sessions", () => {
  it('lists one paused on its own background work there as busy and paused, from the rows the machine pushed (#2146 review)', () => {
    const row = { name: 'Builder', kind: 'worker', state: 'waiting_input', createdAt: 1 }
    const sessions = [
      { ...row, id: 'p1', backgroundTasks: [{ id: 'a1', kind: 'agent', description: 'review', status: 'running' }] },
      { ...row, id: 'r1', backgroundTasks: [] },
    ]
    const m = { id: 'm1', name: 'Box', reachable: true, call: async () => null, lastKnown: (kind: string) => (kind === 'sessions' ? sessions : []) }
    const peers = mailPeers({ hostId: 'hub-1a2b3c4d', selfName: () => 'Hub', machines: { get: () => m, all: () => [m] } })
    const { entries } = peers.machineDirectory!()
    expect(entries.map((e) => [e.address, e.state, e.busy])).toEqual([
      ['session:hub-1a2b3c4d/m1.p1', 'paused', true],
      ['session:hub-1a2b3c4d/m1.r1', 'finished', false],
    ])
  })

  it('lists one with a card open there as waiting and busy, and one cut short as stopped, as the local directory does', () => {
    const row = { name: 'Builder', kind: 'worker', createdAt: 1 }
    const sessions = [
      { ...row, id: 'q1', state: 'working', pendingQuestions: [{ requestId: 'q', questions: [] }] },
      { ...row, id: 'a1', state: 'idle', pendingApproval: { requestId: 'a' } },
      { ...row, id: 'i1', state: 'idle', interruption: { kind: 'stopped' } },
    ]
    const m = { id: 'm1', name: 'Box', reachable: true, call: async () => null, lastKnown: (kind: string) => (kind === 'sessions' ? sessions : []) }
    const { entries } = mailPeers({ hostId: 'hub-1a2b3c4d', selfName: () => 'Hub', machines: { get: () => m, all: () => [m] } }).machineDirectory!()
    expect(entries.map((e) => [e.address, e.state, e.busy])).toEqual([
      ['session:hub-1a2b3c4d/m1.q1', 'waiting', true],
      ['session:hub-1a2b3c4d/m1.a1', 'waiting', true],
      ['session:hub-1a2b3c4d/m1.i1', 'stopped', false],
    ])
  })
})
