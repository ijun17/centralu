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
  world.mgr.useMail({ sessionGone: (id) => void mail.sessionGone(id) })
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
    fresh.mgr.useMail({ sessionGone: (id) => void quiet.sessionGone(id) })
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
    })
    await world.rpc('agents.deleteSession', { sessionId: worker.id })
    expect(world.store.trash.isTrashed(worker.id)).toBe(true)
    expect(said.mock.calls.join(' ')).toContain('disk full')
    said.mockRestore()
  })
})
