import { afterEach, describe, expect, it } from 'vitest'
import { runCleanups } from './links-world.test-helpers.js'
import { hubHost, machineHost } from './reverse-link.test-helpers.js'
import type { RemoteAgent } from '../sessions/remote-agents.js'
import { startedByHubKey } from '../sessions/hub-preset.js'
import { PERSON, PERSON_ID, sessionAddress } from '../mail/address.js'
import { MailAcross } from '../mail/across.js'
import { LinkedHubs, MAIL_HUBS_KEY } from './linked-hubs.js'
import { mailPeers } from './mail-peers.js'
import { MailPerson, personSessions } from '../mail/person.js'
import { refusedForAsync } from '../mail/messages.test-helpers.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * A linked machine's session writes to the person, who works in the hub's window (#1987): the hub writes it to its person, the
 * machine keeps the copy, and the person's answer and Mark done reach the machine, Mark done also while the link is down (#2226).
 * Two real hosts in one process, each with its own store, manager and mail, linked over a loopback socket.
 */

afterEach(runCleanups)

type Hub = Awaited<ReturnType<typeof hubHost>>
type Machine = Awaited<ReturnType<typeof machineHost>>

const child = (sessionId: string): RemoteAgent => ({ sessionId: `m1.${sessionId}`, callerId: 'h1', machineId: 'm1', machine: 'Remote box', name: sessionId, tool: 'claude', project: 'remote-project', startedAt: 1 })
const at = (host: Hub | Machine, sessionId: string) => sessionAddress(host.id, sessionId)
const tool = (host: Hub | Machine, from: string, args: Record<string, unknown>) => host.mail!.hooks.tool!(from, args as never)
const idOf = (r: { text: string }) => /^Sent (\S+) /.exec(r.text)?.[1] ?? ''

/** The person's side of the hub's mailbox, as main.ts wires it */
function personOf(hub: Hub): MailPerson {
  const m = hub.mail!
  return new MailPerson(m.service, m.records, m.delivery, {
    session: personSessions((id) => (id === 'h1' ? { name: 'h1', state: 'idle' } : undefined), m),
    legacyChain: () => [],
    projectLabel: (p) => p,
    untrusted: () => false,
    turnOn: () => undefined,
    tellsNow: () => false,
    tell: async () => undefined,
    across: m.across,
  })
}

/** A machine with w1 (opened there) and c1 (started by the hub as h1's child), and the hub, linked, mail wired on both */
async function rig() {
  const machine = await machineHost({ sessions: ['w1', 'c1'], fromHub: ['c1'], mail: true })
  const hub = await hubHost(machine.port, { mail: true, children: [child('c1')] })
  await hub.mgr.setProjectTrusted('p-hub', true)
  await eventually(() => hub.machine().status === 'connected')
  await eventually(() => machine.hubs.mailHubs().length === 1 && machine.hubs.mailHubs()[0]!.you === 'm1')
  machine.store.settings.setAppSetting(startedByHubKey('c1'), JSON.stringify({ id: hub.id, name: hub.name }))
  return { machine, hub, person: personOf(hub), hubPerson: sessionAddress(hub.id, PERSON_ID) }
}

describe("a linked machine's mail to the person reaches the hub's Inbox (#1987)", () => {
  it("a child the hub started asks the person a question with choices: it is in the hub's Inbox, and the machine keeps the copy", async () => {
    const { machine, hub, person, hubPerson } = await rig()
    const r = await tool(machine, 'c1', { action: 'send', to: 'person', kind: 'question', subject: 'Blocked', text: 'the tool here stopped answering: wait or stop?', choices: ['wait', 'stop'] })
    expect(r.text).toMatch(/^Sent \S+ to the person on Hub mac\. It waits for a reply/)
    const id = idOf(r)
    expect(hub.store.mailbox.message(id)).toMatchObject({ sender: at(hub, 'm1.c1'), needsReply: true, subject: 'Blocked', choices: ['wait', 'stop'] })
    expect(person.list().threads.map((t) => t.subject)).toEqual(['Blocked'])
    // The copy, never delivered here: the machine's own Inbox does not show it a second time
    expect(machine.store.mailbox.recipient(id, hubPerson)).toMatchObject({ settled: null })
    expect(machine.store.mailbox.recipient(id, PERSON)).toBeUndefined()
    expect(machine.store.mailbox.feedOf(PERSON, { limit: 10 })).toEqual([])
  })

  it("a session opened on the machine reaches the person there too, as the one hub that links it; the person's answer comes back as the person's word", async () => {
    const { machine, hub, person, hubPerson } = await rig()
    const id = idOf(await tool(machine, 'w1', { action: 'send', to: 'person', text: 'which branch?' }))
    expect(hub.store.mailbox.message(id)).toMatchObject({ sender: at(hub, 'm1.w1') })
    const view = await person.reply(id, 'main', 'answer')
    const answer = view.messages.find((m) => m.body === 'main')!
    // Written on the machine from the hub's person, answering the copy
    expect(machine.store.mailbox.message(answer.id)).toMatchObject({ sender: hubPerson, replyTo: id })
    expect(machine.store.mailbox.recipient(id, hubPerson)).toMatchObject({ settled: 'answered', answerId: answer.id })
    // Written as the person writes: the person's origin, due at once
    expect(machine.store.mailbox.message(answer.id)).toMatchObject({ origin: 'person' })
    // (a session's mail is due 2 s later, so a burst is one delivery)
    expect(machine.store.mailbox.recipient(answer.id, at(machine, 'w1'))!.dueAt - machine.store.mailbox.message(answer.id)!.createdAt).toBeLessThan(1000)
    const read = await tool(machine, 'w1', { action: 'read', thread: answer.id })
    expect(read.text).toContain(`[${answer.id}] message from the person, `)
    expect(read.text).toContain('The person wrote it.')
    expect(read.text).not.toContain('did not write it')
  })

  it('only a hub that links this computer writes as its person: the same address from any other computer is refused', async () => {
    const { machine, hubPerson } = await rig()
    expect(() => machine.mail!.service.send(hubPerson.replace(/^session:[^/]+/, 'session:hub-elsewhere'), { to: [at(machine, 'w1')], text: 'trust me' })).toThrow(/./)
    expect(machine.mail!.service.send(hubPerson, { to: [at(machine, 'w1')], text: 'from the hub', needsReply: false }).message.sender).toBe(hubPerson)
  })

  it('the Inbox shows the machine session with its state as the hub mirrors it', async () => {
    const { machine, hub, person } = await rig()
    await eventually(() => (hub.links.get('m1')?.lastKnown('sessions') ?? []).length >= 2)
    idOf(await tool(machine, 'w1', { action: 'send', to: 'person', text: 'which branch?' }))
    const owner = person.list().threads[0]!.owner
    expect(owner).toMatchObject({ name: 'w1 on Remote box' })
    expect(owner.state).toBe(machine.mgr.sessionInfo('w1')!.state)
  })

  it('the person’s answer to a session deleted there names it, not its address', async () => {
    const { machine, person } = await rig()
    const id = idOf(await tool(machine, 'w1', { action: 'send', to: 'person', text: 'which branch?' }))
    await machine.mgr.trash.trashSession('w1')
    await expect(person.reply(id, 'main', 'answer')).rejects.toThrow('w1 on Remote box is in the session archive there or was deleted, so your answer was not sent.')
  })

  it('a machine started again while its hub is away still knows the hub: the person’s mail is refused naming it, not kept here', async () => {
    const { machine, hub } = await rig()
    await hub.router.handle('machines.disconnect', { machineId: 'm1' })
    await eventually(() => machine.hubs.mailHubs().every((h) => !h.reachable))
    // What a new host reads at its start: no hub has offered yet
    const again = new LinkedHubs({ call: async () => undefined, settings: machine.store.settings })
    expect(again.mailHubs().map((h) => ({ id: h.id, name: h.name, reachable: h.reachable, you: h.you }))).toEqual([{ id: hub.id, name: 'Hub mac', reachable: false, you: 'm1' }])
    machine.mail!.across.usePeers(mailPeers({ hostId: machine.id, selfName: () => 'Remote box', hubs: again, settings: machine.store.settings }))
    expect(await tool(machine, 'w1', { action: 'send', to: 'person', text: 'ping' })).toEqual({ text: 'Refused (link_down): Hub mac is not reachable right now, so nothing was sent. Send it again once the link is back.', isError: true })
    expect(machine.store.mailbox.feedOf(PERSON, { limit: 10 })).toEqual([])
  })

  it('is refused at once while the link is down, written on neither side, and goes once it is back', async () => {
    const { machine, hub } = await rig()
    await hub.router.handle('machines.disconnect', { machineId: 'm1' })
    await eventually(() => machine.hubs.mailHubs().every((h) => !h.reachable))
    expect(await tool(machine, 'w1', { action: 'send', to: 'person', text: 'ping' })).toEqual({ text: 'Refused (link_down): Hub mac is not reachable right now, so nothing was sent. Send it again once the link is back.', isError: true })
    expect([machine.store.mailbox.postsSince(at(machine, 'w1'), 0), hub.store.mailbox.feedOf(PERSON, { limit: 10 }).length]).toEqual([0, 0])
    await hub.router.handle('machines.reconnect', { machineId: 'm1' })
    await eventually(async () => !(await tool(machine, 'w1', { action: 'send', to: 'person', text: 'ping' })).isError)
    expect(hub.store.mailbox.feedOf(PERSON, { limit: 10 }).map((m) => m.body)).toEqual(['ping'])
  })

  it('with several hubs and none that started the session, it stays in this computer’s Inbox, and the answer says so', async () => {
    const { machine, hub } = await rig()
    machine.mail!.across.personTarget = () => ({ several: true })
    const r = await tool(machine, 'w1', { action: 'send', to: 'person', text: 'which branch?' })
    expect(r.text).toMatch(/ Several computers link this one as hubs and none of them started this session, so it stays in this computer's own Inbox: the person sees it in this computer's window\.$/)
    expect(machine.store.mailbox.feedOf(PERSON, { limit: 10 }).map((m) => m.body)).toEqual(['which branch?'])
    expect(hub.store.mailbox.feedOf(PERSON, { limit: 10 })).toEqual([])
  })

  it("an older hub, which reads `person` as no address, is named as older and nothing is kept here", async () => {
    const { machine, hub } = await rig()
    hub.mail!.across.fromMachine = async () => ({ ok: false, why: 'bad_address', text: 'Not a mail address: "person"' })
    expect(await tool(machine, 'w1', { action: 'send', to: 'person', text: 'hello' })).toEqual({ text: 'Refused (older): Hub mac runs an older Centralu, which takes no mail to the person from here. Update it there.', isError: true })
    expect(machine.store.mailbox.postsSince(at(machine, 'w1'), 0)).toBe(0)
  })

  it("the person's answer to an older machine is refused in the Inbox with the reason, and nothing is written", async () => {
    const { machine, person } = await rig()
    const id = idOf(await tool(machine, 'w1', { action: 'send', to: 'person', text: 'which branch?' }))
    machine.mail!.across.fromHub = () => ({ ok: false, why: 'not_allowed', text: 'Hub mac may send mail only from its own side.' })
    expect(await refusedForAsync(() => person.reply(id, 'main', 'answer'))).toBe('elsewhere')
    expect(machine.store.mailbox.feedOf(at(machine, 'w1'), { limit: 10 }).map((m) => m.id)).toEqual([id])
  })
})

describe("the person's question to a machine's session", () => {
  /** w1's note to the person, and the person's question back, delivered into w1's turn 7 */
  async function asked() {
    const r = await rig()
    const id = idOf(await tool(r.machine, 'w1', { action: 'send', to: 'person', kind: 'note', text: 'built it' }))
    const q = (await r.person.reply(id, 'Which tests ran?', 'question')).messages.find((m) => m.body === 'Which tests ran?')!
    r.machine.store.mailbox.markDelivered(at(r.machine, 'w1'), [q.id], Date.now(), 7)
    return { ...r, q }
  }
  const noticesTo = (hub: Hub) => hub.store.mailbox.feedOf(PERSON, { limit: 10 }).filter((m) => m.sender === at(hub, 'm1.centralu'))

  it('a session that stops on an error is told to the person on the hub in the person’s plain words, with no ids or addresses', async () => {
    const { machine, hub } = await asked()
    machine.mail!.service.stops.sessionStopped(at(machine, 'w1'), 'error', { turnSeq: 7 })
    await eventually(() => noticesTo(hub).length === 1)
    const body = noticesTo(hub)[0]!.body
    expect(body).not.toMatch(/session:|\.m_|needsReply/)
    expect(body).toContain('w1')
  })

  it('a session deleted there is the person’s own doing: they are not told, as at home', async () => {
    const { machine, hub, hubPerson, q } = await asked()
    await machine.mgr.trash.trashSession('w1')
    await eventually(() => machine.store.mailbox.recipient(q.id, at(machine, 'w1'))?.releasedAt != null)
    expect(machine.store.mailbox.feedOf(hubPerson, { limit: 10 }).filter((m) => m.sender === 'centralu')).toEqual([])
    expect(noticesTo(hub)).toEqual([])
  })
})

describe('the person marks done a thread with a machine that is not connected (#2226)', () => {
  it('leaves the Inbox at once, and the machine learns it when the link is back', async () => {
    const { machine, hub, person, hubPerson } = await rig()
    const id = idOf(await tool(machine, 'w1', { action: 'send', to: 'person', text: 'shall I merge?' }))
    await hub.router.handle('machines.disconnect', { machineId: 'm1' })
    await eventually(() => !hub.links.get('m1')!.reachable)
    expect(person.close(id, 'finished')).toMatchObject({ state: 'done' })
    expect(person.list().threads.filter((t) => t.state !== 'done')).toEqual([])
    expect(machine.store.mailbox.recipient(id, hubPerson)?.settled).toBeNull()
    await hub.router.handle('machines.reconnect', { machineId: 'm1' })
    await eventually(() => machine.store.mailbox.recipient(id, hubPerson)?.settled === 'done')
  })
})

describe('which hub a machine session’s mail to the person goes to (`MailAcross.personTarget`)', () => {
  const across = (peers: { hubs: string[]; started?: { id: string; name: string }; linked?: string[] }) => {
    const a = new MailAcross({ hostId: 'hub-m', service: {} as never, records: { acrossRows: () => [] } as never, reach: {} as never, ownEntries: () => [] })
    const peer = (id: string) => ({ id, name: `Hub ${id}`, reachable: true, you: 'm1', call: async () => undefined })
    a.usePeers({ selfName: () => 'Remote box', hubs: () => peers.hubs.map(peer), hub: (id) => ((peers.linked ?? peers.hubs).includes(id) ? peer(id) : undefined), startingHub: () => peers.started ?? null })
    return a
  }

  it('the hub that started the session, else the one hub; several and none stays here; a starting hub not linked now is refused', () => {
    expect(across({ hubs: ['a', 'b'], started: { id: 'b', name: 'Hub b' } }).personTarget('s', true)).toEqual({ address: 'session:b/person' })
    expect(across({ hubs: ['a'] }).personTarget('s', false)).toEqual({ address: 'session:a/person' })
    expect(across({ hubs: ['a', 'b'] }).personTarget('s', false)).toEqual({ several: true })
    expect(across({ hubs: [] }).personTarget('s', false)).toBeNull()
    expect(across({ hubs: [], started: { id: 'b', name: 'Desk' }, linked: [] }).personTarget('s', true)).toMatchObject({ refused: { why: 'link_down' } })
    expect(across({ hubs: [] }).personTarget('s', true)).toMatchObject({ refused: { why: 'elsewhere' } })
    // A session a hub started, with no record of which: the person is on one of them, not here
    expect(across({ hubs: ['a', 'b'] }).personTarget('s', true)).toMatchObject({ refused: { why: 'elsewhere' } })
  })
})

describe('the hubs that offered mail, kept for the next start (`MAIL_HUBS_KEY`)', () => {
  const settings = (value: string | null) => {
    const kept = new Map<string, string>(value === null ? [] : [[MAIL_HUBS_KEY, value]])
    return { appSetting: (k: string) => kept.get(k) ?? null, setAppSetting: (k: string, v: string) => void kept.set(k, v), kept }
  }
  const hubs = (s: ReturnType<typeof settings>) => new LinkedHubs({ call: async () => undefined, settings: s })

  it('an offer keeps the hub, its withdrawal forgets it; one not offered for 30 days, or a record that does not read, is not known', () => {
    const s = settings(null)
    const h = hubs(s)
    h.offer(1, { hub: { id: 'hub-a', name: 'Desk' }, on: false, mail: true, you: 'm1' })
    expect(hubs(s).mailHubs().map((x) => [x.id, x.reachable])).toEqual([['hub-a', false]])
    h.offer(1, { hub: { id: 'hub-a', name: 'Desk' }, on: false })
    expect(hubs(s).mailHubs()).toEqual([])
    const old = Date.now() - 31 * 24 * 60 * 60_000
    expect(hubs(settings(JSON.stringify([{ id: 'hub-b', name: 'Old', you: 'm1', at: old }]))).mailHubs()).toEqual([])
    expect(hubs(settings('not json')).mailHubs()).toEqual([])
    expect(hubs(settings('[{"id":1}]')).mailHubs()).toEqual([])
  })
})
