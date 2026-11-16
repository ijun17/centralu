import { afterEach, describe, expect, it } from 'vitest'
import { sessionAddress } from '../mail/address.js'
import { cleanups, runCleanups } from './links-world.test-helpers.js'
import { hubHost, machineHost } from './reverse-link.test-helpers.js'
import { SLOW, eventually } from '../../../../tooling/test-timing.js'

/**
 * A hub session's child on a linked machine whose turn an update of that machine cut and Centralu continued (#1618, #2312): the continued turn is
 * the one the hub session waits on, and its end comes back as exactly one report on the hub's task. The cut sends none: the continued turn's end
 * is the report (#1966). Two real hosts in one process; the machine's host is swapped as an update swaps it (`swapForUpdate`)
 */

afterEach(runCleanups)

const ORIGIN = 'git@github.com:me/app.git'

async function rig() {
  const machine = await machineHost({ mail: true, origin: ORIGIN })
  const hub = await hubHost(machine.port, { mail: true, origin: ORIGIN })
  await hub.mgr.setProjectTrusted('p-hub', true)
  await eventually(() => hub.machine().status === 'connected')
  await hub.router.handle('machines.setAsks', { machineId: 'm1', on: true })
  await eventually(() => machine.hubs.mailHubs()[0]?.you === 'm1' && hub.links.get('m1')?.takesTasks === true)
  const deliver = (host: { mail: { delivery: { start(): void; stop(): void } } | null }) => {
    host.mail!.delivery.start()
    cleanups.push(() => host.mail!.delivery.stop())
  }
  deliver(machine)
  deliver(hub)
  const at = { hub: (id: string) => sessionAddress(hub.id, id), machine: (id: string) => sessionAddress(machine.id, id) }
  return { machine, hub, at, deliver }
}

describe("a linked child's turn an update continued (#2312)", { timeout: 30_000 * SLOW }, () => {
  it('reports its real end to the hub session that started it, once', async () => {
    const { machine, hub, at, deliver } = await rig()
    const call = hub.mgr.startAgent('h1', { task: 'a long job', machine: 'Remote box', wait: false })
    await hub.answer('allow')
    const started = await call
    if (!started.ok) throw new Error(started.error)
    const local = started.sessionId.slice('m1.'.length)
    const task = hub.store.mailbox.feedOf(at.hub(started.sessionId), { limit: 20 }).find((m) => m.kind === 'task' && m.sender === at.hub('h1'))!
    await eventually(async () => {
      await machine.mail!.delivery.process(at.machine(local))
      return machine.mgr.listSessions().find((s) => s.id === local)?.state === 'working'
    })
    const reports = () => hub.store.mailbox.reportsOn(task.id)
    // It waits on CI in a background task of its turn, which the stop ends: then Claude Code's resumed process ends a turn of its own first
    machine.mgr.events.onEvent({ type: 'background_tasks', sessionId: local, live: [{ id: 't1', kind: 'shell', description: 'gh pr checks --watch', status: 'running' }] })
    await eventually(() => machine.mgr.listSessions().find((s) => s.id === local)?.backgroundTasks.some((t) => t.status === 'running') === true)

    // The hub updates the machine mid-turn: its host stops for the update and the next one continues the turn
    await machine.swapForUpdate()
    deliver(machine)
    await eventually(() => hub.machine().status === 'connected')
    // The next host resumes it with the Continue, which names the stopped task; the resumed process first ends a turn of its own, then runs the Continue's (Claude Code)
    await eventually(() => machine.agent().ran.get(local)?.some((t) => t.includes('Continue where you stopped') && t.includes('gh pr checks --watch')) === true)
    // That end is no end of the work, nor is the cut: the session is in its turn, and nothing answered the task there
    expect(machine.mgr.listSessions().find((s) => s.id === local)?.state).toBe('working')
    expect(machine.store.mailbox.recipient(task.id, at.machine(local))?.settled).toBeNull()

    machine.agent().finish(local, 'all done')
    await eventually(() => reports().length === 1)
    // The continued turn's words (the scripted agent says both in that one turn), never the cut turn's alone
    expect(reports()[0]!.facts).toMatchObject({ outcome: 'finished', answer: 'working on it…all done' })
    expect(hub.store.mailbox.recipient(task.id, at.hub(started.sessionId))?.settled).toBe('reported')
    // Once: the machine wrote the one report, which settled its task
    expect(machine.store.mailbox.reportsOn(task.id)).toHaveLength(1)
    expect(machine.store.mailbox.recipient(task.id, at.machine(local))?.settled).toBe('reported')
  })
})
