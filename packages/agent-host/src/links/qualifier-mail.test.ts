import { describe, expect, it } from 'vitest'
import { Qualifier } from './qualifier.js'

/**
 * A linked machine's mail in the hub's terms (#2268): the hub lists the machine's Tasks and opens its chains, so every party they name reads as the
 * hub's mail names it (docs/plans/linked-mail.md §6), and the machine's mail news reaches the hub's windows without being news for the person.
 */

const HUB = 'hub-aaaa1111'
/** The machine's own id in mail addresses (its answer to the hub's offer) */
const OWN = 'hub-bbbb2222'
const ROOT = `${OWN}.m_01JABCDEFGHJKMNPQRSTVWXY01`

const party = (address: string, extra: Record<string, unknown> = {}) => ({ address, kind: 'session', sessionId: null, name: null, state: null, ...extra })

function machine(own: string | null = OWN) {
  const q = new Qualifier('m1', 1)
  q.mail = { hub: HUB, own, computer: () => 'Box' }
  return q
}

describe("a linked machine's mail parties in the hub's terms", () => {
  it("names the machine's own session as the hub does, `<name> on <machine>`", () => {
    expect(machine().mailParty(party(`session:${OWN}/w1`, { sessionId: 'w1', name: 'Docs', state: 'idle' }))).toEqual(
      party(`session:${HUB}/m1.w1`, { sessionId: 'm1.w1', name: 'Docs on Box', state: 'idle' }),
    )
  })

  it("reads the hub's person, which the machine names as an address of the hub, as the person", () => {
    expect(machine().mailParty(party(`session:${HUB}/person`, { sessionId: 'person' }))).toEqual({ address: 'person', kind: 'person', sessionId: null, name: null, state: null })
  })

  it("keeps what is on the hub's side already, the person, Centralu, and any other host's", () => {
    const q = machine()
    for (const p of [
      party(`session:${HUB}/h1`, { sessionId: 'h1', name: 'Lead' }),
      party(`session:${HUB}/m2.x`, { sessionId: 'm2.x' }),
      // A session of a machine the machine links itself as a hub, and one of another hub that links it: not the hub's to rename
      party(`session:${OWN}/m3.y`, { sessionId: 'm3.y' }),
      party('session:hub-cccc3333/z', { sessionId: 'z' }),
      { address: 'person', kind: 'person', sessionId: null, name: null, state: null },
      { address: 'centralu', kind: 'centralu', sessionId: null, name: null, state: null },
    ]) {
      expect(q.mailParty(p)).toEqual(p)
    }
  })

  it("qualifies the project of the machine's own app", () => {
    expect(machine().mailParty({ address: `app:${OWN}/p1/notes`, kind: 'app', sessionId: null, name: 'notes', state: null })).toEqual({
      address: `app:${HUB}/m1.p1/notes`,
      kind: 'app',
      sessionId: null,
      name: 'notes',
      state: null,
    })
    expect(machine().mailParty({ address: 'app:hub-cccc3333/p1/notes', kind: 'app' })).toEqual({ address: 'app:hub-cccc3333/p1/notes', kind: 'app' })
  })

  it("leaves the machine's own sessions as they are when its answer did not say its id (a build from before it), and everything before the offer is answered", () => {
    const own = party(`session:${OWN}/w1`, { sessionId: 'w1', name: 'Docs' })
    expect(machine(null).mailParty(own)).toEqual(own)
    expect(machine(null).mailParty(party(`session:${HUB}/person`))).toMatchObject({ address: 'person', kind: 'person' })
    expect(new Qualifier('m1', 1).mailParty(own)).toEqual(own)
  })

  it('qualifies a Tasks row so it opens on the machine, and keeps its message id, which is every host’s', () => {
    expect(machine().taskRow({ id: ROOT, root: ROOT, owner: party(`session:${OWN}/w1`, { sessionId: 'w1' }), assignee: party('person', { kind: 'person' }), state: 'open' })).toEqual({
      id: ROOT,
      root: `m1.${ROOT}`,
      owner: party(`session:${HUB}/m1.w1`, { sessionId: 'm1.w1' }),
      assignee: party('person', { kind: 'person' }),
      state: 'open',
    })
  })

  it("leaves out the items of the machine's own Inbox: what its own person gave or has, and what is held there for them", () => {
    const w1 = party(`session:${OWN}/w1`, { sessionId: 'w1' })
    const me = { address: 'person', kind: 'person', sessionId: null, name: null, state: null }
    const t = (owner: unknown, assignee: unknown, state = 'open') => ({ id: ROOT, root: ROOT, owner, assignee, state })
    const rows = machine().taskRows([t(me, w1, 'review'), t(w1, me), t(w1, party(`session:${OWN}/w2`), 'held'), t(w1, party(`session:${HUB}/person`)), 3])
    // What it cannot read passes as it is, for the window's parse
    expect(rows).toEqual([{ ...t(party(`session:${HUB}/m1.w1`, { sessionId: 'm1.w1' }), me), root: `m1.${ROOT}` }, 3])
  })

  it('names every party of a chain in the hub’s terms, and the chain and the ones it follows as the machine’s', () => {
    const w1 = party(`session:${OWN}/w1`, { sessionId: 'w1', name: 'Docs' })
    const hubW1 = party(`session:${HUB}/m1.w1`, { sessionId: 'm1.w1', name: 'Docs on Box' })
    const view = {
      thread: { id: ROOT, projectId: 'p1', owner: w1, assignee: null, ask: { id: ROOT, sender: w1, text: 'x', open: [ROOT] }, last: { sender: w1, kind: 'note', preview: 'x', at: 1 } },
      parties: [{ party: w1, role: 'member' }],
      blockers: [],
      messages: [{ id: ROOT, seq: 1, sender: w1, receipts: [{ recipient: w1, delivered: true, read: false, handled: false }] }, { id: 'x', seq: 2, sender: w1 }],
      follows: [{ id: ROOT, subject: 'before' }],
    }
    expect(machine().mailThread(view)).toEqual({
      thread: { id: `m1.${ROOT}`, projectId: 'm1.p1', owner: hubW1, assignee: null, ask: { id: ROOT, sender: hubW1, text: 'x', open: [ROOT] }, last: { sender: hubW1, kind: 'note', preview: 'x', at: 1 } },
      parties: [{ party: hubW1, role: 'member' }],
      blockers: [],
      messages: [{ id: ROOT, seq: 1, sender: hubW1, receipts: [{ recipient: hubW1, delivered: true, read: false, handled: false }] }, { id: 'x', seq: 2, sender: hubW1 }],
      follows: [{ id: `m1.${ROOT}`, subject: 'before' }],
    })
  })
})

describe("a linked machine's mail news", () => {
  it('reaches the hub’s windows naming the machine’s chain, never as something for the person to be told of', () => {
    const from = party(`session:${OWN}/w1`, { sessionId: 'w1' })
    expect(machine().event({ type: 'mail_changed', threadId: ROOT, toPerson: true, arrived: { messageId: ROOT, from, kind: 'note', preview: 'hi' } })).toEqual({
      type: 'mail_changed',
      threadId: `m1.${ROOT}`,
      toPerson: false,
    })
  })
})
