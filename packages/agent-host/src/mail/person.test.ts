/**
 * The person's window on the message tables (docs/plans/mailbox.md §12, §16 M3a-person), over the host's own wiring (`hostMail`): the five things
 * M3a-host left wrong until the person's side moved (the M3a section's list), each from an older build's store moved at ready where it applies.
 */
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
  /** The sessions whose process takes a notice now (a live Claude), and what the host was asked to put into them when the person closed a chain (`MailSessionsView.tellMailNow`) */
  const live = new Set<string>()
  const told: { sessionId: string; text: string }[] = []
  let tellFails = false
  const failTell = () => void (tellFails = true)
  const person = new MailPerson(w.service, w.store.mailbox, w.delivery, {
    // A session named `gone` is no longer kept (trashed or deleted)
    session: (id) => (id === 'gone' ? undefined : { name: id, state: 'idle' }),
    legacyChain: (threadId) => w.store.legacyChain(threadId, undefined, 100),
    projectLabel: (projectId) => w.reach.projectLabel(projectId),
    untrusted: (projectId) => w.reach.untrusted(projectId),
    turnOn: (id) => {
      const turn = w.turns.current(id)
      return turn && { work: turn.messageId ?? turn.starter }
    },
    tellsNow: (id) => live.has(id),
    tell: async (sessionId, text) => {
      if (tellFails) throw new Error('The session is not running')
      told.push({ sessionId, text })
    },
  })
  return { ...w, person, live, told, tellFails: failTell }
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
    expect(r.person.held('release', B, [mid(10)])).toEqual({ changed: 1 })
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

describe('whom the person’s reply goes to (Q-M3a-25)', () => {
  const sentOf = (w: ReturnType<typeof hostWorld>, view: { messages: { id: string }[] }) => {
    const id = view.messages.at(-1)?.id ?? ''
    return { message: w.store.mailbox.message(id), to: w.store.mailbox.recipients(id).map((r) => r.recipient) }
  }

  it('answers the newest question that waits for the person, not a note sent after it', () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const q = w.mail.send(A, { to: [PERSON], text: 'Which branch?' }).message
    w.clock.t += 10
    w.mail.send(A, { to: [PERSON], text: 'fyi, I am waiting', replyTo: q.id, needsReply: false })
    const sent = sentOf(w, w.person.reply(q.id, 'main', 'answer'))
    expect(sent.message?.replyTo).toBe(q.id)
    expect(w.row(q.id, PERSON)?.settled).toBe('answered')
  })

  it('a question to the person and another session: that session writing in the chain does not take the answer', () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const q = w.mail.send(A, { to: [PERSON, B], text: 'Which branch?' }).message
    w.clock.t += 10
    w.mail.send(B, { to: [PERSON, A], text: 'I would say dev', replyTo: q.id, needsReply: false })
    const sent = sentOf(w, w.person.reply(q.id, 'main', 'answer'))
    expect(sent.to).toEqual([A])
  })

  it('passes over a sender that is gone and a message hidden from the person', () => {
    const w = hostWorld()
    const t = w.clock.t - 1_000
    oldThread(w.store, { id: tid(20), owner: A, at: t }, [
      { id: mid(20), sender: A, kind: 'note', body: 'from alpha', receipts: [{ recipient: PERSON }] },
      { id: mid(21), sender: at('gone'), kind: 'note', body: 'from a session since trashed', replyTo: mid(20), receipts: [{ recipient: PERSON }] },
    ])
    oldThread(w.store, { id: tid(21), owner: A, at: t }, [
      { id: mid(22), sender: A, kind: 'note', body: 'shown', receipts: [{ recipient: PERSON }] },
      { id: mid(23), sender: A, kind: 'note', body: 'held for its depth', replyTo: mid(22), receipts: [{ recipient: PERSON, held: 'loop' }] },
    ])
    const r = ready(w)
    expect(sentOf(w, r.person.reply(mid(20), 'seen', 'note'))).toMatchObject({ message: { replyTo: mid(20) }, to: [A] })
    expect(sentOf(w, r.person.reply(mid(22), 'seen', 'note'))).toMatchObject({ message: { replyTo: mid(22) }, to: [A] })
  })
})

describe('Mark done, Dismiss and Release, as Q-M3a-21, D8 and Q-M3a-22 say', () => {
  it('Mark done withdraws the person’s own question: it ends its wait, and one not delivered yet never is', async () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const mine = w.mail.send(PERSON, { to: [A], text: 'Ready?' }).message
    w.hooks.turnStarted?.('a', { by: 'work', added: false, cli: true, source: 'caller' })
    const waiting = w.mail.send(PERSON, { to: [A], text: 'Ready later?' }).message
    w.person.close(waiting.id)
    expect(w.row(waiting.id, A)?.settled).toBe('withdrawn')
    w.endTurn('a')
    await w.advance(31_000)
    expect(bodies(w, 'a')).not.toContain(waiting.id)
    // One that went already is ended too, and stays read
    w.person.close(mine.id)
    expect(w.row(mine.id, A)?.settled).toBe('withdrawn')
    expect(w.store.mailbox.watchedFrom(PERSON)).toEqual([])
  })

  it('Mark done refreshes the chain in every window', () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const q = w.mail.send(A, { to: [PERSON], text: 'Which branch?' }).message
    const heard: string[] = []
    w.service.onChange((c) => heard.push(c.rootId))
    w.person.close(q.id)
    expect(heard).toContain(q.rootId)
  })

  it('an old thread’s id opens the newest chain moved from it, and Mark done on it closes every one', () => {
    const w = hostWorld()
    const t = w.clock.t - 1_000
    oldThread(w.store, { id: tid(22), owner: A, at: t }, [
      { id: mid(24), sender: A, kind: 'question', body: 'first chain', receipts: [{ recipient: PERSON }] },
      { id: mid(25), sender: A, kind: 'question', body: 'second chain', receipts: [{ recipient: PERSON }] },
    ])
    const r = ready(w)
    expect(r.person.thread(tid(22), { tail: 100 }).thread.id).toBe(mid(25))
    r.person.close(tid(22))
    expect([w.row(mid(24), PERSON)?.settled, w.row(mid(25), PERSON)?.settled]).toEqual(['done', 'done'])
  })

  it('Dismiss of a held answer opens its question again (D8)', () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const q = w.mail.send(A, { to: [X], text: 'Is Pex ready?' }).message
    w.clock.t += 10
    const answer = w.mail.send(X, { to: [A], text: 'Yes', replyTo: q.id }).message
    expect(w.row(q.id, X)?.answerId).toBe(answer.id)
    w.person.held('dismiss', A, [answer.id])
    expect(w.row(q.id, X)?.answerId).toBeNull()
  })

  it('Release over rows of a trusted and an untrusted project is refused whole, before any goes', () => {
    const w = hostWorld()
    const t = w.clock.t - 1_000
    oldThread(w.store, { id: tid(23), owner: A, at: t }, [{ id: mid(26), sender: A, kind: 'note', body: 'budget', receipts: [{ recipient: B, held: 'budget' }] }])
    oldThread(w.store, { id: tid(24), owner: X, projectId: 'px', at: t }, [{ id: mid(27), sender: X, kind: 'note', body: 'policy', receipts: [{ recipient: B, held: 'policy' }] }])
    const r = ready(w)
    expect(refusedFor(() => r.person.held('release', B, [mid(26), mid(27)]))).toBe('untrusted_project')
    expect(w.row(mid(26), B)?.held).toBe('budget')
  })
})

describe('closing a chain a session works on, and its state, as on main (owner decisions on #1914)', () => {
  /** The person's task to `b`, as a session started with a first message records it, and the turn it starts as the host records it */
  function working(w: ReturnType<typeof ready>) {
    w.clock.t += 10
    const task = w.mail.task(PERSON, B, { text: 'Write the parser', origin: 'create_session', delivered: true })
    w.hooks.turnStarted?.('b', { by: 'work', added: false, cli: true, source: 'caller' })
    return task
  }
  const rowOf = (w: ReturnType<typeof ready>, id: string) => w.person.list().threads.find((t) => t.id === id)

  /** The notices from Centralu to `address` about a closed chain, with whether they went in at once */
  const notices = (w: ReturnType<typeof ready>, address: string) =>
    (
      dbOf(w)
        .prepare(
          `SELECT m.body AS body, m.facts AS facts, r.delivered_at AS deliveredAt, r.read_at AS readAt FROM mail m JOIN mail_recipients r ON r.message_id = m.id WHERE r.recipient = ? AND m.kind = 'notice' AND json_extract(m.facts, '$.chainClosed') IS NOT NULL ORDER BY m.created_at, m.id`,
        )
        .all(address) as { body: string; facts: string; deliveredAt: number | null; readAt: number | null }[]
    ).map((n) => ({ ...n, facts: JSON.parse(n.facts) as Record<string, unknown> }))

  it('Drop while the session’s turn is on the chain closes it at once, withdraws the task, stops nothing, and tells the session once, in the process it is in', () => {
    const w = ready(hostWorld())
    w.live.add('b')
    const task = working(w)
    expect(rowOf(w, task.id)).toMatchObject({ state: 'running', working: true, assignee: { address: B } })
    expect(w.person.close(task.id, 'dropped')).toMatchObject({ state: 'done', outcome: 'dropped', working: false })
    const words = `The person dropped the mail that began with ${task.id} and withdrew what they asked of you in it (${task.id}). Do not continue that work. Centralu did not stop your turn: if you are still working on it, stop it yourself. What you send in it still reaches the person.`
    expect(w.told).toEqual([{ sessionId: 'b', text: words }])
    // Written as the mail it is, delivered and read already, quiet, naming the chain and what was withdrawn
    expect(notices(w, B)).toMatchObject([{ body: words, facts: { quiet: true, chainClosed: { root: task.id, outcome: 'dropped', withdrawn: [task.id] } }, deliveredAt: expect.any(Number), readAt: expect.any(Number) }])
    expect(w.row(task.id, B)?.settled).toBe('withdrawn')
    // The turn goes on: Centralu did not end it. Its end owes the person no report, so nothing opens the chain again
    expect(w.turns.current('b')).toBeDefined()
    expect(w.hooks.personWork?.report('b', { outcome: 'finished', body: 'It finished.', then: 'review' })).toBe(false)
    expect(rowOf(w, task.id)).toMatchObject({ state: 'done', outcome: 'dropped' })
  })

  it('Mark done says marked done; a session not in a turn on the chain is told too, and one that sleeps (or whose tool takes no quiet input) finds the notice with its next mail', async () => {
    const w = ready(hostWorld())
    const task = working(w)
    w.endTurn('b')
    // Asleep: no process to put a quiet notice into
    w.states.set('b', { kind: 'ready', live: false, quiet: false })
    expect(rowOf(w, task.id)).toMatchObject({ state: 'running', working: false })
    expect(w.person.close(task.id, 'finished')).toMatchObject({ state: 'done', outcome: 'finished' })
    expect(w.told).toEqual([])
    const [notice] = notices(w, B)
    expect(notice?.body).toContain(`The person marked done the mail that began with ${task.id} and withdrew`)
    // Not put into a process that cannot take it, and no wake for it
    expect(notice).toMatchObject({ deliveredAt: null, readAt: null })
    await w.advance(31_000)
    expect(w.to('b')).toHaveLength(0)
    expect(notices(w, B)[0]).toMatchObject({ deliveredAt: null })
    // The session’s next mail carries it
    w.clock.t += 10
    const next = w.mail.send(A, { to: [B], text: 'A question for you' }).message
    await w.advance(31_000)
    const [notice2] = dbOf(w).prepare(`SELECT message_id AS id FROM mail_recipients WHERE recipient = ? AND message_id IN (SELECT id FROM mail WHERE kind = 'notice')`).all(B) as { id: string }[]
    expect(bodies(w, 'b')).toContain(next.id)
    expect(bodies(w, 'b')).toContain(notice2?.id)
    // Delivered with it, to be read with mail(read) as any mail is
    expect(notices(w, B)[0]?.deliveredAt).not.toBeNull()
  })

  it('closing twice, also at once, tells the session once; a close after the chain went on tells it again, once', () => {
    const w = ready(hostWorld())
    w.live.add('b')
    const task = working(w)
    w.person.close(task.id, 'dropped')
    w.person.close(task.id, 'dropped')
    w.person.close(task.id, 'finished')
    expect(w.told).toHaveLength(1)
    expect(notices(w, B)).toHaveLength(1)
    // The session answers anyway (its turn went on): the reply lands in the same chain, which is listed again as unread, and running while its turn goes
    w.clock.t += 10
    w.mail.send(B, { to: [PERSON], text: 'I had already written the parser', replyTo: task.id })
    expect(rowOf(w, task.id)).toMatchObject({ state: 'running', unread: 1 })
    expect(w.person.thread(task.id).messages.map((m) => m.body)).toEqual(['Write the parser', 'I had already written the parser'])
    // The person closes it again: the chain went on, so the session is told again, and only once
    w.person.close(task.id, 'finished')
    w.person.close(task.id, 'finished')
    expect(rowOf(w, task.id)).toMatchObject({ state: 'done', outcome: 'finished' })
    expect(w.told).toHaveLength(2)
    expect(notices(w, B).map((n) => n.facts.chainClosed)).toMatchObject([{ outcome: 'dropped' }, { outcome: 'finished', withdrawn: [] }])
    // At rest, with nothing of the person's open in it, a close tells nobody; and a late reply from it opens the chain again
    w.endTurn('b')
    w.clock.t += 10
    w.mail.send(B, { to: [PERSON], text: 'One more thing', replyTo: task.id })
    expect(rowOf(w, task.id)).toMatchObject({ state: 'open', unread: 1 })
    w.person.close(task.id, 'finished')
    expect(w.told).toHaveLength(2)
  })

  it('closes the whole chain or none of it: a failure part-way leaves the requests as they were, and tells nobody', () => {
    const w = ready(hostWorld())
    w.live.add('b')
    const task = working(w)
    const fail = vi.spyOn(w.store.mailbox, 'markClosed').mockImplementation(() => {
      throw new Error('disk full')
    })
    expect(() => w.person.close(task.id, 'dropped')).toThrow('disk full')
    fail.mockRestore()
    expect(w.row(task.id, B)?.settled).toBeNull()
    expect(rowOf(w, task.id)).toMatchObject({ state: 'running' })
    expect(w.told).toEqual([])
    expect(notices(w, B)).toEqual([])
    // Asked again, it closes
    expect(w.person.close(task.id, 'dropped')).toMatchObject({ state: 'done', outcome: 'dropped' })
    expect(w.told).toHaveLength(1)
  })

  it('a request not delivered yet is withdrawn: it never reaches the session, which is not told of what it never saw', async () => {
    const w = ready(hostWorld())
    // The session is busy with its own work, so the request waits
    w.states.set('b', { kind: 'busy', why: 'turn' })
    w.clock.t += 10
    const task = w.mail.task(PERSON, B, { text: 'Write the parser', origin: 'person', delivered: false })
    expect(w.person.close(task.id, 'dropped')).toMatchObject({ state: 'done', outcome: 'dropped' })
    expect(w.row(task.id, B)?.settled).toBe('withdrawn')
    w.states.set('b', { kind: 'ready', live: true, quiet: true })
    w.delivery.poke('b')
    await w.advance(31_000)
    expect(bodies(w, 'b')).not.toContain(task.id)
    expect(notices(w, B)).toEqual([])
    expect(w.told).toEqual([])
  })

  it('a request in delivery when the person closes (the session was waking) is not sent after all, the session is told, and nothing is left held', async () => {
    const w = ready(hostWorld())
    let release = () => {}
    w.behaviour.hold = new Promise<void>((r) => (release = r))
    w.clock.t += 10
    const task = w.mail.task(PERSON, B, { text: 'Write the parser', origin: 'person', delivered: false })
    expect(w.row(task.id, B)).toMatchObject({ attempts: 1, deliveredAt: null })
    w.person.close(task.id, 'dropped')
    release()
    await w.advance(31_000)
    // The gate saw it withdrawn: not delivered, the try counts for nothing, and it is not tried again
    expect(w.row(task.id, B)).toMatchObject({ deliveredAt: null, attempts: 0, settled: 'withdrawn' })
    // It might have arrived, so the session is told, with the notice waiting as mail
    expect(notices(w, B)).toMatchObject([{ facts: { chainClosed: { withdrawn: [task.id] } } }])
  })

  it('a request held uncertain (a restart, a tool that failed late) that the person drops leaves the held list, cannot be sent again, and its session is told', () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const task = w.mail.task(PERSON, B, { text: 'Write the parser', origin: 'person', delivered: false })
    w.store.mailbox.markUncertain(B, [task.id])
    expect(w.person.list().held.map((h) => h.messageId)).toEqual([task.id])
    w.person.close(task.id, 'dropped')
    expect(w.person.list().held).toEqual([])
    expect(w.person.thread(task.id).thread.held).toBe(0)
    expect(notices(w, B)).toHaveLength(1)
  })

  it('a session whose process fails to take the notice at once gets it from the mailbox instead, not never', async () => {
    const w = ready(hostWorld())
    w.live.add('b')
    w.tellFails()
    const task = working(w)
    w.person.close(task.id, 'dropped')
    await w.advance(5_000)
    // The direct try failed (nothing was told that way); the notice was undelivered again and the mailbox's own delivery carried it
    expect(w.told).toEqual([])
    const id = dbOf(w).prepare(`SELECT message_id AS id FROM mail_recipients WHERE recipient = ? AND message_id IN (SELECT id FROM mail WHERE kind = 'notice')`).get(B) as { id: string }
    expect(w.to('b').map((d) => d.input.text).join(' ')).toContain(id.id)
    expect(notices(w, B)).toHaveLength(1)
  })

  it('closing the chains an old thread’s id names tells a session once, not once for each chain', () => {
    const w = hostWorld()
    const t = w.clock.t - 1_000
    oldThread(w.store, { id: tid(60), owner: A, at: t }, [
      { id: mid(60), sender: A, kind: 'question', body: 'first chain', receipts: [{ recipient: PERSON }] },
      { id: mid(61), sender: A, kind: 'question', body: 'second chain', receipts: [{ recipient: PERSON }] },
    ])
    const r = ready(w)
    r.live.add('b')
    r.clock.t += 10
    const one = r.mail.task(PERSON, B, { text: 'one', origin: 'person', delivered: true, replyTo: mid(60) })
    const two = r.mail.task(PERSON, B, { text: 'two', origin: 'person', delivered: true, replyTo: mid(61) })
    r.person.close(tid(60), 'dropped')
    expect(r.told).toHaveLength(1)
    expect(notices(r, B)).toHaveLength(1)
    expect(notices(r, B)[0]?.facts.chainClosed).toMatchObject({ withdrawn: expect.arrayContaining([one.id, two.id]) })
  })

  it('a question of the person’s that waits for an answer is withdrawn the same way, and its session is told', () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const q = w.mail.send(PERSON, { to: [B], text: 'Which branch?', needsReply: true }).message
    w.store.mailbox.markDelivered(B, [q.id], w.clock.t, null)
    w.person.close(q.id, 'finished')
    expect(w.row(q.id, B)?.settled).toBe('withdrawn')
    expect(notices(w, B)).toMatchObject([{ facts: { chainClosed: { root: q.id, withdrawn: [q.id] } } }])
  })

  it('a turn on another chain is not working on this one, and closing this one tells nobody', () => {
    const w = ready(hostWorld())
    w.live.add('b')
    const task = working(w)
    const q = w.mail.send(B, { to: [PERSON], text: 'Unrelated question?', needsReply: true }).message
    expect(rowOf(w, q.id)).toMatchObject({ state: 'open', working: false })
    w.person.close(q.id)
    expect(w.told).toEqual([])
    expect(notices(w, B)).toEqual([])
    // Its own chain is the one it is told about
    w.person.close(task.id)
    expect(w.told).toMatchObject([{ sessionId: 'b' }])
    expect(notices(w, B)).toMatchObject([{ facts: { chainClosed: { root: task.id } } }])
  })

  it('a turn on a reply deep in the chain is working on the chain, and a close on a later message tells it and stops nothing', () => {
    const w = ready(hostWorld())
    w.live.add('b')
    w.clock.t += 10
    const root = w.mail.send(B, { to: [PERSON], text: 'Shall I start?', needsReply: true }).message
    w.clock.t += 10
    const go = w.mail.task(PERSON, B, { text: 'Yes, start', origin: 'person', delivered: true, replyTo: root.id })
    w.hooks.turnStarted?.('b', { by: 'work', added: false, cli: true, source: 'caller' })
    expect(rowOf(w, root.id)).toMatchObject({ working: true, state: 'running' })
    w.person.close(go.id)
    expect(w.told).toMatchObject([{ sessionId: 'b' }])
    expect(w.turns.current('b')).toBeDefined()
    expect(rowOf(w, root.id)).toMatchObject({ state: 'done' })
  })

  it('a chain whose task went to a session trashed since closes: done as the person closed it, and nobody is told', () => {
    const w = ready(hostWorld())
    const task = working(w)
    w.endTurn('b')
    w.hooks.sessionGone('b')
    expect(w.row(task.id, B)?.settled).toBe('gone')
    expect(w.person.close(task.id, 'dropped')).toMatchObject({ state: 'done', outcome: 'dropped' })
    expect(w.told).toEqual([])
    expect(notices(w, B)).toEqual([])
  })

  it('on an old thread’s id, Drop closes every chain moved from it as dropped; a later Mark done on a chain that opened again stands', () => {
    const w = hostWorld()
    const t = w.clock.t - 1_000
    oldThread(w.store, { id: tid(40), owner: A, at: t }, [
      { id: mid(40), sender: A, kind: 'question', body: 'first chain', receipts: [{ recipient: PERSON }] },
      { id: mid(41), sender: A, kind: 'question', body: 'second chain', receipts: [{ recipient: PERSON }] },
    ])
    const r = ready(w)
    r.person.close(tid(40), 'dropped')
    expect([rowOf(r, mid(40)), rowOf(r, mid(41))].map((x) => [x?.state, x?.outcome])).toEqual([
      ['done', 'dropped'],
      ['done', 'dropped'],
    ])
    r.clock.t += 10
    r.mail.send(A, { to: [PERSON], text: 'One more thing?', needsReply: true, replyTo: mid(41) })
    expect(rowOf(r, mid(41))).toMatchObject({ state: 'open', outcome: null })
    r.person.close(mid(41), 'finished')
    expect(rowOf(r, mid(41))).toMatchObject({ state: 'done', outcome: 'finished' })
    expect(rowOf(r, mid(40))).toMatchObject({ state: 'done', outcome: 'dropped' })
  })

  it('a task reported and not closed is in review; Mark done closes it as finished', () => {
    const w = ready(hostWorld())
    const task = working(w)
    expect(w.hooks.personWork?.report('b', { outcome: 'finished', body: '[Centralu] The work finished.', then: 'review' })).toBe(true)
    w.endTurn('b')
    expect(rowOf(w, task.id)).toMatchObject({ state: 'review', working: false })
    w.person.close(task.id)
    expect(rowOf(w, task.id)).toMatchObject({ state: 'done', outcome: 'finished' })
    // Reported: nothing of the person’s is open in it, so nobody is told
    expect(w.told).toEqual([])
    expect(notices(w, B)).toEqual([])
  })
})

describe('whether the window offers the person a reply box (canReply)', () => {
  it('a chain of mail between sessions that is only held for the person has nothing to answer: no box, and a reply is refused as before', () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const m = w.mail.send(A, { to: [B], text: 'Beta, please look at the branch' }).message
    w.store.mailbox.hold(B, [m.id], 'budget')
    const view = w.person.thread(m.id)
    expect(view.messages.map((x) => x.id)).toEqual([m.id])
    expect(view.canReply).toBe(false)
    expect(refusedFor(() => w.person.reply(m.id, 'hello', 'note'))).toBe('unknown_message')
  })

  it('a message to the person from a session that is here, or the person’s own to one that is, has a box', () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const q = w.mail.send(A, { to: [PERSON], text: 'Which branch?', needsReply: true }).message
    expect(w.person.thread(q.id).canReply).toBe(true)
    w.clock.t += 10
    const mine = w.mail.send(PERSON, { to: [B], text: 'Ready?' }).message
    expect(w.person.thread(mine.id).canReply).toBe(true)
  })
})

describe('the window’s numbers and the purge', () => {
  it('a number is never given twice: after the chain’s newest message is purged, the next one is still read after the last', () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const q = w.mail.send(A, { to: [PERSON], text: 'first' }).message
    w.clock.t += 10
    // Held for its recipient's budget: the person reads it, to let it go
    const held = w.mail.send(A, { to: [B], text: 'held for beta', replyTo: q.id }).message
    w.store.mailbox.hold(B, [held.id], 'budget')
    const seen = w.person.thread(q.id, { tail: 100 }).messages
    expect(seen.map((m) => m.id)).toEqual([q.id, held.id])
    // Beta purged: the held message goes, and the next message is stored where it was
    w.store.mailbox.purgeParty(B)
    expect(w.store.mailbox.message(held.id)).toBeUndefined()
    w.clock.t += 10
    const third = w.mail.send(A, { to: [PERSON], text: 'third', replyTo: q.id }).message
    expect(w.person.thread(q.id, { after: seen.at(-1)?.seq ?? 0 }).messages.map((m) => m.id)).toEqual([third.id])
  })

  it('purging the only recipient of the person’s own message keeps the message', () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const mine = w.mail.send(PERSON, { to: [B], text: 'for beta only', needsReply: false }).message
    w.store.mailbox.purgeParty(B)
    expect(w.store.mailbox.message(mine.id)).toBeDefined()
  })
})

describe('work a script started (§8.1, #1468)', () => {
  it('is the script’s on the task: the Inbox subject and the session’s read name the script, not the person', () => {
    const w = hostWorld()
    const { person } = ready(w)
    const task = w.service.task(PERSON, A, { text: 'Run the export', origin: 'script', delivered: true, fromScript: { credential: 'ci runner' } })
    expect(person.list().threads.find((t) => t.id === task.id)?.subject).toBe('The script "ci runner": Run the export')
    // The window draws the message under the script's label (MailThread.tsx), from the fact the host wrote
    expect(person.thread(task.id).messages[0]?.facts).toMatchObject({ fromScript: { credential: 'ci runner' } })
    const read = w.tool.run('a', { action: 'read', thread: task.id }).text
    expect(read).toContain('A script the person set up ("ci runner") wrote it, not the person')
    expect(read).not.toContain('The person wrote it.')
  })
})
