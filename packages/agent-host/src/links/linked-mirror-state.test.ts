import { afterEach, describe, expect, it } from 'vitest'
import { runCleanups } from './links-world.test-helpers.js'
import { hubHost, machineHost } from './reverse-link.test-helpers.js'
import { sessionAddress } from '../mail/address.js'
import { isObj } from '../json-value.js'
import { eventually } from '../../../../tooling/test-timing.js'

/**
 * The hub's copy of a linked machine's sessions (its headers mirror) follows every event that moves a session's state, by the
 * shared state rule (#2288): a turn's end, a card and its answer, not `state_change` alone. Its readers (the person's Inbox,
 * the mail directory, the agents' lists while the machine is away) read what the machine's own window shows.
 */

afterEach(runCleanups)

async function rig() {
  const machine = await machineHost()
  const hub = await hubHost(machine.port, { mail: true })
  await eventually(() => hub.machine().status === 'connected')
  // The window's list fills the mirror, as the hub's window does when it opens
  await hub.router.handle('sessions.list', {})
  const row = () => {
    const s = (hub.links.get('m1')!.lastKnown('sessions') ?? []).find((x) => isObj(x) && x.id === 'w1')
    return isObj(s) ? s : undefined
  }
  const inbox = () => hub.mail!.across.foreignState(sessionAddress(hub.id, 'm1.w1'))
  const there = () => machine.mgr.listSessions().find((s) => s.id === 'w1')!
  return { machine, hub, row, inbox, there }
}

describe("the hub's copy of a linked machine's session state (#2288)", () => {
  it('says the turn ended once it ended there, and the card while it stood: the Inbox reads the same', async () => {
    const { machine, row, inbox, there } = await rig()
    expect(row()).toMatchObject({ state: 'idle' })
    await machine.mgr.inputs.send('w1', 'please approve my command')
    await eventually(() => there().state === 'waiting_approval')
    const card = there().pendingApproval!
    // The card's request moves the state, with no state_change of its own
    await eventually(() => row()?.state === 'waiting_approval')
    expect(row()).toMatchObject({ pendingApproval: { requestId: card.requestId }, waitingSince: expect.any(Number) })
    expect(inbox()).toBe('waiting_approval')
    machine.mgr.inputs.respondApproval('w1', card.requestId, 'allow')
    await eventually(() => there().state === 'waiting_input')
    // The turn's end (turn_complete), not a state_change: the copy is at rest as the machine is, the card gone with it
    await eventually(() => row()?.state === 'waiting_input')
    expect(row()).toMatchObject({ pendingApproval: null, pendingQuestions: [], activity: null })
    expect(inbox()).toBe('waiting_input')
  })

  it('follows an activity too, as the rule writes it', async () => {
    const { machine, row } = await rig()
    await machine.mgr.inputs.send('w1', 'a long job')
    await eventually(() => row()?.state === 'working')
    machine.mgr.events.onEvent({ type: 'activity', sessionId: 'w1', activity: 'compacting' })
    await eventually(() => row()?.activity === 'compacting')
  })

  it("keeps a turn that ended while the connect's lists were still being read (#2288 review)", async () => {
    const machine = await machineHost()
    let release = () => {}
    machine.holdMethod('projects.list', new Promise<void>((r) => (release = r)))
    const hub = await hubHost(machine.port, { mail: true })
    const row = () => {
      const s = (hub.links.get('m1')!.lastKnown('sessions') ?? []).find((x) => isObj(x) && x.id === 'w1')
      return isObj(s) ? s : undefined
    }
    // The sessions list is written on its own answer, while the projects list is still held
    await eventually(() => row()?.state === 'idle')
    await machine.mgr.inputs.send('w1', 'hello')
    await eventually(() => row()?.state === 'waiting_input')
    release()
    await eventually(() => hub.machine().status === 'connected')
    expect(row()).toMatchObject({ state: 'waiting_input' })
  })

  it('keeps the rest of the row: only the state facts are written', async () => {
    const { machine, row } = await rig()
    const before = row()!
    await machine.mgr.inputs.send('w1', 'hello')
    await eventually(() => row()?.state === 'waiting_input')
    expect(row()).toMatchObject({ id: 'w1', name: before.name, projectId: before.projectId, createdAt: before.createdAt })
  })
})
