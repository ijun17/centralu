import { afterEach, describe, expect, it } from 'vitest'
import { runCleanups } from './links-world.test-helpers.js'
import { hubHost, machineHost } from './reverse-link.test-helpers.js'
import { REMOTE_AGENTS_KEY, type RemoteAgent } from '../sessions/remote-agents.js'
import { startedByHubKey, startingHub } from '../sessions/hub-preset.js'
import { sessionAddress } from '../mail/address.js'
import { SLOW, eventually } from '../../../../tooling/test-timing.js'

/**
 * Mail from a session a hub started on a linked machine to the session there that started it (#2067 item 1,
 * docs/plans/linked-mail.md §3): `parent` reaches the hub over the link the hub opened, the hub writes the message, and a
 * send the link refuses is written nowhere, so the same text may be sent again. Two real hosts in one process, each with
 * its own store, manager, mail and server, linked over a loopback socket.
 */

afterEach(runCleanups)

/** The hub's record of the child it started on the machine (`RemoteAgents`), as start_agent writes it */
const child = (sessionId: string, callerId = 'h1'): RemoteAgent => ({ sessionId: `m1.${sessionId}`, callerId, machineId: 'm1', machine: 'Remote box', name: sessionId, tool: 'claude', project: 'remote-project', startedAt: 1 })

type Hub = Awaited<ReturnType<typeof hubHost>>
type Machine = Awaited<ReturnType<typeof machineHost>>

/** A session's address on the host it is on (each host's mail has its own id, `hubSelfId`) */
const at = (host: Hub | Machine, sessionId: string) => sessionAddress(host.id, sessionId)

/** Messages a session sent, by its address on that host */
const sentBy = (host: Hub | Machine, sessionId: string) => host.store.mailbox.postsSince(at(host, sessionId), 0)

/** What the hub's parent `h1` was sent by the child, with its row */
function received(hub: Hub, childId = 'c1') {
  return hub.store.mailbox
    .feedOf(at(hub, 'h1'), { limit: 50 })
    .filter((m) => m.sender === at(hub, `m1.${childId}`))
    .map((m) => ({ body: m.body, needsReply: m.needsReply, row: hub.store.mailbox.recipient(m.id, at(hub, 'h1')) }))
}

/** Whether the machine has heard the hub's offer (its mail too) */
const offered = (machine: Machine, n = 1) => (machine.hubs as unknown as { hubs: Map<string, unknown> }).hubs.size >= n

/**
 * A machine whose session `c1` a hub started, and that hub (its switch for asks off unless `asks`), with the child in its
 * record when `records`
 */
async function rig(o: { asks?: boolean; hub?: Parameters<typeof hubHost>[1]; records?: boolean } = {}) {
  const machine = await machineHost({ sessions: ['w1', 'c1'], fromHub: ['c1'], mail: true })
  const hub = await hubHost(machine.port, { mail: true, ...(o.records !== false ? { children: [child('c1')] } : {}), ...o.hub })
  await eventually(() => hub.machine().status === 'connected')
  if (o.asks) await hub.router.handle('machines.setAsks', { machineId: 'm1', on: true })
  if (o.hub?.mail !== 'before' || o.asks) await eventually(() => offered(machine))
  startedBy(machine, 'c1', hub)
  return { machine, hub }
}

/** The machine's record of the hub that started a session, as `agents.createSession` writes it from the connection */
const startedBy = (machine: Machine, sessionId: string, hub: Hub) => machine.store.settings.setAppSetting(startedByHubKey(sessionId), JSON.stringify({ id: hub.id, name: hub.name }))

/** The child's `mail` tool, as its session calls it */
const send = (machine: Machine, text: string, more: { kind?: string; urgent?: boolean; from?: string; to?: string; cite?: boolean } = {}) =>
  machine.mail!.hooks.tool!(more.from ?? 'c1', { action: 'send', to: more.to ?? 'parent', text, ...(more.kind ? { kind: more.kind } : {}), ...(more.urgent ? { urgent: true } : {}), ...(more.cite ? { cite: true } : {}) })

describe('parent from a session a hub started on a linked machine (#2067 item 1)', () => {
  it('reaches the session that started it on the hub, written there, with a copy here under the same id, with the asks switch off', async () => {
    const { machine, hub } = await rig()
    expect(hub.machine().asks).toEqual({ on: false, note: null })
    const r = await send(machine, 'the build is green', { urgent: true })
    expect(r).toEqual({ text: expect.stringMatching(/^Sent \S+ to your parent "h1" on Hub mac\. It waits for a reply; the reply will reach you as mail\./) })
    // A question asks for a reply there now that a reply reaches the machine (#2067 item 2)
    expect(received(hub)).toEqual([{ body: 'the build is green', needsReply: true, row: expect.objectContaining({ recipient: at(hub, 'h1') }) }])
    // The id the child was told is the hub's message
    const id = /^Sent (\S+) /.exec(r.text)![1]!
    expect(hub.store.mailbox.message(id)).toMatchObject({ sender: at(hub, 'm1.c1'), body: 'the build is green' })
    // The parent reads the child by its name on its machine, not by an address
    expect(hub.mail!.service.labelOf(at(hub, 'm1.c1'))).toBe('c1 on Remote box')
    // The machine keeps its copy, under the hub's id, to the parent's address there
    expect(machine.store.mailbox.message(id)).toMatchObject({ sender: at(machine, 'c1'), body: 'the build is green' })
    expect(machine.store.mailbox.recipient(id, at(hub, 'h1'))).toBeDefined()
    // The hub's own guards hold for it: the same words again within the window are a repeat there
    expect(await send(machine, 'the build is green')).toEqual({ text: expect.stringMatching(/^Refused \(repeat\): you sent the same text to h1 less than/), isError: true })
    // A note is a note there too
    await send(machine, 'fyi: done', { kind: 'note' })
    expect(received(hub).find((m) => m.body === 'fyi: done')).toMatchObject({ needsReply: false })
  })

  it('is refused at once while the link is down, written nowhere, and the same text goes once the link is back', async () => {
    const { machine, hub } = await rig()
    await hub.router.handle('machines.disconnect', { machineId: 'm1' })
    await eventually(() => (machine.hubs as unknown as { hubs: Map<string, { client: number | null }> }).hubs.values().next().value?.client === null)
    expect(await send(machine, 'are you there?')).toEqual({ text: 'Refused (link_down): Hub mac is not reachable right now, so nothing was sent. Send it again once the link is back.', isError: true })
    expect(received(hub)).toEqual([])
    expect(sentBy(machine, 'c1')).toBe(0)
    // The retry rule: the refused send counted nowhere, so the same words are not a repeat
    await hub.router.handle('machines.reconnect', { machineId: 'm1' })
    await eventually(() => hub.machine().status === 'connected')
    await eventually(async () => !(await send(machine, 'are you there?')).isError)
    expect(received(hub).map((m) => m.body)).toEqual(['are you there?'])
  })

  it('a body over the mailbox limit is refused here in its words and never crosses; an error the hub answers is its refusal, not a lost link', async () => {
    const { machine, hub } = await rig()
    expect(await send(machine, 'x'.repeat(250_000))).toEqual({ text: 'Refused (too_long): a body from this sender is at most 16000 characters', isError: true })
    expect(await send(machine, 'y'.repeat(16_001))).toMatchObject({ text: expect.stringMatching(/^Refused \(too_long\)/) })
    expect(hub.heard).toEqual([])
    expect(await send(machine, 'z'.repeat(16_000))).toMatchObject({ text: expect.stringMatching(/^Sent /) })
    expect(received(hub).map((m) => m.body.length)).toEqual([16_000])
  })

  it('a session the hub no longer knows is refused as gone, and nothing is written on either side', async () => {
    const { machine, hub } = await rig({ records: false })
    expect(await send(machine, 'hello parent')).toEqual({ text: `Refused (gone): Hub mac no longer has the session that started this one (it was archived or deleted there, or its record of this session is gone), so nothing was sent. No session there waits for this one's answer.`, isError: true })
    expect([sentBy(hub, 'm1.c1'), sentBy(machine, 'c1')]).toEqual([0, 0])
  })

  it('a child start_agent started reaches the session that started it, with nothing recorded by hand', async () => {
    const origin = 'https://github.com/me/app'
    const machine = await machineHost({ mail: true, origin })
    const hub = await hubHost(machine.port, { mail: true, origin })
    await eventually(() => hub.machine().status === 'connected')
    await eventually(() => offered(machine))
    // Work given to another computer waits for the person to trust the project
    await hub.mgr.setProjectTrusted('p-hub', true)
    const call = hub.mgr.startAgent('h1', { task: 'say hello', machine: 'Remote box' })
    await hub.answer('allow')
    const r = await call
    if (!r.ok) throw new Error(r.error)
    const childId = r.sessionId.replace(/^m1\./, '')
    // The machine said at the offer that it takes mail from the hub: the child's task says to mail its parent (#2067 item 2)
    const sent = (JSON.parse(hub.store.settings.appSetting(REMOTE_AGENTS_KEY) ?? '[]') as { sent?: string }[]).map((a) => a.sent ?? '')
    expect(sent).toEqual([expect.stringContaining('call mail with `to: "parent"`')])
    // The machine recorded the hub from the connection the start came in on, and the hub recorded its parent
    expect(startingHub(machine.store.settings, childId)).toEqual({ id: hub.id, name: 'Hub mac', apps: false })
    expect(await send(machine, 'done: hello said', { from: childId })).toEqual({ text: expect.stringMatching(/^Sent \S+ to your parent "h1" on Hub mac\. /) })
    expect(received(hub, childId).map((m) => m.body)).toEqual(['done: hello said'])
    // Git checkouts and a card: room for a loaded machine, as links.test.ts gives its start_agent rig
  }, 60_000 * SLOW)

  it('a send that cites the person is refused with the reason, and nothing reaches the hub', async () => {
    const { machine, hub } = await rig()
    expect(await send(machine, 'the person wants the release today', { cite: true })).toEqual({ text: expect.stringMatching(/^Refused \(field_not_allowed\): cite is checked against this computer's record/), isError: true })
    expect(hub.heard).toEqual([])
    // Without it, the same text goes
    expect(await send(machine, 'the person wants the release today')).toMatchObject({ text: expect.stringMatching(/^Sent /) })
  })

  it('a parent trashed on the hub is said as gone', async () => {
    const { machine, hub } = await rig()
    expect(await send(machine, 'before')).toMatchObject({ text: expect.stringMatching(/^Sent /) })
    await hub.mgr.trash.trashSession('h1')
    expect(await send(machine, 'after')).toEqual({ text: expect.stringMatching(/^Refused \(gone\): Hub mac no longer has the session that started this one/), isError: true })
    expect(hub.heard.map((p) => p.text)).toEqual(['before', 'after'])
  })

  it('a hub from before it is named as the cause while its asks switch is on; while it is off it never offered, and is said as not linked or older', async () => {
    const on = await rig({ asks: true, hub: { mail: 'before' } })
    expect(await send(on.machine, 'hello')).toEqual({
      text: "Refused (older): Hub mac runs an older Centralu, which mail does not reach. Update it there; until then your parent hears from you at your turn's end.",
      isError: true,
    })
    expect(sentBy(on.hub, 'm1.c1')).toBe(0)
    await runCleanups()

    const off = await rig({ hub: { mail: 'before' } })
    expect(await send(off.machine, 'hello')).toEqual({
      text: 'Refused (link_down): Hub mac, which started this session, is not linked to this computer right now (or runs a Centralu from before mail crossed computers), so nothing was sent. Send it again once the link is back.',
      isError: true,
    })
  })

  it('with two hubs linked, goes to the one that started the session, and the other never reads it', async () => {
    const machine = await machineHost({ sessions: ['w1', 'c1', 'c2'], fromHub: ['c1', 'c2'], mail: true })
    const a = await hubHost(machine.port, { name: 'Hub mac', mail: true, children: [child('c1')] })
    const b = await hubHost(machine.port, { name: 'Laptop', mail: true, children: [child('c2')] })
    await eventually(() => offered(machine, 2))
    startedBy(machine, 'c1', a)
    startedBy(machine, 'c2', b)
    expect((await send(machine, 'from c2', { from: 'c2' })).text).toMatch(/ on Laptop\. /)
    expect((await send(machine, 'from c1')).text).toMatch(/ on Hub mac\. /)
    expect(received(a).map((m) => m.body)).toEqual(['from c1'])
    expect(received(b, 'c2').map((m) => m.body)).toEqual(['from c2'])
    expect(a.heard.map((p) => p.text)).toEqual(['from c1'])
    expect(b.heard.map((p) => p.text)).toEqual(['from c2'])
    // The hub that started it being down is said, by its name; the other's link does not stand in for it
    await b.stop()
    await eventually(() => [...(machine.hubs as unknown as { hubs: Map<string, { id: string; client: number | null }> }).hubs.values()].some((h) => h.id === b.id && h.client === null))
    expect(await send(machine, 'from c2 again', { from: 'c2' })).toEqual({ text: expect.stringMatching(/^Refused \(link_down\): Laptop is not reachable right now/), isError: true })
    expect(a.heard.map((p) => p.text)).toEqual(['from c1'])
  })

  it('a session no hub started keeps its own parent rule, and nothing reaches a hub', async () => {
    const { machine, hub } = await rig()
    expect(await send(machine, 'hello', { from: 'w1' })).toEqual({ text: expect.stringMatching(/^Refused \(unknown\): this session was not started by another session/), isError: true })
    expect(sentBy(hub, 'm1.w1')).toBe(0)
  })
})
