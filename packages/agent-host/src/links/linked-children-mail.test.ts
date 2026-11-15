import { afterEach, describe, expect, it } from 'vitest'
import type { CentraluTools } from '../adapters/contract.js'
import { writeHandoffNote } from '../dev-services/handoff-notes.js'
import { sessionAddress } from '../mail/address.js'
import { sendWork } from '../sessions/cross-project.test-helpers.js'
import { REMOTE_AGENTS_KEY } from '../sessions/remote-agents.js'
import { cleanups, runCleanups } from './links-world.test-helpers.js'
import { hubHost, machineHost } from './reverse-link.test-helpers.js'
import { SLOW, eventually } from '../../../../tooling/test-timing.js'

/**
 * Work a hub session gives a session on a linked machine goes as mail (#1948 step 6, docs/plans/mailbox.md §10.6): start_agent's task,
 * agent_session's (and `mail`'s) more work and the Assistant's send_to_session are tasks across the link, which the machine's own delivery gives
 * the session, held while it is busy, and whose end its own engine reports. That report comes back as Centralu's report answering the hub's copy of
 * the task, as a local child's does. Two real hosts in one process (links/reverse-link.test-helpers.ts), each delivering its own mail.
 */

afterEach(runCleanups)

const ORIGIN = 'git@github.com:me/app.git'

/** A machine whose project is a checkout of the hub's, and the hub; `machineMail` false: the machine runs a build that takes no mail (nor tasks) */
async function tasksRig(o: { machineMail?: boolean } = {}) {
  const takesMail = o.machineMail !== false
  const machine = await machineHost({ mail: takesMail, origin: ORIGIN })
  const hub = await hubHost(machine.port, { mail: true, origin: ORIGIN })
  await hub.mgr.setProjectTrusted('p-hub', true)
  await eventually(() => hub.machine().status === 'connected')
  await hub.router.handle('machines.setAsks', { machineId: 'm1', on: true })
  await eventually(() => machine.hubs.any)
  if (takesMail) await eventually(() => machine.hubs.mailHubs()[0]?.you === 'm1' && hub.links.get('m1')?.takesTasks === true)
  for (const host of takesMail ? [machine, hub] : [hub]) {
    host.mail!.delivery.start()
    cleanups.push(() => host.mail!.delivery.stop())
  }
  const at = {
    hub: (id: string) => sessionAddress(hub.id, id),
    machine: (id: string) => sessionAddress(machine.id, id),
  }
  /** Delivers what is due to the machine's session `local` until message `id` is in (the tests' delivery runs no timers of its own) */
  const delivered = (local: string, id: string) =>
    eventually(async () => {
      await machine.mail!.delivery.process(at.machine(local))
      return machine.store.mailbox.recipient(id, at.machine(local))?.deliveredAt != null
    })
  /** start_agent from the hub's h1, the person allowing its card; its task delivered there unless `deliver` is false */
  const start = async (task: string, o: { deliver?: boolean } = {}) => {
    const call = hub.mgr.startAgent('h1', { task, machine: 'Remote box', wait: false })
    await hub.answer('allow')
    const r = await call
    if (!r.ok) throw new Error(r.error)
    const local = r.sessionId.slice('m1.'.length)
    if (o.deliver !== false) await delivered(local, copyOf('h1', r.sessionId)!.id)
    return { r, local }
  }
  /** The hub's copy of the newest task from `caller` to the machine's session `qualified` (`m1.<id>`), settled or not */
  const copyOf = (caller: string, qualified: string) =>
    hub.store.mailbox.feedOf(at.hub(qualified), { limit: 20 }).find((m) => m.kind === 'task' && m.sender === at.hub(caller))
  return { machine, hub, at, start, copyOf, delivered }
}

describe('start_agent on a linked machine gives its task as mail, and its end comes back as a report (#1948 step 6)', { timeout: 30_000 * SLOW }, () => {
  it("writes the task on the machine under the hub's id, and the child's turn end is a report answering the hub's copy, which it settles", async () => {
    const { machine, hub, at, start, copyOf } = await tasksRig()
    const { r, local } = await start('say hello')
    expect(r).toMatchObject({ ok: true, state: 'working', reported: true })
    const copy = copyOf('h1', r.sessionId)!
    expect(copy).toMatchObject({ kind: 'task', origin: 'start_agent' })
    // The machine's task is that one, from the hub's session, to the child there
    const there = machine.store.mailbox.message(copy.id)
    expect(there).toMatchObject({ kind: 'task', origin: 'start_agent', sender: at.hub('h1') })
    expect(there!.body).toContain('say hello')
    // Said for the person only when the hub's Assistant gives it (#2258): h1 is a project's session
    expect(there!.facts.hubAssistant).toBeUndefined()
    expect(machine.store.mailbox.recipient(copy.id, at.machine(local))).toBeTruthy()
    // Its turn ends there (the scripted agent echoes): the report comes back answering the copy, to h1, and settles it
    await eventually(() => hub.store.mailbox.reportsOn(copy.id).length === 1)
    const [report] = hub.store.mailbox.reportsOn(copy.id)
    expect(report).toMatchObject({ kind: 'report', sender: 'centralu', replyTo: copy.id })
    expect(report!.facts.outcome).toBe('finished')
    expect(hub.store.mailbox.recipient(report!.id, at.hub('h1'))).toBeTruthy()
    expect(hub.store.mailbox.recipient(copy.id, at.hub(r.sessionId))).toMatchObject({ settled: 'reported' })
  })

  it("starts right after the link came back by itself: the machine's answer to the new connection's offer is read, never \"still connecting\"", async () => {
    const { machine, hub } = await tasksRig()
    let release = () => {}
    const held = new Promise<void>((resolve) => (release = resolve))
    // The machine's host comes back on the same port; the hub reconnects by itself and offers again, its answer not in yet
    await machine.bounce(held)
    await eventually(() => hub.machine().status === 'connected' && hub.links.get('m1')?.takesTasks === undefined)
    // The answer comes once the start waits for it; a start that read the machine without waiting is answered first
    const link = hub.links.get('m1')!
    const answered = link.offerAnswered.bind(link)
    const waits = new Promise<'waits'>((resolve) => (link.offerAnswered = (...a) => (resolve('waits'), answered(...a))))
    const starting = hub.mgr.startAgent('h1', { task: 'say hello', machine: 'Remote box', wait: false })
    expect(await Promise.race([waits, starting])).toBe('waits')
    release()
    await hub.answer('allow')
    expect(await starting).toMatchObject({ ok: true, state: 'working' })
  })

  it("answers a start that waits with the child's answer, and marks the report read so it does not wake the caller again", async () => {
    const { hub, at, copyOf, delivered } = await tasksRig()
    const call = hub.mgr.startAgent('h1', { task: 'say hello', machine: 'Remote box' })
    await hub.answer('allow')
    // The child is made there and its task written before the call waits on its report
    await eventually(() => hub.store.mailbox.feedOf(at.hub('h1'), { limit: 5 }).some((m) => m.kind === 'task'))
    const copy = hub.store.mailbox.feedOf(at.hub('h1'), { limit: 5 }).find((m) => m.kind === 'task')!
    const child = hub.store.mailbox.recipients(copy.id)[0]!.recipient.split('/m1.')[1]!
    await delivered(child, copy.id)
    const r = await call
    expect(r).toMatchObject({ ok: true, state: 'done', answer: expect.stringContaining('echo:') })
    expect(copyOf('h1', r.ok ? r.sessionId : '')?.id).toBe(copy.id)
    const [report] = hub.store.mailbox.reportsOn(copy.id)
    expect(hub.store.mailbox.recipient(report!.id, at.hub('h1'))).toMatchObject({ readAt: expect.any(Number) })
  })

  it('refuses a start on a machine that takes no tasks, before any card, in words that say to update it, and makes nothing there', async () => {
    const { machine, hub } = await tasksRig({ machineMail: false })
    const before = machine.mgr.listSessions().map((s) => s.id)
    const r = await hub.mgr.startAgent('h1', { task: 'say hello', machine: 'Remote box', wait: false })
    expect(r).toEqual({ ok: false, error: 'Remote box runs an older Centralu, which takes no work from this computer. Update Centralu on Remote box, or start the session here.' })
    expect(hub.card()).toBeFalsy()
    expect(machine.mgr.listSessions().map((s) => s.id)).toEqual(before)
  })
})

describe('more work for a child on a linked machine (#1948 step 6)', { timeout: 30_000 * SLOW }, () => {
  it('is held on the machine while the child is busy, given once it is free, and reported back', async () => {
    const { machine, hub, at, start, copyOf, delivered } = await tasksRig()
    const { r, local } = await start('say hello')
    const first = copyOf('h1', r.sessionId)!
    await eventually(() => hub.store.mailbox.reportsOn(first.id).length === 1)
    // The person works in it there: a turn that waits on their approval
    await machine.mgr.inputs.send(local, 'please approve my command')
    await eventually(() => machine.mgr.listSessions().find((s) => s.id === local)?.state === 'waiting_approval')
    expect(await sendWork(hub.mgr, 'h1', r.sessionId, 'and one more thing')).toMatchObject({ ok: true, state: 'working', reported: true })
    const more = copyOf('h1', r.sessionId)!
    expect(more.id).not.toBe(first.id)
    expect(machine.store.mailbox.message(more.id)).toMatchObject({ kind: 'task', origin: 'agent_session' })
    // Held while the person's turn waits there
    await machine.mail!.delivery.process(at.machine(local))
    expect(machine.store.mailbox.recipient(more.id, at.machine(local))).toMatchObject({ deliveredAt: null })
    const card = machine.mgr.listSessions().find((s) => s.id === local)!.pendingApproval!
    machine.mgr.inputs.respondApproval(local, card.requestId, 'allow')
    await delivered(local, more.id)
    await eventually(() => hub.store.mailbox.reportsOn(more.id).length === 1)
    expect(hub.store.mailbox.recipient(more.id, at.hub(r.sessionId))).toMatchObject({ settled: 'reported' })
  })

  it("goes to the session that took over by a handoff while the child's turn ran: the heir gets the report", async () => {
    const { machine, hub, at, start, copyOf } = await tasksRig()
    // Its turn waits on the person's approval there, so it is still running at the handoff
    const { r, local } = await start('please approve my command')
    const copy = copyOf('h1', r.sessionId)!
    await eventually(() => machine.mgr.listSessions().find((s) => s.id === local)?.state === 'waiting_approval')
    await writeHandoffNote('p-hub', 'h1', 'NOTE BODY: where things stand')
    const heir = (await hub.mgr.createSession({
      projectId: 'p-hub', cwd: hub.store.projects.listProjects()[0]!.path, tool: 'claude', permissionPreset: 'normal',
      initialPrompt: 'You are taking over. Read the note.',
      handoff: { from: 'h1', note: 'NOTE BODY: where things stand', fromSessionId: 'h1' },
    })).id
    // The child is the heir's, and so is the task it is working on, here and on the machine
    expect((JSON.parse(hub.store.settings.appSetting(REMOTE_AGENTS_KEY) ?? '[]') as { callerId: string }[])[0]?.callerId).toBe(heir)
    expect(hub.store.mailbox.message(copy.id)?.sender).toBe(at.hub(heir))
    await eventually(() => machine.store.mailbox.message(copy.id)?.sender === at.hub(heir))
    const card = machine.mgr.listSessions().find((s) => s.id === local)!.pendingApproval!
    machine.mgr.inputs.respondApproval(local, card.requestId, 'allow')
    await eventually(() => hub.store.mailbox.reportsOn(copy.id).length === 1)
    const [report] = hub.store.mailbox.reportsOn(copy.id)
    expect(hub.store.mailbox.recipient(report!.id, at.hub(heir))).toBeTruthy()
    expect(hub.store.mailbox.recipient(report!.id, at.hub('h1'))).toBeUndefined()
  })
})

describe("the Assistant's send_to_session to a session on a linked machine (#1948 step 6)", { timeout: 30_000 * SLOW }, () => {
  it("arrives there as a task the hub says is the Assistant's, for the person, and its end comes back as a report", async () => {
    const { machine, hub, at, delivered } = await tasksRig()
    const orc = await hub.mgr.assistant()
    const tools = (hub.mgr as unknown as { centraluToolsFor(id: string): CentraluTools }).centraluToolsFor(orc.id)
    expect(await tools.sendToSession('m1.w1', 'look at the logs', true)).toEqual({ ok: true })
    const copy = hub.store.mailbox.feedOf(at.hub('m1.w1'), { limit: 5 }).find((m) => m.kind === 'task')!
    expect(copy).toMatchObject({ sender: at.hub(orc.id), origin: 'send_to_session' })
    expect(machine.store.mailbox.message(copy.id)).toMatchObject({ kind: 'task', origin: 'send_to_session', facts: { hubAssistant: true } })
    await delivered('w1', copy.id)
    await eventually(() => hub.store.mailbox.reportsOn(copy.id).length === 1)
    // Without reportBack it is a note: a message that asks for nothing back
    expect(await tools.sendToSession('m1.w1', 'fyi: the logs rotated', false)).toEqual({ ok: true })
    const note = hub.store.mailbox.feedOf(at.hub('m1.w1'), { limit: 5 }).find((m) => m.body === 'fyi: the logs rotated')!
    expect(machine.store.mailbox.message(note.id)).toMatchObject({ kind: 'message', origin: 'send_to_session', facts: { hubAssistant: true } })
  })
})
