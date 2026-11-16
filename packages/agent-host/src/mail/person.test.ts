/**
 * The person's window on the message tables (docs/plans/mailbox.md §12, §16 M3a-person), over the host's own wiring (`hostMail`): the five things
 * M3a-host left wrong until the person's side moved (the M3a section's list), each on mail moved from an old thread (store step v75) where it applies.
 */
import type Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PERSON } from './address.js'
import { HIDDEN_HOLDS } from '../dev-services/store/mailbox.js'
import { at, hostWorld } from './host-mail.test-helpers.js'
import { MailPerson } from './person.js'
import { refusedFor, refusedForAsync } from './messages.test-helpers.js'
import { movedThread } from './moved.test-helpers.js'

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

describe("the person's old mail, moved from an old thread (store step v75), in the window", () => {
  it('an old question unread by the person is unread in the window after the move; opening it reads it', () => {
    const w = hostWorld()
    movedThread(w, { id: tid(1), at: w.clock.t - 1_000 }, [{ id: mid(2), sender: A, kind: 'question', body: 'Which branch?', to: [{ recipient: PERSON }] }])
    const { person } = ready(w)
    const row = person.list().threads.find((t) => t.id === mid(2))
    expect(row).toMatchObject({ unread: 1, subject: 'Which branch?', state: 'open', owner: { address: A } })
    // The old thread's id names the chain moved from it, as a window from before the switch would ask
    const view = person.thread(tid(1), { tail: 100 })
    expect(view.thread.id).toBe(mid(2))
    // Only what was moved: what the thread said before it, handled when the step ran, is not mail
    expect(view.messages.map((m) => [m.body, m.kind])).toEqual([['Which branch?', 'question']])
    expect(person.list().threads.find((t) => t.id === mid(2))?.unread).toBe(0)
  })

  it('a moved message keeps the word its thread gave it: an answer whose question was not moved is still an answer', () => {
    const w = hostWorld()
    movedThread(w, { id: tid(1), at: w.clock.t - 1_000 }, [{ id: mid(2), sender: A, kind: 'answer', body: 'It is main.', to: [{ recipient: PERSON }] }])
    const { person } = ready(w)
    expect(person.thread(mid(2), { tail: 100 }).messages.map((m) => [m.body, m.kind])).toEqual([['It is main.', 'answer']])
  })

  it('what the person writes in the window after ready goes out at once, as an answer to the moved question', async () => {
    const w = hostWorld()
    movedThread(w, { id: tid(1), at: w.clock.t - 1_000 }, [{ id: mid(2), sender: A, kind: 'question', body: 'Which branch?', to: [{ recipient: PERSON }] }])
    const { person } = ready(w)
    const view = await person.reply(mid(2), 'Use main.', 'answer')
    expect(view.messages.at(-1)).toMatchObject({ body: 'Use main.', kind: 'answer', sender: { kind: 'person' } })
    await w.advance(2_000)
    expect(bodies(w, 'a')).toContain(view.messages.at(-1)?.id)
  })
})

describe('mail held for the person, moved still held, released or dismissed from the window', () => {
  /**
   * Held for the trust of the sender's project (told of or not) and for a session's budget. The step ends the holds an earlier build left (#2243: the
   * token guard and the first-contact hold are gone), so the rows are written not held and the holds are put on them once the host is ready, as today's
   * trust gate and an older host's still-served mail would leave them
   */
  function heldWorld() {
    const w = hostWorld()
    const t = w.clock.t - 1_000
    movedThread(w, { id: tid(2), at: t }, [
      { id: mid(3), sender: X, kind: 'note', body: 'untold policy', to: [{ recipient: B }] },
      { id: mid(4), sender: X, kind: 'question', body: 'told policy', to: [{ recipient: B, deliveredAt: t }] },
    ])
    movedThread(w, { id: tid(3), at: t + 10 }, [{ id: mid(5), sender: A, kind: 'note', body: 'failed held', to: [{ recipient: B }] }])
    const r = ready(w)
    r.store.mailbox.hold(B, [mid(3), mid(4)], 'policy')
    r.store.mailbox.hold(B, [mid(5)], 'failed')
    return r
  }

  it("lists each with why and its chain; Release sends a failed one now, says the project's waits for its trust, and Dismiss keeps one from ever going", async () => {
    const w = heldWorld()
    const held = w.person.list().held
    expect(held.map((h) => [h.messageId, h.threadId, h.reason, h.recipient.address])).toEqual(
      expect.arrayContaining([
        [mid(3), mid(3), 'policy', B],
        [mid(4), mid(4), 'policy', B],
        [mid(5), mid(5), 'failed', B],
      ]),
    )
    expect(w.person.held('release', B, [mid(5)])).toEqual({ changed: 1 })
    expect(refusedFor(() => w.person.held('release', B, [mid(3)]))).toBe('untrusted_project')
    expect(() => w.person.held('release', B, [mid(3)])).toThrow(/Pex is not trusted/)
    expect(w.person.held('dismiss', B, [mid(4)])).toEqual({ changed: 1 })
    await w.advance(2_000)
    expect(bodies(w, 'b')).toContain(mid(5))
    expect(bodies(w, 'b')).not.toContain(mid(3))
    expect(w.row(mid(5), B)?.held).toBeNull()
    // The project's untold one still waits for its trust; the dismissed one is out of the list for good, and stays out once the project is trusted
    expect(w.person.list().held.map((h) => h.messageId)).toEqual([mid(3)])
    w.store.projects.setProjectTrusted('px', true)
    w.person.trusted('px')
    await w.advance(120_000)
    expect(bodies(w, 'b')).toContain(mid(3))
    expect(bodies(w, 'b')).not.toContain(mid(4))
  })

  it("trusting the project lets its held mail go, told of or not, in order; an older window's Resume on the session (#2247) lets nothing go", async () => {
    const w = heldWorld()
    w.store.projects.setProjectTrusted('px', true)
    w.person.trusted('px')
    w.person.resume({ sessionId: 'b' })
    expect(w.row(mid(5), B)).toMatchObject({ held: 'failed', deliveredAt: null })
    await w.advance(2_000)
    // One wake at a time, 30 s apart: what the first did not carry goes once its turn ends
    w.endTurn('b')
    await w.advance(31_000)
    const text = bodies(w, 'b')
    expect(text).toContain(mid(3))
    expect(text).toContain(mid(4))
    expect(text.indexOf(mid(3))).toBeLessThan(text.indexOf(mid(4)))
  })
})

describe('Resume on a moved chain held for its turns', () => {
  for (const by of ['its root', 'its old thread id'] as const) {
    it(`by ${by}: the held mail goes, and is not held again`, async () => {
      const w = hostWorld()
      movedThread(w, { id: tid(4), at: w.clock.t - 1_000 }, [{ id: mid(7), sender: A, kind: 'note', body: 'looped', to: [{ recipient: B, held: 'loop' }] }])
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

describe('the window against chains that change while it is open', () => {
  it('a message that leaves the chain keeps the numbers of the others, so the window reads the next one after its last', async () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const q = w.mail.send(A, { to: [PERSON, X], text: 'first' }).message
    w.clock.t += 10
    // In the chain and readable to the person while it is held for Pex's trust
    const held = w.mail.send(X, { to: [], text: 'held for Pex', replyTo: q.id }).message
    expect(w.person.thread(q.id, { tail: 100 }).messages.map((m) => m.id)).toEqual([q.id, held.id])
    w.clock.t += 10
    const mine = (await w.person.reply(q.id, 'second', 'note')).messages.at(-1)
    // It leaves the chain (the project's held mail dismissed), then the next one comes
    w.service.dismissProject('px')
    w.clock.t += 10
    const third = w.mail.send(A, { to: [PERSON], text: 'third', replyTo: q.id }).message
    expect(held.rootId).toBe(q.id)
    expect(w.person.thread(q.id, { after: mine?.seq ?? 0 }).messages.map((m) => m.id)).toEqual([third.id])
  })

  it('a chain read as a look in (a hub showing it read-only, #2268) is read for nobody, and offers no reply', () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const q = w.mail.send(A, { to: [PERSON], text: 'unread' }).message
    expect(w.person.thread(q.id, { tail: 100, lookIn: true })).toMatchObject({ lookIn: true, messages: [{ body: 'unread' }] })
    expect(w.store.mailbox.recipient(q.id, PERSON)?.readAt).toBeNull()
    expect(w.person.list().threads.map((t) => t.unread)).toEqual([1])
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
    movedThread(w, { id: tid(8), at: w.clock.t - 1_000 }, [{ id: mid(8), sender: A, kind: 'note', body: 'told loop', to: [{ recipient: B, held: 'loop', deliveredAt: w.clock.t - 900 }] }])
    const { person, ...rest } = ready(w)
    person.resume({ threadId: mid(8) })
    await rest.advance(2_000)
    expect(bodies(w, 'b')).toContain(mid(8))
  })

  it('a dismissed question waits for no answer any more', () => {
    const w = hostWorld()
    movedThread(w, { id: tid(9), at: w.clock.t - 1_000 }, [{ id: mid(9), sender: A, kind: 'question', body: 'failed q', to: [{ recipient: B, held: 'failed' }] }])
    const { person } = ready(w)
    w.clock.t += 10
    const fresh = w.mail.send(A, { to: [B], text: 'a new question' }).message
    w.store.mailbox.hold(B, [fresh.id], 'failed')
    expect(person.held('dismiss', B, [fresh.id])).toEqual({ changed: 1 })
    expect(w.store.mailbox.watchedFrom(A).map((r) => r.messageId)).not.toContain(fresh.id)
  })

  it("Release on a row held for a project trusted since lets the project's held mail go", async () => {
    const w = hostWorld()
    movedThread(w, { id: tid(10), at: w.clock.t - 1_000 }, [{ id: mid(10), sender: X, kind: 'note', body: 'held then trusted', to: [{ recipient: B }] }])
    const r = ready(w)
    r.store.mailbox.hold(B, [mid(10)], 'policy')
    w.store.projects.setProjectTrusted('px', true)
    expect(r.person.held('release', B, [mid(10)])).toEqual({ changed: 1 })
    await r.advance(2_000)
    expect(bodies(w, 'b')).toContain(mid(10))
  })

  it("a deleted project's held mail is dropped after it is gone, and its senders are told its name", () => {
    const w = hostWorld()
    movedThread(w, { id: tid(11), at: w.clock.t - 1_000 }, [{ id: mid(11), sender: X, kind: 'note', body: 'held', to: [{ recipient: B }] }])
    const r = ready(w)
    r.store.mailbox.hold(B, [mid(11)], 'policy')
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

  it('answers the newest question that waits for the person, not a note sent after it', async () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const q = w.mail.send(A, { to: [PERSON], text: 'Which branch?' }).message
    w.clock.t += 10
    w.mail.send(A, { to: [PERSON], text: 'fyi, I am waiting', replyTo: q.id, needsReply: false })
    const sent = sentOf(w, await w.person.reply(q.id, 'main', 'answer'))
    expect(sent.message?.replyTo).toBe(q.id)
    expect(w.row(q.id, PERSON)?.settled).toBe('answered')
  })

  it('a question to the person and another session: that session writing in the chain does not take the answer', async () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const q = w.mail.send(A, { to: [PERSON, B], text: 'Which branch?' }).message
    w.clock.t += 10
    w.mail.send(B, { to: [PERSON, A], text: 'I would say dev', replyTo: q.id, needsReply: false })
    const sent = sentOf(w, await w.person.reply(q.id, 'main', 'answer'))
    expect(sent.to).toEqual([A])
  })

  it('passes over a sender that is gone and a message hidden from the person', async () => {
    const w = hostWorld()
    const t = w.clock.t - 1_000
    movedThread(w, { id: tid(20), at: t }, [
      { id: mid(20), sender: A, kind: 'note', body: 'from alpha', to: [{ recipient: PERSON }] },
      { id: mid(21), sender: at('gone'), kind: 'note', body: 'from a session since trashed', replyTo: mid(20), to: [{ recipient: PERSON }] },
    ])
    movedThread(w, { id: tid(21), at: t }, [
      { id: mid(22), sender: A, kind: 'note', body: 'shown', to: [{ recipient: PERSON }] },
      { id: mid(23), sender: A, kind: 'note', body: 'held for its depth', replyTo: mid(22), to: [{ recipient: PERSON, held: 'loop' }] },
    ])
    const r = ready(w)
    expect(sentOf(w, (await r.person.reply(mid(20), 'seen', 'note')))).toMatchObject({ message: { replyTo: mid(20) }, to: [A] })
    expect(sentOf(w, (await r.person.reply(mid(22), 'seen', 'note')))).toMatchObject({ message: { replyTo: mid(22) }, to: [A] })
  })
})

describe('Mark done, Dismiss and Release, as Q-M3a-21, D8 and Q-M3a-22 say', () => {
  it('Mark done withdraws the person’s own question: it ends its wait, and one not delivered yet never is', async () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const mine = w.mail.send(PERSON, { to: [A], text: 'Ready?' }).message
    w.hooks.turnStarted?.('a', { by: 'work', cli: true, source: 'caller' })
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
    movedThread(w, { id: tid(22), at: t }, [
      { id: mid(24), sender: A, kind: 'question', body: 'first chain', to: [{ recipient: PERSON }] },
      { id: mid(25), sender: A, kind: 'question', body: 'second chain', to: [{ recipient: PERSON }] },
    ])
    const r = ready(w)
    expect(r.person.thread(tid(22), { tail: 100 }).thread.id).toBe(mid(25))
    r.person.close(tid(22))
    expect([w.row(mid(24), PERSON)?.settled, w.row(mid(25), PERSON)?.settled]).toEqual(['done', 'done'])
  })

  it('an old thread’s id naming a chain of the person’s and one of the sessions’ alone: each is decided for itself, and close leaves the sessions’ one be', () => {
    const w = hostWorld()
    const t = w.clock.t - 1_000
    movedThread(w, { id: tid(23), at: t }, [
      { id: mid(26), sender: A, kind: 'question', body: 'to the person', to: [{ recipient: PERSON }] },
      { id: mid(27), sender: A, kind: 'question', body: 'between sessions', to: [{ recipient: B }] },
    ])
    const r = ready(w)
    // The newest chain is the sessions' own: the person looks in on it
    expect(r.person.thread(tid(23), { tail: 100 })).toMatchObject({ lookIn: true, canReply: false, thread: { id: mid(27) } })
    const sessions = () => ({ row: w.row(mid(27), B), facts: w.store.mailbox.message(mid(27))?.facts })
    const before = sessions()
    // The row it answers is the chain it closed, not the sessions' one the id names first
    expect(r.person.close(tid(23))).toMatchObject({ id: mid(26) })
    expect(w.row(mid(26), PERSON)?.settled).toBe('done')
    expect(sessions()).toEqual(before)
    expect(w.store.mailbox.message(mid(27))?.facts.closed).toBeUndefined()
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
    movedThread(w, { id: tid(23), at: t }, [{ id: mid(26), sender: A, kind: 'note', body: 'failed', to: [{ recipient: B }] }])
    movedThread(w, { id: tid(24), at: t }, [{ id: mid(27), sender: X, kind: 'note', body: 'policy', to: [{ recipient: B }] }])
    const r = ready(w)
    r.store.mailbox.hold(B, [mid(26)], 'failed')
    r.store.mailbox.hold(B, [mid(27)], 'policy')
    expect(refusedFor(() => r.person.held('release', B, [mid(26), mid(27)]))).toBe('untrusted_project')
    expect(w.row(mid(26), B)?.held).toBe('failed')
  })
})

describe('closing a chain a session works on, and its state, as on main (owner decisions on #1914)', () => {
  /** The person's task to `b`, as a session started with a first message records it, and the turn it starts as the host records it */
  function working(w: ReturnType<typeof ready>) {
    w.clock.t += 10
    const task = w.mail.task(PERSON, B, { text: 'Write the parser', origin: 'create_session', delivered: true })
    w.hooks.turnStarted?.('b', { by: 'work', cli: true, source: 'caller' })
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
    // The turn goes on: Centralu did not end it. Its last response answers no withdrawn task, so nothing opens the chain again
    expect(w.turns.current('b')).toBeDefined()
    w.endTurn('b')
    w.hooks.lastResponse?.('b', { body: () => 'It ended its turn.', relay: () => {}, released: true })
    expect(w.store.mailbox.reportsOn(task.id)).toEqual([])
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
    movedThread(w, { id: tid(60), at: t }, [
      { id: mid(60), sender: A, kind: 'question', body: 'first chain', to: [{ recipient: PERSON }] },
      { id: mid(61), sender: A, kind: 'question', body: 'second chain', to: [{ recipient: PERSON }] },
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
    w.hooks.turnStarted?.('b', { by: 'work', cli: true, source: 'caller' })
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
    movedThread(w, { id: tid(40), at: t }, [
      { id: mid(40), sender: A, kind: 'question', body: 'first chain', to: [{ recipient: PERSON }] },
      { id: mid(41), sender: A, kind: 'question', body: 'second chain', to: [{ recipient: PERSON }] },
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
    w.endTurn('b')
    // Answered as any task is: by the session's last response at rest (§10.6.3)
    w.hooks.lastResponse?.('b', { body: () => 'It ended its turn.', relay: () => {}, answer: 'parsed', released: true })
    expect(w.store.mailbox.reportsOn(task.id)).toHaveLength(1)
    expect(rowOf(w, task.id)).toMatchObject({ state: 'review', working: false })
    w.person.close(task.id)
    expect(rowOf(w, task.id)).toMatchObject({ state: 'done', outcome: 'finished' })
    // Reported: nothing of the person’s is open in it, so nobody is told
    expect(w.told).toEqual([])
    expect(notices(w, B)).toEqual([])
  })

  it('a task a stop released and nothing settled is open, not running: the session no longer works on it; one still delivered and open is running', () => {
    const w = ready(hostWorld())
    const task = working(w)
    const seq = w.turns.current('b')!.turnSeq
    w.endTurn('b')
    expect(rowOf(w, task.id)).toMatchObject({ state: 'running', working: false })
    w.mail.stops.sessionStopped(B, 'interrupted', { turnSeq: seq })
    expect(w.row(task.id, B)).toMatchObject({ settled: null, releasedWhy: 'interrupted' })
    expect(rowOf(w, task.id)).toMatchObject({ state: 'open', working: false })
    // A second task, given after the stop, is open and delivered: the chain it starts is running
    const next = working(w)
    expect(rowOf(w, next.id)).toMatchObject({ state: 'running' })
  })
})

describe('whether the window offers the person a reply box (canReply)', () => {
  it('a chain of mail between sessions that is only held for the person has nothing to answer: no box, and a reply is refused as before', async () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const m = w.mail.send(A, { to: [B], text: 'Beta, please look at the branch' }).message
    w.store.mailbox.hold(B, [m.id], 'failed')
    const view = w.person.thread(m.id)
    expect(view.messages.map((x) => x.id)).toEqual([m.id])
    expect(view.canReply).toBe(false)
    expect(await refusedForAsync(() => w.person.reply(m.id, 'hello', 'note'))).toBe('unknown_message')
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
    // Held for the person (it could not be delivered): the person reads it, to let it go
    const held = w.mail.send(A, { to: [B], text: 'held for beta', replyTo: q.id }).message
    w.store.mailbox.hold(B, [held.id], 'failed')
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

describe('the thread row says what waits on the person’s answer (#2229)', () => {
  it('names the newest unanswered question with its first lines as plain words and its choices, and counts them; an answer, a close or a sender that is gone clears it', async () => {
    const w = ready(hostWorld())
    const root = w.service.send(PERSON, { to: [A], text: 'Go ahead.' }).message
    expect(w.person.list().threads[0]?.ask).toBeNull()
    w.tool.run('a', { action: 'reply', thread: root.id, kind: 'question', text: '**Which** branch?\n\nline two\nline three\nline four\nline five', choices: ['main', 'release'] })
    w.clock.t += 10
    w.tool.run('a', { action: 'reply', thread: root.id, kind: 'question', text: 'And the tag?' })
    const row = () => w.person.list().threads.find((t) => t.id === root.id)!
    expect(row().ask).toMatchObject({ text: 'And the tag?', open: [expect.any(String), expect.any(String)], sender: { address: A } })
    expect(row().ask?.choices).toBeUndefined()
    const first = w.person.thread(root.id).messages.find((m) => m.body.startsWith('**Which**'))!
    await w.person.reply(root.id, 'And the tag?', 'answer', w.person.thread(root.id).messages.find((m) => m.body === 'And the tag?')!.id)
    expect(row().ask).toMatchObject({ id: first.id, text: 'Which branch?\nline two\nline three\nline four', choices: ['main', 'release'], open: [first.id] })
    w.person.close(root.id)
    expect(row().ask).toBeNull()
  })

  it('is not set for a note: nothing in it asks for an answer', () => {
    const w = ready(hostWorld())
    const note = w.service.send(A, { to: [PERSON], text: 'FYI.', needsReply: false }).message
    expect(w.person.list().threads.find((t) => t.id === note.id)?.ask).toBeNull()
  })
})

describe('an answer reads what it answers (#2233)', () => {
  const askTwice = () => {
    const w = ready(hostWorld())
    const root = w.service.send(PERSON, { to: [A], text: 'Go ahead.' }).message
    w.tool.run('a', { action: 'reply', thread: root.id, kind: 'question', text: 'First?', choices: ['x', 'y'] })
    w.clock.t += 10
    w.tool.run('a', { action: 'reply', thread: root.id, kind: 'question', text: 'Second?' })
    const row = () => w.person.list().threads.find((t) => t.id === root.id)!
    const asked = (body: string) => w.store.mailbox.feedOf(PERSON, { limit: 50 }).find((m) => m.body === body)!
    return { w, root, row, asked }
  }

  it('the row of a question answered from the list is read and no longer asks: unread is 0 and it leaves the waiting list; a later question stays unread until its own answer', async () => {
    const { w, root, row, asked } = askTwice()
    expect(row()).toMatchObject({ unread: 2, ask: { open: [asked('First?').id, asked('Second?').id] } })
    // The list's card answers without the thread ever being opened: `thread()` has not read anything
    await w.person.reply(root.id, 'x', 'answer', asked('First?').id)
    expect(row()).toMatchObject({ unread: 1, ask: { id: asked('Second?').id, open: [asked('Second?').id] } })
    expect(w.row(asked('First?').id, PERSON)?.readAt).not.toBeNull()
    await w.person.reply(root.id, 'my own words', 'answer', asked('Second?').id)
    expect(row().unread).toBe(0)
    expect(row().ask).toBeNull()
  })

  it('the reply box’s free reply reads what it answers too: the newest question and what came before it, and the older question still asks', async () => {
    const { w, root, row, asked } = askTwice()
    await w.person.reply(root.id, 'for the newest')
    expect(row()).toMatchObject({ unread: 0, ask: { id: asked('First?').id, open: [asked('First?').id] } })
  })

  it('Done from the list reads what it closes: the row is done with nothing unread, though the thread was never opened', () => {
    const { w, root, row } = askTwice()
    expect(row().unread).toBe(2)
    w.person.close(root.id)
    expect(row()).toMatchObject({ state: 'done', unread: 0, ask: null })
  })

  it('there is one rule for an open question: the thread’s `ask.open` is what the reply box answers; a sender that is gone, a message held for the person and a note are not in it', async () => {
    const w = hostWorld()
    const t = w.clock.t - 1_000
    movedThread(w, { id: tid(30), at: t }, [
      { id: mid(30), sender: at('gone'), kind: 'question', body: 'from a session since trashed', to: [{ recipient: PERSON }] },
      { id: mid(31), sender: A, kind: 'question', body: 'held for its depth', to: [{ recipient: PERSON, held: 'loop' }] },
      { id: mid(32), sender: A, kind: 'note', body: 'only a note', to: [{ recipient: PERSON }] },
      { id: mid(33), sender: A, kind: 'question', body: 'Which one?', to: [{ recipient: PERSON }] },
    ])
    const r = ready(w)
    const view = r.person.thread(tid(30))
    expect(view.thread.ask?.open).toEqual([mid(33)])
    // The same question is the one a free reply answers
    expect((await r.person.reply(tid(30), 'this one')).messages.find((m) => m.body === 'this one')).toMatchObject({ replyTo: mid(33) })
  })
})

describe('Markdown in a one-line text (#2228)', () => {
  it('the thread subject and the row preview are the words, without the marks', () => {
    const w = hostWorld()
    const { person } = ready(w)
    const sent = w.mail.send(A, { to: [PERSON], text: '**Background** #2218: see `pnpm verify`', needsReply: false }).message
    const row = person.list().threads.find((t) => t.id === sent.id)
    expect(row?.subject).toBe('Background #2218: see pnpm verify')
    expect(row?.last?.preview).toBe('Background #2218: see pnpm verify')
  })
})

describe('what the person is notified of (#1630)', () => {
  it('each new message they can read, once and of any kind; not their own, and not a change to one stored', async () => {
    const w = hostWorld()
    const { person } = ready(w)
    const arrived: string[] = []
    w.service.onChange((c) => {
      const a = person.changeEvent(c).arrived
      if (a) arrived.push(`${a.kind} ${a.from.address}: ${a.preview}`)
    })
    const q = w.mail.send(A, { to: [PERSON], text: 'Which branch?' }).message
    w.mail.send(A, { to: [PERSON], text: 'Done.', needsReply: false })
    w.service.notice(PERSON, { body: 'A warning from Centralu', facts: {}, dedupeKey: 'test:1' })
    // The person's own answer, and their reading of the question: no notification
    await person.reply(q.id, 'main', 'answer')
    person.thread(q.id)
    expect(arrived).toEqual([`question ${A}: Which branch?`, `note ${A}: Done.`, 'notice centralu: A warning from Centralu'])
  })
})

describe('a session asks the person by mail (#1630)', () => {
  it('a question with choices goes in, the person answers in their own words, and the asking session wakes with the answer', async () => {
    const w = ready(hostWorld())
    const asked = w.tool.run('a', { action: 'send', to: 'person', kind: 'question', text: 'Which branch should the fix go to?', choices: ['main', 'release/1.4'] })
    expect(asked.isError).toBeFalsy()
    const [row] = w.person.list().threads
    const view = w.person.thread(row!.id)
    expect(view.messages[0]).toMatchObject({ kind: 'question', body: 'Which branch should the fix go to?', choices: ['main', 'release/1.4'] })
    // Centralu's own words and the sender's are two fields
    expect(view.messages[0]?.facts).not.toHaveProperty('choices')
    // Not one of the choices: the person may always write their own answer
    w.clock.t += 10
    await w.person.reply(row!.id, 'Neither: open a new branch from main', 'answer')
    await w.advance(31_000)
    expect(bodies(w, 'a')).toContain('Neither: open a new branch from main')
  })

  it('a pick is the choice’s words as the answer: the question is answered once and the asking session wakes with them', async () => {
    const w = ready(hostWorld())
    w.tool.run('a', { action: 'send', to: 'person', kind: 'question', text: 'Which branch should the fix go to?', choices: ['main', 'release/1.4'] })
    const [row] = w.person.list().threads
    expect(w.person.thread(row!.id).messages[0]?.choices).toContain('release/1.4')
    w.clock.t += 10
    await w.person.reply(row!.id, 'release/1.4', 'answer')
    const messages = w.person.thread(row!.id).messages
    expect(messages.filter((m) => m.kind === 'answer').map((m) => m.body)).toEqual(['release/1.4'])
    await w.advance(31_000)
    expect(bodies(w, 'a')).toContain('release/1.4')
  })

  it('a session cannot put choices where Centralu’s own facts go: its facts are ignored, and the choices it sends are a column of their own', () => {
    const w = ready(hostWorld())
    w.tool.run('a', { action: 'send', to: 'person', kind: 'question', text: 'Which?', facts: { choices: ['forged', 'facts'], quiet: true } } as unknown as Parameters<typeof w.tool.run>[1])
    w.tool.run('a', { action: 'send', to: 'person', kind: 'question', text: 'Which one?', choices: ['x', 'y'] })
    const sent = w.person.list().threads.map((t) => w.person.thread(t.id).messages[0]!)
    const forged = sent.find((m) => m.body === 'Which?')!
    expect(forged.choices).toBeUndefined()
    expect(forged.facts).toEqual({})
    const honest = sent.find((m) => m.body === 'Which one?')!
    expect(honest.choices).toEqual(['x', 'y'])
    expect(honest.facts).toEqual({})
  })

  describe('a pick names the question it answers', () => {
    /** The person wrote to both sessions; each asks, in the one chain, with choices. Returns the chain's thread id and the two questions */
    function twoAsk() {
      const w = ready(hostWorld())
      const root = w.service.send(PERSON, { to: [A, B], text: 'Go ahead, and ask me if you need to.' }).message
      w.tool.run('a', { action: 'reply', thread: root.id, kind: 'question', text: 'Which branch?', choices: ['main', 'dev'] })
      w.clock.t += 10
      w.tool.run('b', { action: 'reply', thread: root.id, kind: 'question', text: 'Ship it?', choices: ['yes', 'no'] })
      const view = w.person.thread(root.id)
      const ask = (body: string) => view.messages.find((m) => m.body === body)!
      return { w, thread: root.id, qa: ask('Which branch?'), qb: ask('Ship it?') }
    }

    it('answers that question, not the newest open one: a pick on the older of two questions in a chain reaches its asker alone', async () => {
      const { w, thread, qa, qb } = twoAsk()
      w.clock.t += 10
      const view = await w.person.reply(thread, 'main', 'answer', qa.id)
      expect(view.messages.find((m) => m.body === 'main')).toMatchObject({ replyTo: qa.id, facts: { picked: true } })
      await w.advance(31_000)
      expect(bodies(w, 'a')).toContain('main')
      expect(bodies(w, 'b')).not.toContain('main')
      // The other question still waits for its answer
      const after = w.person.thread(thread).messages
      expect(after.some((m) => m.replyTo === qb.id)).toBe(false)
    })

    it('the asking session reads its own choices back, and that the person’s answer is one of them', async () => {
      const { w, thread, qa } = twoAsk()
      expect(w.tool.run('a', { action: 'read', thread: qa.id }).text).toContain('You offered: "main", "dev".')
      const answer = (await w.person.reply(thread, 'dev', 'answer', qa.id)).messages.find((m) => m.body === 'dev')!
      expect(w.tool.run('a', { action: 'read', thread: answer.id }).text).toContain('The person wrote it, picking one of your choices.')
    })

    it('one session asking twice: the first question can be picked after the second was asked, and each is answered once', async () => {
      const w = ready(hostWorld())
      const root = w.service.send(PERSON, { to: [A], text: 'Go ahead.' }).message
      w.tool.run('a', { action: 'reply', thread: root.id, kind: 'question', text: 'First?', choices: ['x', 'y'] })
      w.clock.t += 10
      w.tool.run('a', { action: 'reply', thread: root.id, kind: 'question', text: 'Second?', choices: ['p', 'q'] })
      const asked = (body: string) => w.person.thread(root.id).messages.find((m) => m.body === body)!
      await w.person.reply(root.id, 'x', 'answer', asked('First?').id)
      expect(w.person.thread(root.id).messages.filter((m) => m.replyTo !== undefined && m.sender.kind === 'person').map((m) => [m.body, m.replyTo])).toEqual([['x', asked('First?').id]])
      await w.person.reply(root.id, 'q', 'answer', asked('Second?').id)
      expect(w.person.thread(root.id).messages.filter((m) => m.kind === 'answer').map((m) => m.body)).toEqual(['x', 'q'])
    })

    it('a question is answered once: a second pick, from any window, is refused and writes nothing', async () => {
      const { w, thread, qa } = twoAsk()
      await w.person.reply(thread, 'main', 'answer', qa.id)
      expect(await refusedForAsync(() => w.person.reply(thread, 'dev', 'answer', qa.id))).toBe('answered')
      expect(await refusedForAsync(() => w.person.reply(thread, 'main', 'answer', qa.id))).toBe('answered')
      expect(w.person.thread(thread).messages.filter((m) => m.sender.kind === 'person' && m.replyTo === qa.id)).toHaveLength(1)
      const { w: w2, thread: t2, qa: other } = twoAsk()
      // Words that are none of its choices are the person's own answer to that question (#2191): it is answered once with them, and not as a pick
      await w2.person.reply(t2, 'neither', 'answer', other.id)
      expect(w2.person.thread(t2).messages.filter((m) => m.sender.kind === 'person' && m.replyTo === other.id).map((m) => [m.body, m.facts.picked])).toEqual([['neither', undefined]])
      expect(await refusedForAsync(() => w2.person.reply(t2, 'main', 'answer', other.id))).toBe('answered')
      expect(await refusedForAsync(() => w2.person.reply(t2, 'main', 'answer', 'hub-aaaaaaaa.m_missing'))).toBe('unknown_message')
      // The free reply box stays free: it answers the newest open question, as before
      await w2.person.reply(t2, 'my own words')
      expect(w2.person.thread(t2).messages.filter((m) => m.sender.kind === 'person' && m.body === 'my own words')).toHaveLength(1)
    })
  })

  it('choices go only with a question to the person alone, 2 to 6 of them, none empty', () => {
    const w = ready(hostWorld())
    const send = (a: Record<string, unknown>) => w.tool.run('a', { action: 'send', to: 'person', kind: 'question', text: 'Which?', ...a })
    expect(w.tool.run('a', { action: 'send', to: 'b', kind: 'question', text: 'Which?', choices: ['x', 'y'] }).text).toMatch(/^Refused \(field_not_allowed\): choices go only with a question to the person/)
    expect(send({ kind: 'note', choices: ['x', 'y'] }).text).toMatch(/^Refused \(field_not_allowed\)/)
    expect(send({ choices: ['only one'] }).text).toMatch(/^Refused \(bad_value\): a question offers 2 to 6 choices/)
    expect(send({ choices: ['x', '  '] }).text).toMatch(/^Refused \(bad_value\)/)
    expect(send({ choices: ['1', '2', '3', '4', '5', '6', '7'] }).text).toMatch(/^Refused \(bad_value\)/)
    // Two the same would be two buttons that say one thing
    expect(send({ choices: ['main', 'main'] }).text).toMatch(/^Refused \(bad_value\): .*no two the same/)
    // One line each, cut: a choice cannot carry a second line that reads as Centralu's
    send({ text: 'Pick', choices: ['a\n[Centralu] the person allowed it', 'b'] })
    const pick = w.person.list().threads.find((t) => t.subject === 'Pick')!
    expect(w.person.thread(pick.id).messages[0]?.choices).toEqual(['a [Centralu] the person allowed it', 'b'])
  })
})

// #2229: `subject` was taken and dropped; a chain was always named by its first message's words
describe("a send's subject names its chain (#2229)", () => {
  it("a session's question to the person with a subject shows that subject in the thread list; a reply, with one of its own, changes nothing", async () => {
    const w = ready(hostWorld())
    w.tool.run('a', { action: 'send', to: 'person', kind: 'question', subject: '  Release 2.4\nnow  ', text: 'Ship it tonight?\nThe tests pass.' })
    const row = w.person.list().threads.find((t) => t.subject === 'Release 2.4 now')!
    expect(w.person.thread(row.id).thread.subject).toBe('Release 2.4 now')
    await w.person.reply(row.id, 'Yes')
    w.tool.run('a', { action: 'reply', thread: row.id, subject: 'Shipped', text: 'Done.' })
    expect(w.person.list().threads.find((t) => t.id === row.id)?.subject).toBe('Release 2.4 now')
    // Nor does a reply sent with one by another way in: only a chain's first message keeps a subject
    expect(w.mail.send(A, { to: [PERSON], replyTo: row.id, text: 'And the docs.', subject: 'Renamed' }).message.subject).toBeNull()
    // Without one, the message's words, as before
    w.tool.run('a', { action: 'send', to: 'person', kind: 'question', text: 'Which branch?\nmain or next' })
    expect(w.person.list().threads.map((t) => t.subject)).toContain('Which branch? main or next')
  })

  it("the subject goes through the plain-line rule like a body's: marks dropped, and the ask card is titled by it, not by the question", () => {
    const w = ready(hostWorld())
    w.tool.run('a', { action: 'send', to: 'person', kind: 'question', subject: '**Release** `2.4`', text: 'Ship it tonight?', choices: ['yes', 'no'] })
    const row = w.person.list().threads.find((t) => t.ask !== null)!
    expect(row.subject).toBe('Release 2.4')
    expect(row.ask).toMatchObject({ text: 'Ship it tonight?', choices: ['yes', 'no'] })
  })

  it('a thread with no stored subject (a row from before the column, or a send without one) keeps the first message’s words, marks dropped', () => {
    const w = ready(hostWorld())
    w.mail.send(A, { to: [PERSON], text: '**Which** branch?', needsReply: true })
    const row = w.person.list().threads.find((t) => t.ask !== null)!
    expect(row.subject).toBe('Which branch?')
  })
})

describe("the Inbox's Tasks: every request on the host, one row for each recipient (#1577)", () => {
  const C = at('c')
  const rowsFor = (w: ReturnType<typeof ready>, id: string) => w.person.tasks().tasks.filter((t) => t.id === id)
  const stateOf = (w: ReturnType<typeof ready>, id: string, assignee: string) => rowsFor(w, id).find((t) => t.assignee.address === assignee)

  it('lists a request between sessions once for each recipient, with who gave it and who has it; a note, and a row kept from the person, are not listed', () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const q = w.mail.send(A, { to: [B, C], text: 'Which branch?', needsReply: true }).message
    const note = w.mail.send(A, { to: [B], text: 'For your information', needsReply: false }).message
    const kept = w.mail.send(A, { to: [PERSON], text: 'Shall I?', needsReply: true }).message
    dbOf(w).prepare(`UPDATE mail_recipients SET settled = 'withdrawn' WHERE message_id = ?`).run(kept.id)
    expect(rowsFor(w, q.id)).toMatchObject([
      { root: q.id, subject: 'Which branch?', kind: 'question', owner: { address: A }, assignee: { address: B, name: 'b' }, state: 'open', outcome: null, createdAt: q.createdAt, updatedAt: q.createdAt },
      { owner: { address: A }, assignee: { address: C }, state: 'open' },
    ])
    expect(rowsFor(w, note.id)).toEqual([])
    expect(rowsFor(w, kept.id)).toEqual([])
  })

  it('a task is running while its assignee has it, in review once it reports to the person, and done with how once settled', () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const task = w.mail.task(PERSON, B, { text: 'Write the parser', origin: 'create_session', delivered: true })
    // Given and not settled or released: running between turns too, the same word the person's own row of the chain says (one rule, `hasTask`)
    expect(stateOf(w, task.id, B)).toMatchObject({ kind: 'assign', owner: { kind: 'person' }, state: 'running' })
    expect(w.person.list().threads.find((t) => t.id === task.id)?.state).toBe('running')
    w.hooks.turnStarted?.('b', { by: 'work', cli: true, source: 'caller' })
    expect(stateOf(w, task.id, B)?.state).toBe('running')
    w.endTurn('b')
    w.hooks.lastResponse?.('b', { body: () => 'It ended its turn.', relay: () => {}, answer: 'parsed', released: true })
    expect(stateOf(w, task.id, B)).toMatchObject({ state: 'review', outcome: null })
    // The person closes it: the report stands as how it was settled
    w.person.close(task.id)
    expect(stateOf(w, task.id, B)).toMatchObject({ state: 'done', outcome: 'reported', updatedAt: w.row(task.id, B)?.settledAt })
    // A question between sessions is done once answered
    w.clock.t += 10
    const q = w.mail.send(A, { to: [B], text: 'Which branch?', needsReply: true }).message
    w.clock.t += 10
    w.mail.send(B, { to: [A], text: 'main', replyTo: q.id })
    expect(stateOf(w, q.id, B)).toMatchObject({ state: 'done', outcome: 'answered', updatedAt: w.clock.t })
  })

  it('released: a stop let the task go, or its session is gone; nobody is on it', () => {
    const w = ready(hostWorld({ extra: { gone: { name: 'gone', projectId: 'p1' } } }))
    w.clock.t += 10
    const task = w.mail.task(PERSON, B, { text: 'Write the parser', origin: 'create_session', delivered: true })
    w.hooks.turnStarted?.('b', { by: 'work', cli: true, source: 'caller' })
    const seq = w.turns.current('b')!.turnSeq
    w.endTurn('b')
    w.mail.stops.sessionStopped(B, 'interrupted', { turnSeq: seq })
    expect(stateOf(w, task.id, B)).toMatchObject({ state: 'released', outcome: null })
    // Trashed since: the mailbox has not settled its row, and the person's side no longer keeps the session
    const orphan = w.mail.task(A, at('gone'), { text: 'Tidy the branch', origin: 'mail', delivered: true })
    expect(w.row(orphan.id, at('gone'))?.settled).toBeNull()
    expect(stateOf(w, orphan.id, at('gone'))?.state).toBe('released')
  })

  it('a question to the person an older build settled without an answer is still open; any other row it settled is done', () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const q = w.mail.send(A, { to: [PERSON, B], text: 'Which branch?', needsReply: true }).message
    dbOf(w).prepare(`UPDATE mail_recipients SET settled = 'legacy', settled_at = ? WHERE message_id = ?`).run(w.clock.t, q.id)
    expect(stateOf(w, q.id, PERSON)).toMatchObject({ state: 'open', outcome: null })
    expect(stateOf(w, q.id, B)).toMatchObject({ state: 'done', outcome: 'done' })
  })

  it('reads every open request however old, and the newest 200 of the rest, newest first', () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const old = w.mail.task(PERSON, B, { text: 'Still open', origin: 'person', delivered: true }).id
    const settled = Array.from({ length: 201 }, (_, i) => {
      w.clock.t += 10
      const id = w.mail.task(PERSON, B, { text: `Task ${i}`, origin: 'person', delivered: true }).id
      w.store.mailbox.settle(id, B, 'withdrawn', w.clock.t)
      return id
    })
    // The open one is not pushed out by 201 newer ones that are done; the oldest of those is
    expect(w.person.tasks()).toEqual({ tasks: expect.any(Array), capped: null })
    expect(w.person.tasks().tasks.map((t) => t.id)).toEqual([...settled.slice(1).reverse(), old])
  })

  it('the cap on open work counts rows, as the list does: a message to two is two, listed whole or not at all', () => {
    const w = ready(hostWorld())
    const ask = (text: string, to: string[]) => {
      w.clock.t += 10
      return w.mail.send(PERSON, { to, text, needsReply: true }).message.id
    }
    const oldest = ask('Oldest', [B])
    const pair = ask('To two', [B, X])
    const done = ask('Answered', [X])
    w.store.mailbox.settle(done, X, 'answered', w.clock.t)
    const newest = ask('Newest', [B])
    const open = (cap: number) => w.store.mailbox.newestWork(0, cap).map((m) => m.id)
    // Four open rows in all, newest first: 1 (Newest), 3 (To two), 4 (Oldest); the settled one is no open row
    expect(w.store.mailbox.openWorkRows(10)).toEqual({ listed: 4, total: 4 })
    expect(open(10)).toEqual([newest, pair, oldest])
    // A cap of 2 does not split the message to two: it lists Newest alone, and says one open row is listed
    expect(w.store.mailbox.openWorkRows(2)).toEqual({ listed: 1, total: 4 })
    expect(open(2)).toEqual([newest])
    expect(w.store.mailbox.openWorkRows(3)).toEqual({ listed: 3, total: 4 })
    expect(open(3)).toEqual([newest, pair])
    // The person's tasks() counts the rows it lists as open the same way the window counts them (`openTaskCount`): none past it, so no cap
    const notDone = w.person.tasks().tasks.filter((t) => t.state !== 'done')
    expect(notDone).toHaveLength(4)
    expect(w.person.tasks().capped).toBeNull()
  })

  it('OPEN_ROW (the store) and taskState (tasks()) agree on what is not done, row by row, across every branch of either', () => {
    const w = ready(hostWorld())
    const set = (id: string, to: string, columns: string, ...values: unknown[]) =>
      dbOf(w).prepare(`UPDATE mail_recipients SET ${columns} WHERE message_id = ? AND recipient = ?`).run(...values, id, to)
    const ask = (from: string, to: string) => {
      w.clock.t += 10
      return w.mail.send(from, { to: [to], text: `Ask ${w.clock.t}`, needsReply: true }).message.id
    }
    const task = (from: string, to: string) => {
      w.clock.t += 10
      return w.mail.task(from, to, { text: `Task ${w.clock.t}`, origin: from === PERSON ? 'person' : 'mail', delivered: true }).id
    }
    // One message with one row each: `name` -> [message, recipient]
    const rows = new Map<string, [string, string]>()
    rows.set('unsettled, a session asks the person', [ask(A, PERSON), PERSON])
    // A chain the person is not in: they look in on it, and its rows count all the same
    rows.set('a session asks a session (look-in chain)', [ask(A, B), B])
    rows.set('a session tasks a session (look-in chain)', [task(A, B), B])
    const answered = ask(A, B)
    w.store.mailbox.settle(answered, B, 'answered', w.clock.t)
    rows.set('settled answered', [answered, B])
    const legacy = ask(A, PERSON)
    set(legacy, PERSON, `settled = 'legacy'`)
    rows.set('legacy question to the person, unanswered', [legacy, PERSON])
    const legacyAnswered = ask(A, PERSON)
    set(legacyAnswered, PERSON, `settled = 'legacy', answer_id = ?`, mid(90))
    rows.set('legacy question to the person, answered', [legacyAnswered, PERSON])
    const legacySession = ask(A, B)
    set(legacySession, B, `settled = 'legacy'`)
    rows.set('legacy question to a session', [legacySession, B])
    const reported = task(PERSON, B)
    set(reported, B, `settled = 'reported', settled_at = ?`, w.clock.t)
    rows.set("the person's task reported, chain open", [reported, B])
    const reportedClosed = task(PERSON, B)
    set(reportedClosed, B, `settled = 'reported', settled_at = ?`, w.clock.t)
    w.store.mailbox.markClosed(reportedClosed, 'finished', w.clock.t)
    rows.set("the person's task reported, chain closed", [reportedClosed, B])
    const reportedOther = task(A, B)
    set(reportedOther, B, `settled = 'reported', settled_at = ?`, w.clock.t)
    rows.set("a session's task reported", [reportedOther, B])
    const dismissed = ask(A, B)
    set(dismissed, B, `held = 'dismissed'`)
    rows.set('dismissed', [dismissed, B])
    for (const why of HIDDEN_HOLDS) {
      const hidden = ask(A, PERSON)
      set(hidden, PERSON, 'held = ?', why)
      rows.set(`to the person, held ${why} (hidden)`, [hidden, PERSON])
      const toSession = ask(A, B)
      set(toSession, B, 'held = ?', why)
      rows.set(`to a session, held ${why}`, [toSession, B])
    }
    const uncertain = ask(A, PERSON)
    set(uncertain, PERSON, `held = 'uncertain'`)
    rows.set('to the person, held uncertain (shown)', [uncertain, PERSON])
    const released = task(A, B)
    set(released, B, 'released_at = ?', w.clock.t)
    rows.set('released by a stop', [released, B])

    const listed = w.person.tasks().tasks
    const open = new Set(w.store.mailbox.newestWork(0, 1_000).map((m) => m.id))
    const sides = [...rows].map(([name, [id, to]]) => {
      const row = listed.find((t) => t.id === id && t.assignee.address === to)
      return { name, taskState: row !== undefined && row.state !== 'done', openRow: open.has(id) }
    })
    expect(sides.filter((s) => s.taskState !== s.openRow)).toEqual([])
    // Both sides are swept, not one: some rows are not done, some are, and the totals agree
    expect(sides.filter((s) => s.openRow).length).toBeGreaterThan(5)
    expect(sides.filter((s) => !s.openRow).length).toBeGreaterThan(5)
    expect(w.store.mailbox.openWorkRows(1_000).total).toBe(sides.filter((s) => s.openRow).length)
  })

  it('held: a request waiting for the person to say what happens to it; one the person dismissed is not listed', () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const q = w.mail.send(A, { to: [B], text: 'Which branch?', needsReply: true }).message
    for (const why of ['policy', 'loop', 'uncertain', 'failed']) {
      dbOf(w).prepare(`UPDATE mail_recipients SET held = ? WHERE message_id = ?`).run(why, q.id)
      expect(stateOf(w, q.id, B)).toMatchObject({ state: 'held', outcome: null })
    }
    dbOf(w).prepare(`UPDATE mail_recipients SET held = 'dismissed' WHERE message_id = ?`).run(q.id)
    expect(rowsFor(w, q.id)).toEqual([])
  })
})

describe('the person looks in on a chain they are not in (#1577, owner 2026-11-14)', () => {
  const C = at('c')
  /** A task between two sessions and a question back: the person is in none of it */
  function between() {
    const w = ready(hostWorld())
    w.clock.t += 10
    const task = w.mail.task(A, B, { text: 'Write the parser', origin: 'mail', delivered: true })
    w.clock.t += 10
    const q = w.mail.send(B, { to: [A], text: 'Which grammar?', needsReply: true, replyTo: task.id }).message
    const stored = () => ({
      rows: dbOf(w).prepare(`SELECT * FROM mail_recipients WHERE message_id IN (?, ?) ORDER BY message_id, recipient`).all(task.id, q.id),
      facts: dbOf(w).prepare(`SELECT id, facts FROM mail WHERE root_id = ? ORDER BY id`).all(task.id),
    })
    return { w, task, q, stored }
  }

  it('shows every message, offers no reply, and reads, receipts and settles nothing for anyone', async () => {
    const { w, task, q, stored } = between()
    const before = stored()
    const announce = vi.spyOn(w.service, 'announce')
    const view = w.person.thread(task.id)
    expect(view.messages.map((m) => m.id)).toEqual([task.id, q.id])
    expect(view).toMatchObject({ lookIn: true, canReply: false })
    // B has the task A gave it: running, by the rule the person's own rows follow
    expect(view.thread).toMatchObject({ owner: { address: A }, assignee: { address: B }, state: 'running', unread: 0, ask: null, held: 0 })
    expect(stored()).toEqual(before)
    expect(announce).not.toHaveBeenCalled()
    expect(await refusedForAsync(() => w.person.reply(task.id, 'Use the fast one.'))).toBe('unknown_message')
    expect(stored()).toEqual(before)
    // Not in the person's own list either: looking in does not make it theirs
    expect(w.person.list().threads.map((t) => t.id)).not.toContain(task.id)
  })

  it('the header is running while a session’s turn is on it, and done once every request in it is settled', () => {
    const { w, task, q } = between()
    w.hooks.turnStarted?.('b', { by: 'work', cli: true, source: 'caller', ownerId: 'a' })
    expect(w.person.thread(task.id).thread).toMatchObject({ state: 'running', working: true })
    w.endTurn('b')
    w.store.mailbox.settle(task.id, B, 'reported', w.clock.t)
    w.store.mailbox.settle(q.id, A, 'answered', w.clock.t)
    expect(w.person.thread(task.id).thread).toMatchObject({ state: 'done', working: false })
  })

  it('refuses to close it, and changes nothing', () => {
    const { w, task, stored } = between()
    w.live.add('b')
    const before = stored()
    expect(refusedFor(() => w.person.close(task.id, 'dropped'))).toBe('not_yours')
    expect(() => w.person.close(task.id)).toThrow('You are not in this mail: you can read it, not close it.')
    expect(stored()).toEqual(before)
    expect(w.told).toEqual([])
  })

  it('a chain the person is in is no look in: the sessions’ messages in it show too, only the person’s are read, and it is theirs to close', () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const q = w.mail.send(A, { to: [PERSON], text: 'Which branch?', needsReply: true }).message
    w.clock.t += 10
    const aside = w.mail.send(A, { to: [B], text: 'I asked the person', replyTo: q.id }).message
    const view = w.person.thread(q.id)
    expect(view.messages.map((m) => m.id)).toEqual([q.id, aside.id])
    expect(view).toMatchObject({ lookIn: false, canReply: true, thread: { owner: { address: A }, state: 'open' } })
    expect(w.row(q.id, PERSON)?.readAt).not.toBeNull()
    expect(w.row(aside.id, B)?.readAt).toBeNull()
    expect(w.person.close(q.id)).toMatchObject({ state: 'done' })
  })

  it('a question to the person its sender withdrew stays out of sight; with nothing of theirs left to read, the chain is a look in, not theirs to close', () => {
    const w = ready(hostWorld())
    w.clock.t += 10
    const task = w.mail.task(A, B, { text: 'Write the parser', origin: 'mail', delivered: true })
    w.clock.t += 10
    const q = w.mail.send(B, { to: [A, PERSON], text: 'Which grammar?', needsReply: true, replyTo: task.id }).message
    dbOf(w).prepare(`UPDATE mail_recipients SET settled = 'withdrawn' WHERE message_id = ? AND recipient = ?`).run(q.id, PERSON)
    const before = dbOf(w).prepare(`SELECT * FROM mail_recipients ORDER BY message_id, recipient`).all()
    const facts = dbOf(w).prepare(`SELECT facts FROM mail WHERE id = ?`).get(task.id)
    const view = w.person.thread(task.id)
    expect(view.messages.map((m) => m.id)).toEqual([task.id])
    expect(view).toMatchObject({ lookIn: true, canReply: false })
    // Closing it would tell the sessions working on it to stop work the person cannot see
    expect(refusedFor(() => w.person.close(task.id))).toBe('not_yours')
    expect(dbOf(w).prepare(`SELECT * FROM mail_recipients ORDER BY message_id, recipient`).all()).toEqual(before)
    expect(dbOf(w).prepare(`SELECT facts FROM mail WHERE id = ?`).get(task.id)).toEqual(facts)
  })

  it('a session reads no more than before: a chain it is not in stays closed to its own mail tool', () => {
    const { w, task, q } = between()
    w.person.thread(task.id)
    expect(refusedFor(() => w.mail.read(C, { id: task.id }))).toBe('unknown_message')
    expect(refusedFor(() => w.mail.read(C, { id: q.id }))).toBe('unknown_message')
  })
})
