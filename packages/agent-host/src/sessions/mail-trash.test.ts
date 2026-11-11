/**
 * A session that goes to the trash leaves the work it held in the mailbox (#1347, docs/plans/mailbox.md §7.7, `partyGone`): what waited for its
 * answer is settled `gone` and each sender is told once, its own unsettled messages are withdrawn, and the trash move is not undone by a
 * mailbox that fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import type { SessionInfo } from '@cc/protocol'
import type { HostMail } from '../mail/host-mail.js'
import { managerWorld } from './manager.test-helpers.js'
import { addressOf, mailReader, wireHostMail } from './host-mail.test-helpers.js'

let world: ReturnType<typeof managerWorld>
let m: HostMail
let read: ReturnType<typeof mailReader>

beforeEach(() => {
  world = managerWorld()
  m = wireHostMail(world.mgr, world.store)
  read = mailReader(world.store)
})

const create = async () => (await world.rpc('agents.createSession', { projectId: ((await world.rpc('projects.add', { path: tmpdir() })) as { id: string }).id, cwd: tmpdir(), tool: 'claude' })) as SessionInfo
/** A task from `giver` to `worker`, as a delegation writes it (delivered and read) */
const task = (giver: SessionInfo, worker: SessionInfo, text: string) => m.service.task(addressOf(giver.id), addressOf(worker.id), { text, origin: 'agent_session', delivered: true })

describe('deleting a session while it holds work in the mailbox', () => {
  it('a task it was given and a question that waits for its answer are gone, the asker is told once, and what it sent is withdrawn', async () => {
    const worker = await create()
    const giver = await create()
    const a = addressOf(worker.id)
    const g = addressOf(giver.id)
    const t = task(giver, worker, 'Land #12')
    const asked = m.service.send(g, { to: [a], text: 'Which branch?', needsReply: true }).message
    const own = m.service.send(a, { to: [g], text: 'Can you review it?', needsReply: true }).message

    await world.rpc('agents.deleteSession', { sessionId: worker.id })
    expect(read.row(t.id, a)).toMatchObject({ settled: 'gone', releasedWhy: 'gone' })
    expect(read.row(asked.id, a)).toMatchObject({ settled: 'gone', releasedWhy: 'gone' })
    expect(read.row(own.id, g)).toMatchObject({ settled: 'withdrawn' })
    // One notice for both: the question and the task, whose giver is told the work stopped (mailbox.md §10.6.1)
    const told = read.to(g).filter((x) => x.message.kind === 'notice' && x.message.facts.unanswered)
    expect(told).toHaveLength(1)
    expect(told[0]!.message.facts.unanswered).toEqual([{ id: t.id, recipient: a, why: 'gone' }, { id: asked.id, recipient: a, why: 'gone' }])
  })

  it('work that is done is left as it was, and a session with no mail leaves no mail behind', async () => {
    const worker = await create()
    const giver = await create()
    const a = addressOf(worker.id)
    const t = task(giver, worker, 's')
    m.service.report(t.id, { outcome: 'finished', body: 'done' })
    await world.rpc('agents.deleteSession', { sessionId: worker.id })
    expect(read.row(t.id, a)).toMatchObject({ settled: 'reported' })

    const s = await create()
    await world.rpc('agents.deleteSession', { sessionId: s.id })
    expect(world.store.mailbox.feedOf(addressOf(s.id), { limit: 10 })).toEqual([])
  })

  it('a request to the Assistant’s role outlives the Assistant put in the trash: the next Assistant made gets it, delivered afresh (D15)', async () => {
    const asker = await create()
    const orc = await world.mgr.assistant()
    world.adapter.capabilities.gatesSteps = true
    expect(m.tool.run(asker.id, { action: 'send', to: 'assistant', text: 'Can you look at CI?' }).text).toContain('Sent')
    const request = read.between(addressOf(asker.id), addressOf(orc.id))[0]!
    await world.rpc('agents.deleteSession', { sessionId: orc.id })
    expect(read.row(request.id, addressOf(orc.id))).toMatchObject({ settled: null })
    // Nothing for the sweep to settle meanwhile: the row waits for the role, not for the session that held it
    expect(world.store.mailbox.openParties()).not.toContain(addressOf(orc.id))

    const next = await world.mgr.assistant()
    expect(next.id).not.toBe(orc.id)
    expect(read.row(request.id, addressOf(next.id))).toMatchObject({ via: 'assistant', settled: null, deliveredAt: null })
    expect(read.row(request.id, addressOf(orc.id))).toBeUndefined()
  })

  it('a mailbox that fails does not undo the move to the trash, and says so', async () => {
    const worker = await create()
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    world.mgr.mail.useMail({
      sessionGone: () => {
        throw new Error('disk full')
      },
      sessionChanged: () => {},
    })
    await world.rpc('agents.deleteSession', { sessionId: worker.id })
    expect(world.store.trash.isTrashed(worker.id)).toBe(true)
    expect(said.mock.calls.join(' ')).toContain('disk full')
    said.mockRestore()
  })
})

/**
 * The window's archive of a session that looks idle (#1512, `agents.archiveIfAtRest`): the host moves it only when nothing it holds would be
 * lost, and the mailbox is part of that. Restoring does not bring its mail back, so a session that holds a task or a question asks first.
 */
describe('archiving a session that looks idle', () => {
  const archive = (sessionId: string) => world.rpc('agents.archiveIfAtRest', { sessionId }) as Promise<{ archived: boolean; asks?: string[] }>
  const listed = () => world.mgr.listSessions().map((s) => s.id)

  it('moves a session that holds no work, and nothing is asked', async () => {
    const worker = await create()
    expect(await archive(worker.id)).toEqual({ archived: true })
    expect(listed()).not.toContain(worker.id)
    expect(world.store.trash.isTrashed(worker.id)).toBe(true)
  })

  it('does not move a session given a task it has not been reported on, names it, and leaves the task as it was', async () => {
    const worker = await create()
    const giver = await create()
    const t = task(giver, worker, 'Land #12\nwith the tests')

    const r = await archive(worker.id)
    expect(r.archived).toBe(false)
    expect(r.asks).toEqual(['It was given a task it has not been reported on ("Land #12"); whoever gave it is told the work stopped.'])
    expect(listed()).toContain(worker.id)
    expect(read.taskRow(t.id, worker.id)).toMatchObject({ settled: null })
    // Once the work is reported there is nothing to lose
    m.service.report(t.id, { outcome: 'finished', body: 'done' })
    expect(await archive(worker.id)).toEqual({ archived: true })
  })

  it('does not move a session a question waits on either', async () => {
    const asker = await create()
    const worker = await create()
    m.service.send(addressOf(asker.id), { to: [addressOf(worker.id)], text: 'Review it', needsReply: true })
    const r = await archive(worker.id)
    expect(r.archived).toBe(false)
    expect(r.asks).toEqual(['A message waits for its answer ("Review it"); its sender is told it is gone.'])
    expect(listed()).toContain(worker.id)
  })

  it('names a task a session gave it once, as its mailbox does, and does not move a session that is not at rest', async () => {
    const waited = await create()
    const caller = await create()
    task(caller, waited, 'Write the docs')
    const r = await archive(waited.id)
    expect(r.archived).toBe(false)
    // The task is the caller's only record of the work (docs/plans/mailbox.md §10.6.3): one line for it, not a second about its report
    expect(r.asks).toEqual(['It was given a task it has not been reported on ("Write the docs"); whoever gave it is told the work stopped.'])

    const busy = await create()
    ;(world.mgr as unknown as { meta: Map<string, { state: string }> }).meta.get(busy.id)!.state = 'working'
    expect(await archive(busy.id)).toEqual({ archived: false, asks: [] })
    expect(listed()).toContain(busy.id)
  })

  // #1595: the dialog reads these before anything moves, also when the worktree goes with the session; nothing moves and nothing changes
  it('lists what an archive would lose without moving anything (agents.archiveLosses)', async () => {
    const losses = (sessionId: string) => world.rpc('agents.archiveLosses', { sessionId }) as Promise<{ asks: string[] }>
    const clean = await create()
    expect(await losses(clean.id)).toEqual({ asks: [] })

    const worker = await create()
    const giver = await create()
    const t = task(giver, worker, 'Land #13')
    const waited = await create()
    const caller = await create()
    task(caller, waited, 'Write the docs')

    // The same lines the move itself would answer with
    expect((await losses(worker.id)).asks).toEqual([expect.stringContaining('task it has not been reported on ("Land #13")')])
    expect((await losses(waited.id)).asks).toEqual([expect.stringContaining('task it has not been reported on ("Write the docs")')])
    expect((await losses(worker.id)).asks).toEqual((await archive(worker.id)).asks)
    expect(listed()).toEqual(expect.arrayContaining([clean.id, worker.id, waited.id]))
    expect(read.taskRow(t.id, worker.id)).toMatchObject({ settled: null })
    expect(await losses('s-nothing')).toEqual({ asks: [] })
  })

  it('says it is not archived, with nothing to name, for a session that is not here', async () => {
    expect(await archive('s-nothing')).toEqual({ archived: false, asks: [] })
  })

  it('asks when the mailbox cannot be read, since what it holds there is not known', async () => {
    const worker = await create()
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    world.mgr.mail.useMail({
      sessionGone: () => {},
      openWork: () => {
        throw new Error('database is locked')
      },
      sessionChanged: () => {},
    })
    const r = await archive(worker.id)
    expect(r.archived).toBe(false)
    expect(r.asks?.join(' ')).toContain('Its mailbox could not be read')
    said.mockRestore()
  })
})
