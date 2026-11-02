/**
 * The person's window on the message tables (docs/plans/mailbox.md §12, §16 M3a-person), over the host's own wiring (`hostMail`): the five things
 * M3a-host left wrong until the person's side moved (the M3a section's list), each from an older build's store moved at ready where it applies.
 */
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { PERSON } from './address.js'
import { at, hostWorld } from './host-mail.test-helpers.js'
import { MailPerson } from './person.js'
import { refusedFor } from './messages.test-helpers.js'
import { oldThread } from './v61.test-helpers.js'

const A = at('a')
const B = at('b')
const X = at('x')
const mid = (n: number) => `hub-aaaaaaaa.m_01ARZ3NDEKTSV4RRFFQ69G5F${String(n).padStart(2, '0')}`
const tid = (n: number) => `hub-aaaaaaaa.t_01ARZ3NDEKTSV4RRFFQ69G5F${String(n).padStart(2, '0')}`

let stops: (() => void)[] = []
afterEach(() => {
  for (const s of stops) s()
  stops = []
})

/** The next host on `w`'s store, ready, with the person's window as `main.ts` builds it */
function ready(w: ReturnType<typeof hostWorld>) {
  w.afterReady()
  stops.push(w.stop)
  const person = new MailPerson(w.service, w.store.mailbox, w.delivery, {
    session: (id) => ({ name: id, state: 'idle' }),
    legacyChain: (threadId) => w.store.legacyChain(threadId, undefined, 100),
    projectLabel: (projectId) => w.reach.projectLabel(projectId),
    untrusted: (projectId) => w.reach.untrusted(projectId),
  })
  return { ...w, person }
}
const dbOf = (w: ReturnType<typeof hostWorld>) => (w.store as unknown as { db: Database.Database }).db
const bodies = (w: ReturnType<typeof hostWorld>, id: string) => w.to(id).map((d) => d.input.text).join('\n')

describe("the person's old mail, moved at ready, in the window", () => {
  it('an old question unread by the person is unread in the window after the move; opening it reads it, with the old thread above it', () => {
    const w = hostWorld()
    oldThread(w.store, { id: tid(1), owner: A, at: w.clock.t - 1_000 }, [
      { id: mid(1), sender: A, kind: 'note', body: 'I looked at the branches.', receipts: [{ recipient: PERSON, readAt: w.clock.t - 900, handledAt: w.clock.t - 900 }] },
      { id: mid(2), sender: A, kind: 'question', body: 'Which branch?', receipts: [{ recipient: PERSON }] },
    ])
    const { person } = ready(w)
    const row = person.list().threads.find((t) => t.id === mid(2))
    expect(row).toMatchObject({ unread: 1, subject: 'Which branch?', state: 'open', owner: { address: A } })
    // The old thread's id names the chain moved from it, as a window from before the switch would ask
    const view = person.thread(tid(1), { tail: 100 })
    expect(view.thread.id).toBe(mid(2))
    expect(view.messages.map((m) => [m.body, m.kind])).toEqual([
      ['I looked at the branches.', 'note'],
      ['Which branch?', 'question'],
    ])
    expect(person.list().threads.find((t) => t.id === mid(2))?.unread).toBe(0)
  })

  it('what the person writes in the window after ready goes out at once, as an answer to the moved question, and the thread tables are not written', async () => {
    const w = hostWorld()
    oldThread(w.store, { id: tid(1), owner: A, at: w.clock.t - 1_000 }, [{ id: mid(2), sender: A, kind: 'question', body: 'Which branch?', receipts: [{ recipient: PERSON }] }])
    const { person } = ready(w)
    const oldRows = dbOf(w).prepare(`SELECT COUNT(*) AS n FROM mail_messages`).get() as { n: number }
    const view = person.reply(mid(2), 'Use main.', 'answer')
    expect(view.messages.at(-1)).toMatchObject({ body: 'Use main.', kind: 'answer', sender: { kind: 'person' } })
    await w.advance(2_000)
    expect(bodies(w, 'a')).toContain(view.messages.at(-1)?.id)
    expect(dbOf(w).prepare(`SELECT COUNT(*) AS n FROM mail_messages`).get()).toEqual(oldRows)
  })
})

describe('mail held for the person, moved still held, released or dismissed from the window', () => {
  /** Held for the trust of the sender's project (told of or not) and for a session's budget, as an older build left them */
  function heldWorld() {
    const w = hostWorld()
    const t = w.clock.t - 1_000
    oldThread(w.store, { id: tid(2), owner: X, projectId: 'px', at: t }, [
      { id: mid(3), sender: X, kind: 'note', body: 'untold policy', receipts: [{ recipient: B, held: 'policy' }] },
      { id: mid(4), sender: X, kind: 'question', body: 'told policy', receipts: [{ recipient: B, held: 'policy', deliveredAt: t }] },
    ])
    oldThread(w.store, { id: tid(3), owner: A, projectId: 'p1', at: t + 10 }, [{ id: mid(5), sender: A, kind: 'note', body: 'budget held', receipts: [{ recipient: B, held: 'budget' }] }])
    return ready(w)
  }

  it("lists each with why and its chain; Release sends the budget's now, says the project's waits for its trust, and Dismiss keeps one from ever going", async () => {
    const w = heldWorld()
    const held = w.person.list().held
    expect(held.map((h) => [h.messageId, h.threadId, h.reason, h.recipient.address])).toEqual(
      expect.arrayContaining([
        [mid(3), mid(3), 'policy', B],
        [mid(4), mid(4), 'policy', B],
        [mid(5), mid(5), 'budget', B],
      ]),
    )
    expect(w.person.held('release', B, [mid(5)])).toEqual({ changed: 1 })
    expect(refusedFor(() => w.person.held('release', B, [mid(3)]))).toBe('untrusted_project')
    expect(() => w.person.held('release', B, [mid(3)])).toThrow(/Pex is not trusted/)
    expect(w.person.held('dismiss', B, [mid(4)])).toEqual({ changed: 1 })
    await w.advance(2_000)
    expect(bodies(w, 'b')).toContain(mid(5))
    expect(bodies(w, 'b')).not.toContain(mid(3))
    expect(w.row(mid(5), B)?.held).toBe('released')
    // The project's untold one still waits for its trust; the dismissed one is out of the list for good, and stays out once the project is trusted
    expect(w.person.list().held.map((h) => h.messageId)).toEqual([mid(3)])
    w.store.projects.setProjectTrusted('px', true)
    w.person.trusted('px')
    await w.advance(120_000)
    expect(bodies(w, 'b')).toContain(mid(3))
    expect(bodies(w, 'b')).not.toContain(mid(4))
  })

  it("trusting the project lets its held mail go, told of or not, in order; Resume on the session lets its budget's go", async () => {
    const w = heldWorld()
    w.store.projects.setProjectTrusted('px', true)
    w.person.trusted('px')
    w.person.resume({ sessionId: 'b' })
    await w.advance(2_000)
    // One wake at a time, 30 s apart: what the first did not carry goes once its turn ends
    w.endTurn('b')
    await w.advance(31_000)
    const text = bodies(w, 'b')
    expect(text).toContain(mid(3))
    expect(text).toContain(mid(4))
    expect(text).toContain(mid(5))
    expect(text.indexOf(mid(3))).toBeLessThan(text.indexOf(mid(4)))
    expect(w.person.list().held).toEqual([])
  })
})

describe('Resume on a moved chain held for its turns', () => {
  for (const by of ['its root', 'its old thread id'] as const) {
    it(`by ${by}: the held mail goes, and is not held again`, async () => {
      const w = hostWorld()
      oldThread(w.store, { id: tid(4), owner: A, projectId: 'p1', at: w.clock.t - 1_000 }, [{ id: mid(7), sender: A, kind: 'note', body: 'looped', receipts: [{ recipient: B, held: 'loop' }] }])
      const { person } = ready(w)
      const row = person.list().held[0]
      expect(row).toMatchObject({ messageId: mid(7), threadId: mid(7), reason: 'loop' })
      person.resume({ threadId: by === 'its root' ? (row?.threadId ?? '') : tid(4) })
      await w.advance(2_000)
      expect(bodies(w, 'b')).toContain(mid(7))
      expect(w.row(mid(7), B)?.held).toBe('released')
      expect(person.list().held).toEqual([])
    })
  }
})

describe('the window reads and writes no thread table', () => {
  it('lists, reads, answers, marks done, releases and resumes with the v61 tables gone', async () => {
    const w = ready(hostWorld())
    dbOf(w).exec(`DROP TABLE mail_receipts; DROP TABLE mail_messages; DROP TABLE mail_threads; DROP TABLE mail_participants; DROP TABLE mail_blockers`)
    w.clock.t += 10
    const q = w.mail.send(A, { to: [PERSON], text: 'Ship it?' }).message
    expect(w.person.list().threads.map((t) => [t.id, t.unread])).toEqual([[q.id, 1]])
    expect(w.person.thread(q.id, { tail: 100 }).messages.map((m) => m.body)).toEqual(['Ship it?'])
    const mine = w.person.reply(q.id, 'Do you need a review first?', 'question').messages.at(-1)?.id ?? ''
    expect(w.person.close(q.id).state).toBe('done')
    w.person.resume({ threadId: q.id })
    expect(w.person.held('release', B, [q.id])).toEqual({ changed: 0 })
    await w.advance(2_000)
    // Marked done, the person's own question waits for no answer, and is still delivered
    expect(bodies(w, 'a')).toContain(mine)
    expect(w.store.mailbox.watchedFrom(PERSON)).toEqual([])
  })

  it("giving a thread to another session and a thread's blockers are refused: they went with threads", () => {
    const w = ready(hostWorld())
    expect(refusedFor(() => w.person.removed('Giving a thread to another session'))).toBe('removed')
  })
})

describe('the window against chains that change while it is open', () => {
  it('a message that leaves the chain keeps the numbers of the others, so the window reads the next one after its last', () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const q = w.mail.send(A, { to: [PERSON, X], text: 'first' }).message
    w.clock.t += 10
    // In the chain and readable to the person while it is held for Pex's trust
    const held = w.mail.send(X, { to: [], text: 'held for Pex', replyTo: q.id }).message
    expect(w.person.thread(q.id, { tail: 100 }).messages.map((m) => m.id)).toEqual([q.id, held.id])
    w.clock.t += 10
    const mine = w.person.reply(q.id, 'second', 'note').messages.at(-1)
    // It leaves the chain (the project's held mail dismissed), then the next one comes
    w.service.dismissProject('px')
    w.clock.t += 10
    const third = w.mail.send(A, { to: [PERSON], text: 'third', replyTo: q.id }).message
    expect(held.rootId).toBe(q.id)
    expect(w.person.thread(q.id, { after: mine?.seq ?? 0 }).messages.map((m) => m.id)).toEqual([third.id])
  })

  it('reading a chain tells every window: the list is read again', () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const q = w.mail.send(A, { to: [PERSON], text: 'unread' }).message
    const heard: string[] = []
    w.service.onChange((c) => heard.push(...c.recipients))
    w.person.thread(q.id, { tail: 100 })
    expect(heard).toContain(PERSON)
  })
})

describe('held mail the window lets go or drops, more cases', () => {
  it('a row an older build held loop after telling its recipient of it goes on Resume as mail to deliver', async () => {
    const w = hostWorld()
    oldThread(w.store, { id: tid(8), owner: A, projectId: 'p1', at: w.clock.t - 1_000 }, [{ id: mid(8), sender: A, kind: 'note', body: 'told loop', receipts: [{ recipient: B, held: 'loop', deliveredAt: w.clock.t - 900 }] }])
    const { person, ...rest } = ready(w)
    person.resume({ threadId: mid(8) })
    await rest.advance(2_000)
    expect(bodies(w, 'b')).toContain(mid(8))
  })

  it('a dismissed question waits for no answer any more', () => {
    const w = hostWorld()
    oldThread(w.store, { id: tid(9), owner: A, projectId: 'p1', at: w.clock.t - 1_000 }, [{ id: mid(9), sender: A, kind: 'question', body: 'failed q', receipts: [{ recipient: B, held: 'failed' }] }])
    const { person } = ready(w)
    w.clock.t += 10
    const fresh = w.mail.send(A, { to: [B], text: 'a new question' }).message
    w.store.mailbox.hold(B, [fresh.id], 'failed')
    expect(person.held('dismiss', B, [fresh.id])).toEqual({ changed: 1 })
    expect(w.store.mailbox.watchedFrom(A).map((r) => r.messageId)).not.toContain(fresh.id)
  })

  it("Release on a row held for a project trusted since lets the project's held mail go", async () => {
    const w = hostWorld()
    oldThread(w.store, { id: tid(10), owner: X, projectId: 'px', at: w.clock.t - 1_000 }, [{ id: mid(10), sender: X, kind: 'note', body: 'held then trusted', receipts: [{ recipient: B, held: 'policy' }] }])
    const r = ready(w)
    w.store.projects.setProjectTrusted('px', true)
    expect(() => r.person.held('release', B, [mid(10)])).not.toThrow()
    await r.advance(2_000)
    expect(bodies(w, 'b')).toContain(mid(10))
  })

  it("a deleted project's held mail is dropped after it is gone, and its senders are told its name", () => {
    const w = hostWorld()
    oldThread(w.store, { id: tid(11), owner: X, projectId: 'px', at: w.clock.t - 1_000 }, [{ id: mid(11), sender: X, kind: 'note', body: 'held', receipts: [{ recipient: B, held: 'policy' }] }])
    const r = ready(w)
    const name = r.person.projectName('px')
    dbOf(w).prepare(`DELETE FROM projects WHERE id = 'px'`).run()
    r.person.projectDeleted('px', name)
    expect(w.store.mailbox.message(mid(11))).toBeUndefined()
    expect(w.store.mailbox.feedOf(X, { limit: 5 }).map((m) => m.body).join('\n')).toContain('Pex')
  })
})
