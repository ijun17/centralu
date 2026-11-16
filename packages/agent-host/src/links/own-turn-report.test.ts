import { afterEach, describe, expect, it, vi } from 'vitest'
import { OWN_WORK_SETTLE_MS } from '../sessions/child-ownership.js'
import { sessionAddress } from '../mail/address.js'
import { cleanups, runCleanups } from './links-world.test-helpers.js'
import { hubHost, machineHost } from './reverse-link.test-helpers.js'
import { SLOW, eventually } from '../../../../tooling/test-timing.js'

/**
 * A task that reaches a session as a background task's notification waits there (#2318). Measured with Claude Code 2.1.296: the CLI runs its own turn
 * for the notification first, a turn that names no input, then the task's. That first end is not the task's: the task's own turn's end is its one
 * report. Real hosts in one process, the agent scripted as Claude Code runs (`ownTurns`).
 */

afterEach(async () => {
  vi.restoreAllMocks()
  await runCleanups()
})

const ORIGIN = 'git@github.com:me/app.git'
const running = (host: { mgr: { listSessions(): { id: string; state: string }[] } }, id: string) => host.mgr.listSessions().find((s) => s.id === id)?.state

describe("a task that comes with a background task's notification (#2318)", { timeout: 30_000 * SLOW }, () => {
  it("is reported to the hub session at its own turn's end, once, not at the notification turn's", async () => {
    const machine = await machineHost({ mail: true, origin: ORIGIN, ownTurns: true })
    const hub = await hubHost(machine.port, { mail: true, origin: ORIGIN })
    await hub.mgr.setProjectTrusted('p-hub', true)
    await eventually(() => hub.machine().status === 'connected')
    await hub.router.handle('machines.setAsks', { machineId: 'm1', on: true })
    await eventually(() => machine.hubs.mailHubs()[0]?.you === 'm1' && hub.links.get('m1')?.takesTasks === true)
    for (const host of [machine, hub]) {
      host.mail!.delivery.start()
      cleanups.push(() => host.mail!.delivery.stop())
    }
    const atHub = (id: string) => sessionAddress(hub.id, id)
    const atMachine = (id: string) => sessionAddress(machine.id, id)
    const call = hub.mgr.startAgent('h1', { task: 'say hello', machine: 'Remote box', wait: false })
    await hub.answer('allow')
    const started = await call
    if (!started.ok) throw new Error(started.error)
    const local = started.sessionId.slice('m1.'.length)
    const tasks = () => hub.store.mailbox.feedOf(atHub(started.sessionId), { limit: 20 }).filter((m) => m.kind === 'task' && m.sender === atHub('h1'))
    // The first task's turn ends there: reported, and the session is at rest
    await eventually(async () => {
      await machine.mail!.delivery.process(atMachine(local))
      return hub.store.mailbox.reportsOn(tasks()[0]!.id).length === 1
    })

    // A background task of its ended meanwhile; the next task goes in with its notification waiting
    machine.agent().notifyNext(local)
    const sent = await hub.mail!.across.sendTask('h1', atHub(started.sessionId), 'a long job', { origin: 'agent_session' })
    if (!sent.ok) throw new Error(sent.text)
    await eventually(async () => {
      await machine.mail!.delivery.process(atMachine(local))
      return machine.agent().ran.get(local)?.some((t) => t.includes('a long job')) === true
    })
    // The notification's turn ended first: no end of the task, which its own turn runs
    expect(running(machine, local)).toBe('working')
    expect(machine.store.mailbox.recipient(sent.messageId, atMachine(local))?.settled).toBeNull()

    machine.agent().finish(local, 'all done')
    await eventually(() => hub.store.mailbox.reportsOn(sent.messageId).length === 1)
    expect(hub.store.mailbox.reportsOn(sent.messageId)[0]!.facts).toMatchObject({ outcome: 'finished', answer: 'working on it…all done' })
    expect(machine.store.mailbox.reportsOn(sent.messageId)).toHaveLength(1)
  })

  it('is answered on one machine by its own turn, not the notification turn: a local task', async () => {
    const machine = await machineHost({ mail: true, sessions: ['w1', 'w2'], ownTurns: true })
    machine.mail!.delivery.start()
    cleanups.push(() => machine.mail!.delivery.stop())
    const at = (id: string) => sessionAddress(machine.id, id)
    // w2 ran a turn (its process is up) and is at rest
    await machine.mgr.inputs.send('w2', 'hello')
    await eventually(() => running(machine, 'w2') === 'waiting_input')
    machine.agent().notifyNext('w2')
    const task = machine.mail!.service.task(at('w1'), at('w2'), { text: 'a long job', origin: 'agent_session', delivered: false })
    await eventually(async () => {
      await machine.mail!.delivery.process(at('w2'))
      return machine.agent().ran.get('w2')?.some((t) => t.includes('a long job')) === true
    })
    expect(running(machine, 'w2')).toBe('working')
    expect(machine.store.mailbox.reportsOn(task.id)).toEqual([])
    machine.agent().finish('w2', 'all done')
    await eventually(() => machine.store.mailbox.reportsOn(task.id).length === 1)
    expect(machine.store.mailbox.reportsOn(task.id)[0]!.facts).toMatchObject({ outcome: 'finished', answer: 'working on it…all done' })
  })

  it('is answered once the session settles at rest when its tool never runs the input: no report is lost for good', async () => {
    const machine = await machineHost({ mail: true, sessions: ['w1', 'w2'], ownTurns: true })
    const at = (id: string) => sessionAddress(machine.id, id)
    await machine.mgr.inputs.send('w2', 'hello')
    await eventually(() => running(machine, 'w2') === 'waiting_input')
    machine.agent().notifyNext('w2', 'drop')
    const task = machine.mail!.service.task(at('w1'), at('w2'), { text: 'a long job', origin: 'agent_session', delivered: false })
    // The settle's bound, and only it, is short here: the rest runs on real time
    const realTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => realTimeout(fn, ms === OWN_WORK_SETTLE_MS ? 500 : ms)) as typeof setTimeout)
    machine.mail!.delivery.start()
    cleanups.push(() => machine.mail!.delivery.stop())
    // Its own turn ended and the input waits for good: nothing answered then
    await eventually(async () => {
      await machine.mail!.delivery.process(at('w2'))
      return machine.agent().ran.get('w2')?.some((t) => t.includes('a long job')) === true
    })
    expect(machine.store.mailbox.recipient(task.id, at('w2'))?.deliveredAt).not.toBeNull()
    expect(machine.store.mailbox.reportsOn(task.id)).toEqual([])
    await eventually(() => machine.store.mailbox.reportsOn(task.id).length === 1)
  })

  it('is released once, as a stop, when the process goes before the waiting input ran', async () => {
    const machine = await machineHost({ mail: true, sessions: ['w1', 'w2'], ownTurns: true })
    const at = (id: string) => sessionAddress(machine.id, id)
    await machine.mgr.inputs.send('w2', 'hello')
    await eventually(() => running(machine, 'w2') === 'waiting_input')
    machine.agent().notifyNext('w2', 'drop')
    const task = machine.mail!.service.task(at('w1'), at('w2'), { text: 'a long job', origin: 'agent_session', delivered: false })
    machine.mail!.delivery.start()
    cleanups.push(() => machine.mail!.delivery.stop())
    await eventually(async () => {
      await machine.mail!.delivery.process(at('w2'))
      return machine.agent().ran.get('w2')?.some((t) => t.includes('a long job')) === true
    })
    expect(machine.store.mailbox.recipient(task.id, at('w2'))?.releasedAt ?? null).toBeNull()
    machine.mgr.events.onEvent({ type: 'error', sessionId: 'w2', error: { code: 'adapter_crashed', message: 'the process exited', retryable: true } })
    await eventually(() => (machine.store.mailbox.recipient(task.id, at('w2'))?.releasedAt ?? null) !== null)
    expect(machine.store.mailbox.reportsOn(task.id)).toEqual([])
  })
})
