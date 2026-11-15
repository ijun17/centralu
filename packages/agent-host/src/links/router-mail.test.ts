import { describe, expect, it } from 'vitest'
import { Router } from './router.js'
import { FakeMachine, rig } from './router.test-helpers.js'

/**
 * The hub's Tasks across linked machines (#2268, docs/plans/linked-mail.md §11): every machine's open work in one list, one row per message and
 * recipient, a machine that could not be read named, and a machine's chain opened there to read.
 */

const HUB = 'hub-aaaa1111'
const OWN1 = 'hub-bbbb2222'
const OWN2 = 'hub-cccc3333'
const id = (host: string, n: string) => `${host}.m_01JABCDEFGHJKMNPQRSTVWXY${n}`
const at = (host: string, sessionId: string, name: string | null = null) => ({ address: `session:${host}/${sessionId}`, kind: 'session', sessionId, name, state: null })
const PERSON = { address: 'person', kind: 'person', sessionId: null, name: null, state: null }
const row = (o: { id: string; owner: unknown; assignee: unknown; state?: string; updatedAt?: number; outcome?: string | null }) => ({
  id: o.id,
  root: o.id,
  subject: 'Port the docs',
  kind: 'assign',
  owner: o.owner,
  assignee: o.assignee,
  state: o.state ?? 'open',
  outcome: o.outcome ?? null,
  createdAt: 1,
  updatedAt: o.updatedAt ?? 1,
})

/** The router's rig, each machine having answered the hub's offer with its id in mail */
function linked() {
  const r = rig()
  r.m1.q.mail = { hub: HUB, own: OWN1, computer: () => r.m1.name }
  r.m2.q.mail = { hub: HUB, own: OWN2, computer: () => r.m2.name }
  r.m2.answers['mail.tasks'] = { tasks: [], capped: null }
  return r
}

describe("the hub's Tasks across linked machines (#2268)", () => {
  it("lists a machine's work after the hub's own, in the hub's terms, opening on that machine", async () => {
    const { router, localAnswers, m1 } = linked()
    const own = row({ id: id(HUB, '01'), owner: PERSON, assignee: at(HUB, 'h1', 'Lead') })
    localAnswers['mail.tasks'] = { tasks: [own], capped: null }
    m1.answers['mail.tasks'] = { tasks: [row({ id: id(OWN1, '02'), owner: at(OWN1, 'w1', 'Docs'), assignee: at(OWN1, 'w2', 'Review'), state: 'running' })], capped: null }
    const r = (await router.handle('mail.tasks', {})) as Record<string, unknown>
    expect(r.tasks).toEqual([
      own,
      { ...row({ id: id(OWN1, '02'), owner: at(HUB, 'm1.w1', 'Docs on Machine m1'), assignee: at(HUB, 'm1.w2', 'Review on Machine m1'), state: 'running' }), root: `m1.${id(OWN1, '02')}` },
    ])
    expect(r.capped).toBeNull()
    expect(r).not.toHaveProperty('unreached')
  })

  it('lists mail that crossed once: the hub’s row, with the state the machine its recipient is on gives it', async () => {
    const { router, localAnswers, m1, m2 } = linked()
    // The hub's session gave a machine's session work: the hub keeps its copy, the machine the message
    const crossed = id(HUB, '03')
    localAnswers['mail.tasks'] = { tasks: [row({ id: crossed, owner: at(HUB, 'h1'), assignee: at(HUB, 'm1.w1'), updatedAt: 1 })], capped: null }
    // One machine's session to another's, which the hub passes on and keeps no copy of: both machines list it
    const across = id(OWN1, '04')
    m1.answers['mail.tasks'] = {
      tasks: [
        row({ id: crossed, owner: at(HUB, 'h1'), assignee: at(OWN1, 'w1'), state: 'running', updatedAt: 5 }),
        row({ id: across, owner: at(OWN1, 'w1'), assignee: at(HUB, 'm2.z'), updatedAt: 2 }),
      ],
      capped: null,
    }
    m2.answers['mail.tasks'] = { tasks: [row({ id: across, owner: at(HUB, 'm1.w1'), assignee: at(OWN2, 'z'), state: 'done', outcome: 'answered', updatedAt: 9 })], capped: null }
    const r = (await router.handle('mail.tasks', {})) as { tasks: Record<string, unknown>[] }
    expect(r.tasks).toHaveLength(2)
    expect(r.tasks[0]).toEqual(row({ id: crossed, owner: at(HUB, 'h1'), assignee: at(HUB, 'm1.w1'), state: 'running', updatedAt: 5 }))
    expect(r.tasks[1]).toMatchObject({ id: across, root: `m2.${across}`, assignee: { address: `session:${HUB}/m2.z` }, state: 'done', outcome: 'answered', updatedAt: 9 })
  })

  it('names each machine it could not read, and leaves out unnamed one from before Tasks, which has none to list', async () => {
    const { router, localAnswers, m1, m2 } = linked()
    localAnswers['mail.tasks'] = { tasks: [], capped: null }
    m1.reachable = false
    m2.answers['mail.tasks'] = new Error('the link dropped')
    expect(await router.handle('mail.tasks', {})).toEqual({
      tasks: [],
      capped: null,
      unreached: [
        { machineId: 'm1', name: 'Machine m1' },
        { machineId: 'm2', name: 'Machine m2' },
      ],
    })
    m1.reachable = true
    m1.answers['mail.tasks'] = { tasks: [], capped: null }
    m2.answers['mail.tasks'] = new Error('Unknown method: mail.tasks. This Centralu host does not have it; the window may be from another build.')
    expect(await router.handle('mail.tasks', {})).toEqual({ tasks: [], capped: null })
  })

  it('says how many open rows are listed when a host capped its list, an uncapped host counting the open rows it listed', async () => {
    const { router, localAnswers, m1 } = linked()
    localAnswers['mail.tasks'] = { tasks: [], capped: 2000 }
    const w = at(OWN1, 'w1')
    m1.answers['mail.tasks'] = { tasks: [row({ id: id(OWN1, '05'), owner: w, assignee: w }), row({ id: id(OWN1, '06'), owner: w, assignee: w, state: 'done' })], capped: null }
    expect(await router.handle('mail.tasks', {})).toMatchObject({ capped: 2001 })
    localAnswers['mail.tasks'] = { tasks: [], capped: null }
    expect(await router.handle('mail.tasks', {})).toMatchObject({ capped: null })
  })
})

describe("a linked machine's chain, opened from the hub's Tasks (#2268)", () => {
  const view = (root: string, sender: unknown) => ({
    thread: { id: root, subject: 'Port the docs', state: 'open', owner: sender, assignee: null, createdAt: 1, updatedAt: 1 },
    parties: [{ party: sender, role: 'member' }],
    blockers: [],
    messages: [{ id: root, seq: 1, sender, kind: 'assign', body: 'Translate the guide', createdAt: 1 }],
    canReply: true,
    lookIn: false,
  })

  it('is read on that machine and comes back in the hub’s terms, to read only', async () => {
    const { router, local, m1 } = linked()
    const root = id(OWN1, '07')
    m1.answers['mail.thread'] = view(root, at(OWN1, 'w1', 'Docs'))
    const r = await router.handle('mail.thread', { threadId: `m1.${root}`, tail: 100 })
    expect(m1.calls).toEqual([{ method: 'mail.thread', params: { threadId: root, tail: 100 } }])
    expect(local).toEqual([])
    const hubW1 = at(HUB, 'm1.w1', 'Docs on Machine m1')
    expect(r).toEqual({ ...view(`m1.${root}`, hubW1), messages: [{ id: root, seq: 1, sender: hubW1, kind: 'assign', body: 'Translate the guide', createdAt: 1 }], canReply: false, lookIn: true })
  })

  it("stays on the hub for the hub's own chain, whose id starts with the hub's host id, shaped as a machine id, even with such a machine linked", async () => {
    const local: unknown[] = []
    const shaped = new FakeMachine(HUB, 1)
    const router = new Router({ local: async (method, params) => (local.push({ method, params }), { ok: true }), machines: () => [shaped] })
    const own = id(HUB, '08')
    await router.handle('mail.thread', { threadId: own })
    expect(local).toEqual([{ method: 'mail.thread', params: { threadId: own } }])
    expect(shaped.calls).toEqual([])
    // The same prefix before another host's id is that machine's chain
    await router.handle('mail.thread', { threadId: `${HUB}.${id(OWN1, '09')}` })
    expect(shaped.calls).toEqual([{ method: 'mail.thread', params: { threadId: id(OWN1, '09') } }])
  })
})
