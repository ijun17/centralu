/**
 * A session that goes to the trash leaves the work it held in the mailbox (#1347, docs/plans/mailbox.md §3.3, §4.1): a thread
 * it was assigned is open again with nobody on it, one it owned is the person's, and the trash move is not undone by a
 * mailbox that fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import type { SessionInfo } from '@cc/protocol'
import { MailService } from '../mail/service.js'
import { PERSON } from '../mail/address.js'
import { openBy } from '../mail/mail.test-helpers.js'
import { managerWorld } from './manager.test-helpers.js'

let world: ReturnType<typeof managerWorld>
let mail: MailService

beforeEach(() => {
  world = managerWorld()
  mail = new MailService(world.store.mail, { hostId: () => 'hub-aaaaaaaa' })
  world.mgr.useMail({ sessionGone: (id) => void mail.sessionGone(id), openWork: (id) => mail.openWorkOf(id), sessionChanged: () => {} })
})

const create = async () => (await world.rpc('agents.createSession', { projectId: ((await world.rpc('projects.add', { path: tmpdir() })) as { id: string }).id, cwd: tmpdir(), tool: 'claude' })) as SessionInfo

describe('deleting a session while it holds work in the mailbox', () => {
  it('a thread it was assigned is open again with nobody on it, and one it owned is the person’s, each with an event', async () => {
    const worker = await create()
    const giver = await create()
    const a = mail.sessionAddress(worker.id)
    const g = mail.sessionAddress(giver.id)
    const { thread } = openBy(mail, { by: g, kind: 'assign', subject: 'Land #12', body: 'please', assignee: a })
    mail.update(thread.id, a, { state: 'running' })

    await world.rpc('agents.deleteSession', { sessionId: worker.id })
    expect(world.store.mail.thread(thread.id)).toMatchObject({ assignee: null, state: 'open', owner: g })
    expect(world.store.mail.messagesAfter(thread.id, 0).at(-1)).toMatchObject({ kind: 'event', facts: { change: 'assignee_gone', party: a } })

    await world.rpc('agents.deleteSession', { sessionId: giver.id })
    expect(world.store.mail.thread(thread.id)).toMatchObject({ owner: PERSON, assignee: null })
  })

  it('work that is done is left as it was, and a session with no mail costs the mailbox nothing', async () => {
    const worker = await create()
    const giver = await create()
    const a = mail.sessionAddress(worker.id)
    const { thread } = openBy(mail, { by: mail.sessionAddress(giver.id), kind: 'assign', subject: 's', body: 'b', assignee: a })
    mail.update(thread.id, a, { state: 'done', outcome: 'finished' })
    await world.rpc('agents.deleteSession', { sessionId: worker.id })
    expect(world.store.mail.thread(thread.id)).toMatchObject({ state: 'done', assignee: a })

    // A host that never made mail: no thread, so no host id is asked for
    const fresh = managerWorld()
    let asked = 0
    const quiet = new MailService(fresh.store.mail, { hostId: () => (asked++, 'hub-aaaaaaaa') })
    fresh.mgr.useMail({ sessionGone: (id) => void quiet.sessionGone(id), sessionChanged: () => {} })
    const s = (await fresh.rpc('agents.createSession', { projectId: ((await fresh.rpc('projects.add', { path: tmpdir() })) as { id: string }).id, cwd: tmpdir(), tool: 'claude' })) as SessionInfo
    await fresh.rpc('agents.deleteSession', { sessionId: s.id })
    expect(asked).toBe(0)
  })

  it('a mailbox that fails does not undo the move to the trash, and says so', async () => {
    const worker = await create()
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    world.mgr.useMail({
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
 * lost, and the mailbox is part of that. Restoring does not hand a thread back, so a session that holds one asks first.
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

  it('does not move the assignee of an unfinished thread, names it, and leaves the thread as it was', async () => {
    const worker = await create()
    const giver = await create()
    const a = mail.sessionAddress(worker.id)
    const { thread } = openBy(mail, { by: mail.sessionAddress(giver.id), kind: 'assign', subject: 'Land #12', body: 'please', assignee: a })
    mail.update(thread.id, a, { state: 'running' })

    const r = await archive(worker.id)
    expect(r.archived).toBe(false)
    expect(r.asks).toEqual([expect.stringContaining('assignee of an unfinished mail thread ("Land #12")')])
    expect(listed()).toContain(worker.id)
    expect(world.store.mail.thread(thread.id)).toMatchObject({ assignee: a, state: 'running' })
    // Once the work is done there is nothing to hand back
    mail.update(thread.id, a, { state: 'done', outcome: 'finished' })
    expect(await archive(worker.id)).toEqual({ archived: true })
  })

  it('does not move the owner of an unfinished thread either', async () => {
    const owner = await create()
    const worker = await create()
    openBy(mail, { by: mail.sessionAddress(owner.id), kind: 'assign', subject: 'Review it', body: 'b', assignee: mail.sessionAddress(worker.id) })
    const r = await archive(owner.id)
    expect(r.archived).toBe(false)
    expect(r.asks?.join(' ')).toContain('It owns an unfinished mail thread ("Review it"); it becomes the person\'s.')
    expect(listed()).toContain(owner.id)
  })

  it('asks for what the report marks hold too, and does not move a session that is not at rest', async () => {
    const waited = await create()
    const caller = await create()
    const children = (world.mgr as unknown as { children: { markReport(sessionId: string, callerId: string): void } }).children
    children.markReport(waited.id, caller.id)
    const r = await archive(waited.id)
    expect(r.archived).toBe(false)
    expect(r.asks?.join(' ')).toContain('is waiting for the report of the work it gave this session')

    const busy = await create()
    ;(world.mgr as unknown as { meta: Map<string, { state: string }> }).meta.get(busy.id)!.state = 'working'
    expect(await archive(busy.id)).toEqual({ archived: false, asks: [] })
    expect(listed()).toContain(busy.id)
  })

  it('says it is not archived, with nothing to name, for a session that is not here', async () => {
    expect(await archive('s-nothing')).toEqual({ archived: false, asks: [] })
  })

  it('asks when the mailbox cannot be read, since what it holds there is not known', async () => {
    const worker = await create()
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    world.mgr.useMail({
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
