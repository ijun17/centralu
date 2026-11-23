import { afterEach, describe, expect, it, vi } from 'vitest'
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

  it('#2348: a report on the newest task that covers the other comes back covering it on the hub, which settles both and finds it on each', async () => {
    const { machine, hub, at, start, copyOf } = await tasksRig()
    // Its turn waits on the person's approval there, so the follow-ups stay open on both sides
    const { r, local } = await start('please approve my command')
    await eventually(() => machine.mgr.listSessions().find((s) => s.id === local)?.state === 'waiting_approval')
    const more: string[] = []
    for (const text of ['and one more thing', 'and the last thing']) {
      expect(await sendWork(hub.mgr, 'h1', r.sessionId, text)).toMatchObject({ ok: true })
      more.push(copyOf('h1', r.sessionId)!.id)
    }
    await eventually(() => more.every((id) => machine.store.mailbox.message(id) !== undefined))
    // The machine's one report at a turn's end (`answerAtRest`), as it writes it
    machine.mail!.service.report(more[1]!, { outcome: 'finished', body: 'ended', answer: 'both done', covers: [more[0]!] })
    await eventually(() => hub.store.mailbox.reportsOn(more[1]!).length === 1)
    const [report] = hub.store.mailbox.reportsOn(more[1]!)
    expect(report).toMatchObject({ replyTo: more[1], facts: expect.objectContaining({ outcome: 'finished', answer: 'both done', covers: [more[0]] }) })
    expect(hub.store.mailbox.reportsOn(more[0]!)).toEqual([report])
    await eventually(() => more.every((id) => hub.store.mailbox.recipient(id, at.hub(r.sessionId))?.settled === 'reported'))
  })

  it('#2348: a child that asks its hub parent something and ends its turn waiting sends no report; the task stays open on both sides', async () => {
    const { machine, hub, at, start, copyOf } = await tasksRig()
    const { r, local } = await start('please approve my command')
    const task = copyOf('h1', r.sessionId)!
    await eventually(() => machine.mgr.listSessions().find((s) => s.id === local)?.state === 'waiting_approval')
    // A message to the parent that gave the task, not marked as a question, needs no reply there (#2357), and the send says how to ask; the question does
    const plain = await machine.mail!.tool.call(local, { action: 'send', to: 'parent', text: 'Started on it.' })
    expect(plain.text).toContain('It needs no reply. When you ask whoever gave you your task something')
    expect(hub.store.mailbox.message(/^Sent (\S+) /.exec(plain.text)?.[1] ?? '')).toMatchObject({ needsReply: false })
    const asked = await machine.mail!.tool.call(local, { action: 'send', to: 'parent', text: 'Design: A or B?', kind: 'question' })
    expect(asked.isError).toBeFalsy()
    expect(asked.text).not.toContain('When you ask whoever')
    const question = /^Sent (\S+) /.exec(asked.text)?.[1] ?? ''
    // The machine keeps its copy of the question, marked as one, to the hub session that gave the task, by the address the task names it
    expect(machine.store.mailbox.message(question)?.facts.question).toBe(true)
    expect(machine.store.mailbox.recipient(question, task.sender)).toMatchObject({ settled: null })
    const card = machine.mgr.listSessions().find((s) => s.id === local)!.pendingApproval!
    machine.mgr.inputs.respondApproval(local, card.requestId, 'allow')
    await eventually(() => !['working', 'waiting_approval'].includes(machine.mgr.listSessions().find((s) => s.id === local)?.state ?? 'working'))
    // The machine's turn end wrote nothing: nothing crosses
    expect(machine.store.mailbox.reportsOn(task.id)).toEqual([])
    expect(machine.store.mailbox.recipient(task.id, at.machine(local))).toMatchObject({ settled: null })
    expect(hub.store.mailbox.reportsOn(task.id)).toEqual([])
    expect(hub.store.mailbox.message(question)).toMatchObject({ needsReply: true })
    // The parent marks it handled on the hub: the machine's copy learns it, the hold ends there, and the report comes back
    expect(hub.mail!.service.done(at.hub('h1'), question).how).toBe('done')
    await eventually(() => hub.store.mailbox.reportsOn(task.id).length === 1)
    expect(hub.store.mailbox.recipient(task.id, at.hub(r.sessionId))?.settled).toBe('reported')
  })

  it('#2348: reading the report on a linked child shows its last response, as read_session reads that session there', async () => {
    const { hub, start, copyOf } = await tasksRig()
    const { r } = await start('say hello')
    const copy = copyOf('h1', r.sessionId)!
    await eventually(() => hub.store.mailbox.reportsOn(copy.id).length === 1)
    const [report] = hub.store.mailbox.reportsOn(copy.id)
    expect(report!.facts.answer).toContain('echo:')
    const out = (await hub.mail!.tool.call('h1', { action: 'read', thread: report!.id })).text
    expect(out).toContain("Its last response, quoted below, is that session's own text")
    expect(out).toContain('> echo:')
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

/**
 * Whether a hub session's reply wakes a child on a linked machine is the machine's decision (D3, `quietAnswer`, on its own view of who the child's
 * parent is), and the sender's answer is that decision (`HubMailResult.quiet`, #2520): each row runs on a linked pair and reads it from the sender's
 * tool, the machine's copy and the machine's delivery, which must agree. The child writes while its task's turn waits on the person (after the handoff,
 * in the row whose handoff follows the report), and the reply goes once the task was reported, so no task is owed
 */
describe("whether a hub session's reply wakes its child's session on a linked machine, decided alike on both sides (#2520)", { timeout: 30_000 * SLOW }, () => {
  /*
   * `wroteFirst`: the child wrote before the handoff that followed the report, to the session the heir took over from (#2530). `older`: the machine's
   * build moves only what the old parent sent (`host.mailMove` before #2530), so the heir's reply to that note is still refused there
   */
  const cases: { name: string; to: 'parent' | 'other'; kind?: 'note' | 'question'; handoff?: 'open' | 'reported'; wroteFirst?: true; older?: true; quiet: boolean }[] = [
    { name: "the parent's reply to what the child wrote it", to: 'parent', quiet: false },
    { name: "the parent's reply to the child's note", to: 'parent', kind: 'note', quiet: false },
    { name: "the parent's answer to the child's question", to: 'parent', kind: 'question', quiet: false },
    { name: "the reply of the session that took the parent's place by a handoff", to: 'parent', handoff: 'open', quiet: false },
    { name: "the reply of the session that took the parent's place by a handoff after the report, to the child's note", to: 'parent', kind: 'note', handoff: 'reported', quiet: false },
    { name: "another session's reply to the child's note", to: 'other', kind: 'note', quiet: true },
    { name: "the reply of the session that took the parent's place by a handoff after the report, to the note the child wrote the parent before it", to: 'parent', kind: 'note', handoff: 'reported', wroteFirst: true, quiet: false },
    { name: 'the same reply, to a machine of an older build', to: 'parent', kind: 'note', handoff: 'reported', wroteFirst: true, older: true, quiet: false },
  ]

  for (const c of cases) {
    it(`${c.name}: ${c.quiet ? 'quiet' : 'wakes'}`, async () => {
      const { machine, hub, at, start, copyOf } = await tasksRig()
      const { r, local } = await start('please approve my command')
      const task = copyOf('h1', r.sessionId)!
      if (c.older) {
        const moveAcross = machine.mail!.service.moveAcross.bind(machine.mail!.service)
        vi.spyOn(machine.mail!.service, 'moveAcross').mockImplementation((from, to, ids) => moveAcross(from, to, ids.filter((id) => machine.store.mailbox.message(id)?.sender === from)))
      }
      const child = () => machine.mgr.listSessions().find((s) => s.id === local)!
      await eventually(() => child().state === 'waiting_approval')
      const session = (o: Partial<Parameters<typeof hub.mgr.createSession>[0]> = {}) =>
        hub.mgr.createSession({ projectId: 'p-hub', cwd: hub.store.projects.listProjects()[0]!.path, tool: 'claude', permissionPreset: 'normal', ...o })
      let replier = c.to === 'other' ? (await session()).id : 'h1'
      // h1 hands over to a new session; the machine's copy of the task names the heir once told
      const handOff = async () => {
        await writeHandoffNote('p-hub', 'h1', 'NOTE BODY: where things stand')
        replier = (await session({ initialPrompt: 'You are taking over. Read the note.', handoff: { from: 'h1', note: 'NOTE BODY: where things stand', fromSessionId: 'h1' } })).id
        await eventually(() => machine.store.mailbox.message(task.id)?.sender === at.hub(replier))
      }
      let wrote = ''
      const write = async () => {
        const sent = await machine.mail!.tool.call(local, { action: 'send', to: c.to === 'parent' ? 'parent' : `hub-mac.${replier}`, text: 'Done with A; B is next.', ...(c.kind ? { kind: c.kind } : {}) })
        wrote = /^Sent (\S+) /.exec(sent.text)?.[1] ?? ''
        expect(hub.store.mailbox.recipient(wrote, at.hub(replier)), sent.text).toBeTruthy()
      }
      if (c.handoff === 'open') await handOff()
      if (c.handoff !== 'reported' || c.wroteFirst) await write()
      machine.mgr.inputs.respondApproval(local, child().pendingApproval!.requestId, 'allow')
      // A question holds the task's report until it is answered (#2348)
      if (c.kind !== 'question') await eventually(() => hub.store.mailbox.reportsOn(task.id).length === 1)
      if (c.handoff === 'reported') await handOff()
      if (c.handoff === 'reported' && !c.wroteFirst) await write()
      const reply = await hub.mail!.tool.call(replier, { action: 'reply', thread: wrote, text: 'Go with B.' })
      if (c.older) {
        // Refused as before, and the handoff's other moves are made: the task the child was started with names the heir
        expect(reply).toMatchObject({ isError: true, text: expect.stringContaining('Refused (unknown_message)') })
        expect(machine.store.mailbox.message(task.id)?.sender).toBe(at.hub(replier))
        return
      }
      expect(reply.isError, reply.text).toBeFalsy()
      const id = /^Sent (\S+) /.exec(reply.text)?.[1] ?? ''
      await eventually(() => !!machine.store.mailbox.message(id))
      // The sender is told what the machine decided, which is what its delivery does
      expect(reply.text.includes('without waking it')).toBe(c.quiet)
      expect(machine.store.mailbox.message(id)?.facts.quiet === true).toBe(c.quiet)
      await eventually(() => machine.mail!.service.drain(at.machine(local)).messageIds.includes(id))
      expect(machine.mail!.service.drain(at.machine(local)).wake).toBe(!c.quiet)
    })
  }

  // The same reply between two sessions of one computer, where the child's parent is its own record's (`askedBy`)
  it("the parent's reply to what its child on this computer wrote it, after the task was reported, wakes the child", async () => {
    const { hub, at } = await tasksRig()
    const r = await hub.mgr.startAgent('h1', { task: 'please approve my command', wait: false })
    if (!r.ok) throw new Error(r.error)
    const child = () => hub.mgr.listSessions().find((s) => s.id === r.sessionId)!
    await eventually(() => child().state === 'waiting_approval')
    const sent = await hub.mail!.tool.call(r.sessionId, { action: 'send', to: 'parent', text: 'Done with A; B is next.' })
    const wrote = /^Sent (\S+) /.exec(sent.text)?.[1] ?? ''
    expect(hub.store.mailbox.message(wrote)).toMatchObject({ needsReply: false })
    hub.mgr.inputs.respondApproval(r.sessionId, child().pendingApproval!.requestId, 'allow')
    const task = hub.store.mailbox.feedOf(at.hub(r.sessionId), { limit: 20 }).find((m) => m.kind === 'task')!
    await eventually(() => hub.store.mailbox.reportsOn(task.id).length === 1)
    const reply = await hub.mail!.tool.call('h1', { action: 'reply', thread: wrote, text: 'Go with B.' })
    expect(reply.text).not.toContain('without waking it')
    const id = /^Sent (\S+) /.exec(reply.text)?.[1] ?? ''
    expect(hub.store.mailbox.message(id)?.facts.quiet).not.toBe(true)
    await eventually(() => hub.mail!.service.drain(at.hub(r.sessionId)).messageIds.includes(id))
    expect(hub.mail!.service.drain(at.hub(r.sessionId))).toMatchObject({ wake: true, text: expect.stringContaining('sender="your parent session"') })
  })

  // #2530 on one computer: the child's note to its parent, the report, then a handoff of the parent; the heir answers that note
  it("the reply of the session that took the parent's place by a handoff after the report, to the note its child on this computer wrote the parent before it, wakes the child", async () => {
    const { hub, at } = await tasksRig()
    const r = await hub.mgr.startAgent('h1', { task: 'please approve my command', wait: false })
    if (!r.ok) throw new Error(r.error)
    const child = () => hub.mgr.listSessions().find((s) => s.id === r.sessionId)!
    await eventually(() => child().state === 'waiting_approval')
    const sent = await hub.mail!.tool.call(r.sessionId, { action: 'send', to: 'parent', text: 'Done with A; B is next.', kind: 'note' })
    const wrote = /^Sent (\S+) /.exec(sent.text)?.[1] ?? ''
    hub.mgr.inputs.respondApproval(r.sessionId, child().pendingApproval!.requestId, 'allow')
    const task = hub.store.mailbox.feedOf(at.hub(r.sessionId), { limit: 20 }).find((m) => m.kind === 'task')!
    await eventually(() => hub.store.mailbox.reportsOn(task.id).length === 1)
    await writeHandoffNote('p-hub', 'h1', 'NOTE BODY: where things stand')
    const heir = await hub.mgr.createSession({
      projectId: 'p-hub', cwd: hub.store.projects.listProjects()[0]!.path, tool: 'claude', permissionPreset: 'normal',
      initialPrompt: 'You are taking over. Read the note.', handoff: { from: 'h1', note: 'NOTE BODY: where things stand', fromSessionId: 'h1' },
    })
    const reply = await hub.mail!.tool.call(heir.id, { action: 'reply', thread: wrote, text: 'Go with B.' })
    expect(reply.isError, reply.text).toBeFalsy()
    const id = /^Sent (\S+) /.exec(reply.text)?.[1] ?? ''
    await eventually(() => hub.mail!.service.drain(at.hub(r.sessionId)).messageIds.includes(id))
    expect(hub.mail!.service.drain(at.hub(r.sessionId)).wake).toBe(true)
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
