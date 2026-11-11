/**
 * `MailboxRecords`, the v65 tables' queries (docs/plans/mailbox.md §5, §6, M1). Nothing reads them yet; these tests
 * hold the semantics the message service (M2) is built on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { Store } from './store.js'
import { MailConflict, MailTargetMissing, type MailFacts, type MailboxRecords, type NewMail, type NewRecipient } from './store/mailbox.js'
import { turnsOf } from './store/mailbox-turns.test-helpers.js'

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000
const A = 'session:h1/a'
const B = 'session:h1/b'
const C = 'session:h1/c'
const ORC = 'session:h1/orc'

afterEach(() => {
  vi.restoreAllMocks()
})

let n = 0
function mail(over: Partial<NewMail> & { sender: string }): NewMail {
  n += 1
  return {
    id: `h1.m_${String(n).padStart(4, '0')}`,
    senderProject: null,
    kind: 'message',
    needsReply: false,
    replyTo: null,
    causeId: null,
    depth: 0,
    urgent: false,
    body: `body ${n}`,
    facts: {},
    choices: null,
    dedupeKey: null,
    origin: 'mail',
    legacyThread: null,
    createdAt: NOW + n,
    ...over,
  }
}
function must<T>(x: T | undefined): T {
  if (x === undefined) throw new Error('missing')
  return x
}
const to = (recipient: string, over: Partial<NewRecipient> = {}): NewRecipient => ({ recipient, dueAt: NOW, ...over })

function world(): { store: Store; box: MailboxRecords; send: (over: Partial<NewMail> & { sender: string }, ...recipients: (string | NewRecipient)[]) => string; db: Database.Database } {
  const store = new Store()
  const box = store.mailbox
  const send = (over: Partial<NewMail> & { sender: string }, ...recipients: (string | NewRecipient)[]) =>
    box.insert(
      mail(over),
      recipients.map((r) => (typeof r === 'string' ? to(r) : r)),
    ).id
  return { store, box, send, db: (store as unknown as { db: Database.Database }).db }
}

describe('writing and the chain', () => {
  it('the root is the reply target’s root', () => {
    const { box, send } = world()
    const first = send({ sender: A, needsReply: true }, B)
    const second = send({ sender: B, replyTo: first }, A)
    const third = send({ sender: A, replyTo: second }, B)
    expect([first, second, third].map((id) => box.message(id)?.rootId)).toEqual([first, first, first])
    expect(() => box.insert(mail({ sender: A, replyTo: 'h1.m_missing' }), [to(B)])).toThrow(MailTargetMissing)
    const forwarded = box.insert(mail({ sender: A, replyTo: 'h2.m_elsewhere', rootId: 'h2.m_root' }), [to(B)])
    expect(box.message(forwarded.id)).toMatchObject({ replyTo: 'h2.m_elsewhere', rootId: 'h2.m_root' })
  })

  it('chain walks back and stops at the root', () => {
    const { box, send } = world()
    const ids = [send({ sender: A }, B)]
    for (let i = 1; i < 12; i++) ids.push(send({ sender: i % 2 ? B : A, replyTo: ids[i - 1] }, i % 2 ? A : B))
    const last = ids.at(-1) ?? ''
    expect(box.chain(last, 9).map((m) => m.id)).toEqual(ids.slice(2, 11).reverse())
    expect(box.chain(ids[2] ?? '', 9).map((m) => m.id)).toEqual([ids[1], ids[0]])
    expect(box.chain(ids[0] ?? '', 9)).toEqual([])
  })

  it('in any reply tree, each root is the first message of the chain, and the chain reaches it', () => {
    // Seeded random trees: a failing seed can be run again
    for (let seed = 1; seed <= 25; seed++) {
      let s = seed
      const random = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648)
      const { box, send } = world()
      const ids: string[] = []
      for (let i = 0; i < 30; i++) {
        const target = ids.length > 0 && random() < 0.7 ? ids[Math.floor(random() * ids.length)] : null
        ids.push(send({ sender: random() < 0.5 ? A : B, replyTo: target }, random() < 0.5 ? A : C))
      }
      for (const id of ids) {
        const chain = box.chain(id, 100)
        const top = chain.at(-1) ?? box.message(id)
        expect(top?.replyTo, `seed ${seed}`).toBeNull()
        expect(box.message(id)?.rootId, `seed ${seed}`).toBe(top?.id)
        expect(new Set(chain.map((m) => m.rootId)), `seed ${seed}`).toEqual(new Set(chain.length ? [top?.id] : []))
      }
    }
  })

  it('dedupe is unique per sender and a repeat returns the stored row', () => {
    const { box } = world()
    const first = box.insert(mail({ sender: 'centralu', dedupeKey: 'report:x:1', body: 'first' }), [to(A)])
    const other = box.insert(mail({ sender: A, dedupeKey: 'report:x:1', body: 'other sender' }), [to(B)])
    const again = box.insert(mail({ sender: 'centralu', dedupeKey: 'report:x:1', body: 'second' }), [to(C)])
    expect(first.duplicate).toBe(false)
    expect(other).toMatchObject({ duplicate: false, body: 'other sender' })
    expect(again).toMatchObject({ duplicate: true, id: first.id, body: 'first' })
    expect(box.recipients(first.id).map((r) => r.recipient)).toEqual([A])
    // No key: never a duplicate
    expect(box.insert(mail({ sender: A }), [to(B)]).duplicate).toBe(false)
    expect(box.insert(mail({ sender: A }), [to(B)]).duplicate).toBe(false)
  })

  it('reads a kind, a settled word or a release reason it does not know as a default, and facts that do not read as empty, key by key, logged once', () => {
    const { box, send, db } = world()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const a = send({ sender: A }, B)
    const b = send({ sender: A }, B)
    db.prepare(`UPDATE mail SET kind = 'proposal', facts = '{"outcome":"exploded","quiet":true}' WHERE id = ?`).run(a)
    db.prepare(`UPDATE mail SET facts = 'not json' WHERE id = ?`).run(b)
    db.prepare(`UPDATE mail_recipients SET settled = 'archived', released_why = 'bored', released_at = 1 WHERE message_id = ?`).run(a)
    expect(box.message(a)).toMatchObject({ kind: 'notice', facts: { quiet: true } })
    expect(box.message(a)?.facts.outcome).toBeUndefined()
    expect(box.message(b)?.facts).toEqual({})
    expect(box.message(b)?.facts).toEqual({})
    expect(box.recipient(a, B)).toMatchObject({ settled: 'legacy', releasedWhy: null })
    expect(warn).toHaveBeenCalledTimes(1)
    // A key a newer build added is kept
    db.prepare(`UPDATE mail SET facts = '{"quiet":true,"newer":{"x":1}}' WHERE id = ?`).run(b)
    expect(box.message(b)?.facts).toEqual({ quiet: true, newer: { x: 1 } })
  })
})

describe('reading', () => {
  it('byRoot pages oldest first; feedOf lists to and from an address newest first; reportsOn and newestTask', () => {
    const { box, send } = world()
    const root = send({ sender: A }, B)
    const r1 = send({ sender: B, replyTo: root }, A)
    const r2 = send({ sender: A, replyTo: r1 }, B)
    const other = send({ sender: C }, B)
    expect(box.byRoot(root, { limit: 2 }).map((m) => m.id)).toEqual([r1, r2])
    expect(box.byRoot(root, { before: r1, limit: 5 }).map((m) => m.id)).toEqual([root])
    expect(box.feedOf(A, { limit: 10 }).map((m) => m.id)).toEqual([r2, r1, root])
    expect(box.feedOf(B, { limit: 2, before: other }).map((m) => m.id)).toEqual([r2, r1])

    const task1 = send({ sender: A, kind: 'task' }, B)
    const task2 = send({ sender: A, kind: 'task' }, B)
    const rep1 = send({ sender: 'centralu', kind: 'report', replyTo: task1, facts: { outcome: 'paused' } }, A)
    const rep2 = send({ sender: 'centralu', kind: 'report', replyTo: task1, facts: { outcome: 'finished' } }, A)
    send({ sender: B, replyTo: task1 }, A)
    expect(box.reportsOn(task1).map((m) => m.id)).toEqual([rep1, rep2])
    expect(box.newestTask(A, B)?.id).toBe(task2)
    box.settle(task2, B, 'reported', NOW)
    expect(box.newestTask(A, B)?.id).toBe(task1)
    expect(box.newestTask(B, A)).toBeUndefined()
  })
})

describe('delivery', () => {
  it('pendingFor lists what may be delivered, oldest first; due, held, read, withdrawn and gone rows are not', () => {
    const { box, send } = world()
    const ids = [send({ sender: A }, B), send({ sender: A }, to(B, { dueAt: NOW + 1000 })), send({ sender: A }, to(B, { held: 'policy' })), send({ sender: A }, B), send({ sender: A, needsReply: true }, B), send({ sender: A, needsReply: true }, B)]
    box.markRead(B, [ids[3] ?? ''], NOW)
    box.settle(ids[4] ?? '', B, 'withdrawn', NOW)
    box.settle(ids[5] ?? '', B, 'gone', NOW)
    expect(box.pendingFor(B, NOW).map((p) => p.message.id)).toEqual([ids[0]])
    expect(box.pendingFor(B, NOW + 1000).map((p) => p.message.id)).toEqual([ids[0], ids[1]])
    expect(box.dueRecipients()).toEqual([B])
    expect(box.hasDue(B, NOW)).toBe(true)
    expect(box.nextDue(B, NOW)).toBe(NOW + 1000)

    box.markAttempt(B, [ids[0] ?? ''], NOW)
    expect(box.interrupted().map((r) => r.messageId)).toEqual([ids[0]])
    box.markDelivered(B, [ids[0] ?? ''], NOW, 7)
    expect(box.recipient(ids[0] ?? '', B)).toMatchObject({ deliveredAt: NOW, turnSeq: 7, attempts: 1 })
    expect(box.pendingFor(B, NOW).map((p) => p.message.id)).toEqual([])
    expect(box.pendingFor(B, NOW, true).map((p) => p.message.id)).toEqual([ids[0]])
    expect(box.undeliver(B, [ids[0] ?? ''], NOW)).toEqual([ids[0]])
    expect(box.recipient(ids[0] ?? '', B)).toMatchObject({ deliveredAt: null, turnSeq: null })
  })

  it('the person’s release lets a policy hold go as released and clears the others; dismiss holds against no one', () => {
    const { box, send } = world()
    const pol = send({ sender: A }, to(B, { held: 'policy' }))
    const unsure = send({ sender: A }, B)
    box.markUncertain(B, [unsure])
    const failed = send({ sender: A }, B)
    box.hold(B, [failed], 'failed')
    expect(box.heldRows().map((r) => r.messageId)).toEqual([pol, unsure, failed])
    expect(box.heldPolicy()).toEqual([{ row: expect.objectContaining({ messageId: pol }), senderProject: null }])
    expect(box.release(B, [pol, unsure], NOW + 5)).toBe(2)
    expect(box.recipient(pol, B)).toMatchObject({ held: 'released', dueAt: NOW + 5 })
    expect(box.recipient(unsure, B)?.held).toBeNull()
    expect(box.dismiss(B, [failed])).toBe(1)
    expect(box.recipient(failed, B)?.held).toBe('dismissed')
    expect(box.heldRows()).toEqual([])
    box.failedTry(B, [unsure], 'busy', NOW + 9)
    expect(box.recipient(unsure, B)).toMatchObject({ lastError: 'busy', dueAt: NOW + 9 })
    box.markAttempt(B, [unsure], NOW)
    box.takeBack(B, [unsure])
    expect(box.recipient(unsure, B)).toMatchObject({ attemptAt: null, attempts: 0 })
  })

  it('deleteHeld drops policy rows and a message left with none', () => {
    const { box, send } = world()
    const both = send({ sender: A }, to(B, { held: 'policy' }), to(C, { held: 'policy' }))
    const one = send({ sender: A }, to(B, { held: 'policy' }), C)
    expect(box.deleteHeld([{ messageId: both, recipient: B }, { messageId: both, recipient: C }, { messageId: one, recipient: B }, { messageId: one, recipient: C }])).toBe(3)
    expect(box.message(both)).toBeUndefined()
    expect(box.recipients(one).map((r) => r.recipient)).toEqual([C])
  })
})

describe('settling and waiting', () => {
  it('only needsReply messages and tasks are watched and settled; a held answer keeps the row open until dropped', () => {
    const { box, send } = world()
    const plain = send({ sender: A }, B)
    const ask = send({ sender: A, needsReply: true }, B, C)
    const task = send({ sender: A, kind: 'task' }, C)
    expect(box.settle(plain, B, 'done', NOW)).toBe(0)
    expect(box.watchedFrom(A).map((r) => `${r.messageId}>${r.recipient}`)).toEqual([`${ask}>${B}`, `${ask}>${C}`, `${task}>${C}`])
    expect(box.watchedTo(C).map((r) => r.messageId)).toEqual([ask, task])

    box.answerHeld(ask, B, 'h1.m_answer')
    expect(box.recipient(ask, B)).toMatchObject({ settled: null, answerId: 'h1.m_answer' })
    expect(box.answerDropped('h1.m_answer')).toBe(1)
    expect(box.recipient(ask, B)?.answerId).toBeNull()
    expect(box.settle(ask, B, 'answered', NOW, 'h1.m_answer2')).toBe(1)
    expect(box.settle(ask, B, 'done', NOW)).toBe(0)
    expect(box.recipient(ask, B)).toMatchObject({ settled: 'answered', settledAt: NOW, answerId: 'h1.m_answer2' })
    expect(box.settle(ask, 'all', 'withdrawn', NOW)).toBe(1)
    expect(box.watchedFrom(A).map((r) => r.messageId)).toEqual([task])
  })

  it('markReleased writes once, and releasedUntold lists a row until markTold', () => {
    const { box, send } = world()
    const ask = send({ sender: A, needsReply: true }, B, C)
    expect(box.markReleased(ask, B, NOW, 'waited')).toBe(true)
    expect(box.markReleased(ask, B, NOW + 1, 'reminders')).toBe(false)
    expect(box.recipient(ask, B)).toMatchObject({ releasedAt: NOW, releasedWhy: 'waited' })
    expect(box.releasedUntold(A).map((r) => r.recipient)).toEqual([B])
    box.markTold([{ messageId: ask, recipient: B }], NOW + 2)
    expect(box.releasedUntold(A)).toEqual([])
    expect(box.recipient(ask, B)?.toldAt).toBe(NOW + 2)
  })
})

describe('covering (§10.3)', () => {
  it('finds a watched row sent after the row was delivered with the delivery turn’s starter or no cause as its cause, and not one sent before, with another cause, settled, held or released', () => {
    const { box, send, db } = world()
    db.prepare(`INSERT INTO mail_turns (session_id, turn_seq, started_by, started_at, starter_id) VALUES ('b', 3, 'mail', ?, 'h1.m_start')`).run(NOW)
    const before = send({ sender: B, needsReply: true, createdAt: NOW - 10 }, C)
    const r = send({ sender: A, needsReply: true, createdAt: NOW }, B)
    box.markDelivered(B, [r], NOW, 3)
    const row = () => must(box.recipient(r, B))
    const owes = () => true
    expect(before).toBeTruthy()
    const other = send({ sender: B, needsReply: true, causeId: 'h1.m_other', createdAt: NOW + 1 }, C)
    const plain = send({ sender: B, causeId: 'h1.m_start', createdAt: NOW + 2 }, C)
    const held = send({ sender: B, needsReply: true, causeId: 'h1.m_start', createdAt: NOW + 3 }, to(C, { held: 'policy' }))
    expect([other, plain, held]).toHaveLength(3)
    expect(box.covering(row(), owes)).toBeNull()

    const started = send({ sender: B, needsReply: true, causeId: 'h1.m_start', createdAt: NOW + 4 }, C)
    expect(box.covering(row(), owes)?.messageId).toBe(started)
    box.settle(started, C, 'answered', NOW + 5)
    expect(box.covering(row(), owes)).toBeNull()
    const own = send({ sender: B, needsReply: true, createdAt: NOW + 6 }, C)
    expect(box.covering(row(), owes)?.messageId).toBe(own)
    box.markReleased(own, C, NOW + 7, 'waited')
    expect(box.covering(row(), owes)).toBeNull()

    // A task covers only while it is owed
    const task = send({ sender: B, kind: 'task', causeId: 'h1.m_start', createdAt: NOW + 8 }, C)
    expect(box.covering(row(), () => false)).toBeNull()
    expect(box.covering(row(), (owner, child) => owner === B && child === C)?.messageId).toBe(task)

    // A row delivered outside a turn is covered by a send with no cause only
    const quiet = send({ sender: A, needsReply: true, createdAt: NOW + 9 }, B)
    box.markDelivered(B, [quiet], NOW + 9, null)
    box.settle(task, C, 'reported', NOW + 10)
    send({ sender: B, needsReply: true, causeId: 'h1.m_start', createdAt: NOW + 11 }, C)
    expect(box.covering(must(box.recipient(quiet, B)), owes)).toBeNull()
    const free = send({ sender: B, needsReply: true, createdAt: NOW + 12 }, C)
    expect(box.covering(must(box.recipient(quiet, B)), owes)?.messageId).toBe(free)
  })
})

describe('guards and counts', () => {
  it('pairTurnsSince counts turns both ways by address, only those a session’s message started', () => {
    const { box, send } = world()
    /** `from`'s message delivered into `recipient`'s turn `turn`, which the first one delivered into it started, or the person's message */
    const deliver = (from: string, recipient: string, turn: number, at: number, starter: 'mail' | 'person' = 'mail') => {
      const id = send({ sender: from }, recipient)
      box.markDelivered(recipient, [id], at, turn)
      const sessionId = recipient.slice(recipient.indexOf('/') + 1)
      if (turnsOf(box, sessionId).some((t) => t.turnSeq === turn)) return
      box.startTurn({ sessionId, turnSeq: turn, messageId: null, starterId: starter === 'person' ? send({ sender: 'person' }, recipient) : id, startedBy: 'mail', startedAt: at })
    }
    deliver(A, B, 6, NOW, 'person')
    deliver(B, A, 1, NOW)
    deliver(B, A, 1, NOW + 1)
    deliver(B, A, 2, NOW + 2)
    deliver(A, B, 5, NOW + 3)
    deliver(B, A, 9, NOW - 2 * 60 * 60 * 1000)
    deliver(C, A, 3, NOW)
    expect(box.pairTurnsSince(A, B, NOW - 60 * 60 * 1000)).toBe(3)
    expect(box.pairTurnsSince(B, A, NOW - 60 * 60 * 1000)).toBe(3)
  })

  it('pairTurnsSince counts each task that joined a turn it did not start, the person’s turn too; a task that started its turn counts as that turn', () => {
    const { box, send } = world()
    const B_ID = B.slice(B.indexOf('/') + 1)
    // b's turn 1 the person started; a's two tasks join it
    box.startTurn({ sessionId: B_ID, turnSeq: 1, messageId: null, starterId: null, startedBy: 'person', startedAt: NOW })
    for (const at of [NOW + 1, NOW + 2]) {
      const task = send({ sender: A, kind: 'task', createdAt: at }, B)
      box.markDelivered(B, [task], at, 1)
    }
    // b's turn 2 a's task started: one turn, counted once
    const work = send({ sender: A, kind: 'task', createdAt: NOW + 3 }, B)
    box.markDelivered(B, [work], NOW + 3, 2)
    box.startTurn({ sessionId: B_ID, turnSeq: 2, messageId: work, starterId: work, startedBy: 'mail', startedAt: NOW + 3 })
    expect(box.pairTurnsSince(A, B, NOW - 60 * 60 * 1000)).toBe(3)
  })

  it('held rows are found by their index, not by a scan of the table (v66)', () => {
    const { db } = world()
    for (const where of [`r.held = 'policy'`, `r.held IS NOT NULL AND r.held NOT IN ('released', 'dismissed')`]) {
      const plan = db.prepare<[], { detail: string }>(`EXPLAIN QUERY PLAN SELECT r.message_id FROM mail_recipients r WHERE ${where}`).all()
      expect(plan.map((p) => p.detail).join(' ')).toContain('USING INDEX mail_recipients_held')
    }
  })

  it('sameBody finds the same text to the same recipient', () => {
    const { box, send } = world()
    send({ sender: A, body: 'hello' }, B)
    send({ sender: A, body: 'old', createdAt: NOW - DAY }, B)
    expect(box.sameBody(A, B, 'hello', NOW - 1000)).toBe(true)
    expect(box.sameBody(A, C, 'hello', NOW - 1000)).toBe(false)
    expect(box.sameBody(A, B, 'old', NOW - 1000)).toBe(false)
  })

  it('requestsSince leaves out replies to the Assistant’s needsReply messages and tasks, and clarifications', () => {
    const { box, send } = world()
    const since = NOW - 1000
    const ask = send({ sender: ORC, needsReply: true }, A)
    const task = send({ sender: ORC, kind: 'task' }, A)
    const fyi = send({ sender: ORC }, A)
    const notToA = send({ sender: ORC, needsReply: true }, C)
    send({ sender: A, replyTo: ask }, ORC)
    send({ sender: A, replyTo: task }, ORC)
    send({ sender: A, facts: { clarifies: task } }, ORC)
    expect(box.requestsSince([A, B], ORC, since)).toBe(0)
    send({ sender: A, replyTo: fyi }, ORC)
    send({ sender: A, replyTo: notToA }, ORC)
    send({ sender: B }, ORC)
    send({ sender: C }, ORC)
    send({ sender: A, createdAt: NOW - DAY }, ORC)
    expect(box.requestsSince([A, B], ORC, since)).toBe(3)
  })

  it('followUpsTo lists reminders and unanswered notices undelivered or delivered since; refusedRecords by project', () => {
    const { box, send } = world()
    const r1 = send({ sender: 'centralu', kind: 'notice', facts: { reminder: 1, of: ['x'] } }, A)
    const r2 = send({ sender: 'centralu', kind: 'notice', facts: { unanswered: [{ id: 'x', recipient: B, why: 'waited' }] } }, A)
    const old = send({ sender: 'centralu', kind: 'notice', facts: { reminder: 2, of: ['x'] } }, A)
    send({ sender: 'centralu', kind: 'notice', facts: { hostCap: true } }, A)
    box.markDelivered(A, [r1], NOW, 1)
    box.markDelivered(A, [old], NOW - DAY, 1)
    expect(box.followUpsTo(A, NOW - 1000).map((r) => r.messageId)).toEqual([r1, r2])

    const refused = send({ sender: 'centralu', kind: 'notice', facts: { refused: { tool: 'start_agent', target: 'q', firstLine: 'do', projectId: 'p1' } } }, to(B, { deliveredAt: NOW, readAt: NOW }))
    send({ sender: 'centralu', kind: 'notice', facts: { refused: { tool: 'start_agent', target: 'q', firstLine: 'do', projectId: 'p2' } } }, B)
    expect(box.refusedRecords('p1').map((p) => [p.row.recipient, p.message.id])).toEqual([[B, refused]])
  })
})

describe('handoff and trash', () => {
  it('moveRows lets the heir’s own row win', () => {
    const { box, send } = world()
    const shared = send({ sender: C, needsReply: true }, A, B)
    box.markDelivered(B, [shared], NOW, 4)
    box.markRead(B, [shared], NOW)
    const unread = send({ sender: C }, to(A, { held: 'loop' }))
    box.markDelivered(A, [unread], NOW, 2)
    const readAsk = send({ sender: C, needsReply: true }, A)
    box.markDelivered(A, [readAsk], NOW, 2)
    box.markRead(A, [readAsk], NOW)
    const readPlain = send({ sender: C }, A)
    box.markRead(A, [readPlain], NOW)
    const own = send({ sender: B, needsReply: true }, A)

    expect(box.moveRows(A, B, 'all')).toEqual([shared, unread, readAsk])
    expect(box.recipient(shared, B)).toMatchObject({ deliveredAt: NOW, readAt: NOW, turnSeq: 4 })
    expect(box.recipient(shared, A)).toBeUndefined()
    expect(box.recipient(unread, B)).toMatchObject({ deliveredAt: null, held: null, turnSeq: null, attempts: 0 })
    expect(box.recipient(readAsk, B)).toMatchObject({ deliveredAt: NOW, readAt: NOW, turnSeq: null })
    expect(box.recipient(readPlain, A)).toBeDefined()
    expect(box.recipient(own, A)).toBeDefined()
  })

  it('moveRows with a scope moves only mail from those recipients', () => {
    const { box, send } = world()
    const fromC = send({ sender: C, needsReply: true }, A)
    const fromOther = send({ sender: ORC, needsReply: true }, A)
    expect(box.moveRows(A, B, { senders: [C] })).toEqual([fromC])
    expect(box.recipient(fromOther, A)).toBeDefined()
  })

  it('moveRole delivers afresh even when read', () => {
    const { box, send } = world()
    const NEW = 'session:h1/orc2'
    const asked = send({ sender: A, needsReply: true }, to(ORC, { via: 'orchestrator' }))
    box.markDelivered(ORC, [asked], NOW, 3)
    box.markRead(ORC, [asked], NOW)
    const direct = send({ sender: A, needsReply: true }, ORC)
    const done = send({ sender: A, needsReply: true }, to(ORC, { via: 'orchestrator' }))
    box.markDelivered(ORC, [done], NOW, 3)
    box.settle(done, ORC, 'answered', NOW)
    expect(box.moveRole(NEW)).toEqual([asked])
    expect(box.recipient(asked, NEW)).toMatchObject({ deliveredAt: null, readAt: null, attemptAt: null, turnSeq: null, attempts: 0, via: 'orchestrator' })
    expect(box.recipient(direct, ORC)).toBeDefined()
    expect(box.recipient(done, ORC)).toBeDefined()
  })

  it('moveRole and openParties take a row sent to the role under the Assistant’s new name too (#2133)', () => {
    const { box, send } = world()
    const NEW = 'session:h1/orc2'
    // A later build writes via 'assistant'; the row waits for the role, not for the session that held it
    const renamed = send({ sender: A, needsReply: true }, to(ORC, { via: 'assistant' }))
    expect(box.openParties()).not.toContain(ORC)
    expect(box.moveRole(NEW)).toEqual([renamed])
    expect(box.recipient(renamed, NEW)).toMatchObject({ via: 'assistant' })
  })

  it('purgeParty removes a party’s rows', () => {
    const { box, send } = world()
    const onlyA = send({ sender: B }, A)
    const both = send({ sender: B }, A, C)
    const fromA = send({ sender: A }, C)
    expect(box.purgeParty(A)).toBe(2)
    expect(box.message(onlyA)).toBeUndefined()
    expect(box.recipients(both).map((r) => r.recipient)).toEqual([C])
    expect(box.message(fromA)).toBeDefined()
  })
})

describe('retention (§6.4)', () => {
  it('sweep keeps what waits and drops the settled after 30 days', () => {
    const { box, send } = world()
    const at = NOW - 40 * DAY
    const delivered = (id: string, who: string) => {
      box.markDelivered(who, [id], at, 1)
      box.markRead(who, [id], at)
      return id
    }
    const plain = delivered(send({ sender: A, createdAt: at }, B), B)
    const answered = delivered(send({ sender: A, needsReply: true, createdAt: at }, B), B)
    box.settle(answered, B, 'answered', at)
    const open = delivered(send({ sender: A, needsReply: true, createdAt: at }, B), B)
    const undelivered = send({ sender: A, createdAt: at }, B)
    const held = send({ sender: A, createdAt: at }, to(B, { held: 'policy' }))
    const released = delivered(send({ sender: A, needsReply: true, createdAt: at }, B), B)
    box.markReleased(released, B, at, 'waited')
    const recent = delivered(send({ sender: A, createdAt: NOW - DAY }, B), B)
    const readNotice = delivered(send({ sender: 'centralu', kind: 'notice', createdAt: NOW - 20 * DAY }, B), B)
    const unreadNotice = send({ sender: 'centralu', kind: 'notice', createdAt: NOW - 20 * DAY }, to(B, { deliveredAt: NOW - 20 * DAY }))
    const ancient = send({ sender: A, needsReply: true, createdAt: NOW - 181 * DAY }, B)

    expect(box.sweep(NOW, { batch: 2 })).toEqual({ messages: 5 })
    const kept = (id: string) => box.message(id) !== undefined
    expect([plain, answered, released, readNotice, ancient].map(kept)).toEqual([false, false, false, false, false])
    expect([open, undelivered, held, recent, unreadNotice].map(kept)).toEqual([true, true, true, true, true])
    expect(box.recipients(plain)).toEqual([])
    expect(box.sweep(NOW)).toEqual({ messages: 0 })
  })
})

describe('what a store must not trust', () => {
  it('insert refuses a reply its own chain answers, and chain ends on a loop already stored', () => {
    const { box, send, db } = world()
    // From another machine, a message can arrive before the one it answers (its root given)
    const x = box.insert(mail({ sender: A, replyTo: 'h2.m_y', rootId: 'h2.m_root' }), [to(B)]).id
    expect(() => box.insert(mail({ id: 'h2.m_y', sender: B, replyTo: x, rootId: 'h2.m_root' }), [to(A)])).toThrow(MailConflict)
    expect(() => box.insert(mail({ id: 'h1.m_self', sender: B, replyTo: 'h1.m_self', rootId: 'h1.m_self' }), [to(A)])).toThrow(expect.objectContaining({ what: 'cycle' }))
    // A loop written by hand (or by an older or broken writer): the walk stops at its limit
    const c = send({ sender: A }, B)
    const d = send({ sender: B, replyTo: c }, A)
    db.prepare(`UPDATE mail SET reply_to = ? WHERE id = ?`).run(d, c)
    expect(box.chain(c, 9).map((m) => m.id)).toEqual([d, c, d, c, d, c, d, c, d])
    db.prepare(`UPDATE mail SET reply_to = id WHERE id = ?`).run(c)
    expect(box.chain(c, 3)).toHaveLength(3)
    expect(box.chain(c, 0)).toEqual([])
  })

  it('insert refuses a taken id and a recipient listed twice with a typed error, writing nothing', () => {
    const { box, send } = world()
    const id = send({ sender: A, body: 'first' }, B)
    expect(() => box.insert(mail({ id, sender: C, body: 'second' }), [to(A)])).toThrow(expect.objectContaining({ name: 'MailConflict', what: 'id', value: id }))
    expect(box.message(id)?.body).toBe('first')
    const twice = mail({ sender: A })
    expect(() => box.insert(twice, [to(B), to(C), to(B)])).toThrow(expect.objectContaining({ what: 'recipient', value: B }))
    expect(box.message(twice.id)).toBeUndefined()
  })

  it('insert returns facts as stored and read back, not as given', () => {
    const { box } = world()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const given = { quiet: 'yes', reason: 'kept' } as unknown as MailFacts
    const stored = box.insert(mail({ sender: A, facts: given }), [to(B)])
    expect(stored.facts).toEqual({ reason: 'kept' })
    expect(stored).toEqual({ ...must(box.message(stored.id)), duplicate: false })
  })

  it('an unanswered element with a reason this build does not know keeps the element, its reason null', () => {
    const { box, send, db } = world()
    const id = send({ sender: 'centralu', kind: 'notice' }, A)
    db.prepare(`UPDATE mail SET facts = ? WHERE id = ?`).run(JSON.stringify({ unanswered: [{ id: 'x', recipient: B, why: 'moved' }, { id: 'y', recipient: C, why: 'waited' }] }), id)
    expect(box.message(id)?.facts.unanswered).toEqual([
      { id: 'x', recipient: B, why: null },
      { id: 'y', recipient: C, why: 'waited' },
    ])
  })

  it('a clarifies that is not a message id is not a clarification, in requestsSince as in facts', () => {
    const { box, send, db } = world()
    const id = send({ sender: A }, ORC)
    db.prepare(`UPDATE mail SET facts = '{"clarifies":null}' WHERE id = ?`).run(id)
    expect(box.message(id)?.facts.clarifies).toBeUndefined()
    expect(box.requestsSince([A], ORC, NOW - 1000)).toBe(1)
  })

  it('byRoot and feedOf before a message that is not stored list nothing, not the first page', () => {
    const { box, send } = world()
    const root = send({ sender: A }, B)
    send({ sender: B, replyTo: root }, A)
    expect(box.byRoot(root, { limit: 10 })).toHaveLength(2)
    expect(box.byRoot(root, { before: 'h1.m_gone', limit: 10 })).toEqual([])
    expect(box.feedOf(A, { before: 'h1.m_gone', limit: 10 })).toEqual([])
  })

  it('a handoff moves the original’s unread rows that are settled legacy (moved from threads) too', () => {
    const { box, send, db } = world()
    const report = send({ sender: 'centralu', kind: 'report' }, A)
    const readOne = send({ sender: C }, A)
    box.markRead(A, [readOne], NOW)
    db.prepare(`UPDATE mail_recipients SET settled = 'legacy', settled_at = ?`).run(NOW)
    expect(box.moveRows(A, B, 'all')).toEqual([report])
    expect(box.recipient(report, B)).toMatchObject({ settled: 'legacy', readAt: null })
    expect(box.recipient(readOne, A)).toBeDefined()
  })

  it('the per-recipient reads use an index, not a scan of the tables', () => {
    const { box, send, db } = world()
    const prepare = db.prepare.bind(db)
    const used: { sql: string; args: unknown[] }[] = []
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const stmt = prepare(sql)
      if (!/^\s*SELECT/i.test(sql)) return stmt
      return new Proxy(stmt, {
        get(target, key) {
          if (key === 'all' || key === 'get') {
            return (...args: unknown[]) => {
              used.push({ sql, args })
              return key === 'all' ? target.all(...args) : target.get(...args)
            }
          }
          const v: unknown = Reflect.get(target, key)
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v
        },
      })
    })
    const id = send({ sender: A }, B)
    box.markDelivered(B, [id], NOW, 1)
    const reads: [string, () => unknown][] = [
      ['pendingFor', () => box.pendingFor(B, NOW, true)],
      ['pairTurnsSince', () => box.pairTurnsSince(A, B, NOW - 1000)],
      ['followUpsTo', () => box.followUpsTo(B, NOW - 1000)],
      ['feedOf', () => box.feedOf(B, { limit: 10 })],
    ]
    for (const [name, read] of reads) {
      used.length = 0
      read()
      expect(used.length, name).toBeGreaterThan(0)
      for (const u of used) {
        const plan = prepare(`EXPLAIN QUERY PLAN ${u.sql}`)
          .all(...u.args)
          .map((p) => (p as { detail: string }).detail)
        expect(plan.filter((d) => /^SCAN (m|r|mail|mail_recipients)\b/.test(d)), `${name}: ${plan.join(' | ')}`).toEqual([])
      }
    }
  })
})

describe('what the message service reads (M2)', () => {
  it('unreadFor lists what a recipient may read and has not, delivered or not, and leaves out what is held out, withdrawn, gone or read', () => {
    const { box, send } = world()
    const plain = send({ sender: A }, B)
    const delivered = send({ sender: C }, B)
    const read = send({ sender: A }, B)
    const policy = send({ sender: A }, B)
    const loop = send({ sender: A }, B)
    const uncertain = send({ sender: A }, B)
    const withdrawn = send({ sender: A, needsReply: true }, B)
    const gone = send({ sender: A, needsReply: true }, B)
    const elsewhere = send({ sender: A }, C)
    box.markDelivered(B, [delivered], NOW, 1)
    box.markRead(B, [read], NOW)
    box.hold(B, [policy], 'policy')
    box.hold(B, [loop], 'loop')
    box.markUncertain(B, [uncertain])
    box.settle(withdrawn, B, 'withdrawn', NOW)
    box.settle(gone, B, 'gone', NOW)
    expect(box.unreadFor(B).map((p) => p.row.messageId)).toEqual([plain, delivered, uncertain])
    expect(box.unreadFor(B)[0]?.message.id).toBe(plain)
    expect(box.unreadFor(C).map((p) => p.row.messageId)).toEqual([elsewhere])
    expect(box.unreadFor('session:h1/nobody')).toEqual([])
  })

  it('postsSince counts what a sender sent since, of any kind, to anyone', () => {
    const { box, send } = world()
    send({ sender: A, createdAt: NOW - 120_000 }, B)
    send({ sender: A, createdAt: NOW - 30_000 }, B, C)
    send({ sender: A, createdAt: NOW - 1_000, kind: 'task' }, C)
    send({ sender: B, createdAt: NOW - 1_000 }, A)
    expect(box.postsSince(A, NOW - 60_000)).toBe(2)
    expect(box.postsSince(A, NOW - 200_000)).toBe(3)
    expect(box.postsSince(B, NOW - 60_000)).toBe(1)
    expect(box.postsSince('session:h1/nobody', 0)).toBe(0)
  })

  it('movable lists what moveRows moves, and moves nothing', () => {
    const { box, send } = world()
    const watched = send({ sender: A, needsReply: true }, B)
    const unreadNote = send({ sender: C }, B)
    const readNote = send({ sender: A }, B)
    const settled = send({ sender: A, needsReply: true }, B)
    const own = send({ sender: C, needsReply: true }, B)
    box.markRead(B, [readNote], NOW)
    box.settle(settled, B, 'done', NOW)
    box.markRead(B, [settled], NOW)
    // Watched and unsettled, or unread; not what is read and needs nothing, not what is settled and read, and not mail from the heir itself
    expect(box.movable(B, ORC, 'all')).toEqual([watched, unreadNote, own])
    expect(box.movable(B, C, 'all')).toEqual([watched])
    expect(box.movable(B, ORC, { senders: [C] })).toEqual([unreadNote, own])
    expect(box.recipient(watched, B)).toBeDefined()
    const preview = box.movable(B, ORC, 'all')
    expect(box.moveRows(B, ORC, 'all')).toEqual(preview)
  })

  it('deleteRows deletes the rows named and each message left with none, and no other', () => {
    const { box, send } = world()
    const both = send({ sender: A }, B, C)
    const only = send({ sender: A }, B)
    expect(box.deleteRows([{ messageId: both, recipient: B }, { messageId: only, recipient: B }, { messageId: only, recipient: C }])).toBe(2)
    expect(box.message(only)).toBeUndefined()
    expect(box.message(both)).toBeDefined()
    expect(box.recipients(both).map((r) => r.recipient)).toEqual([C])
  })

  it('refusedRecords lists the records of one project, or of every project when none is given', () => {
    const { box } = world()
    const refused = (projectId: string, caller: string) =>
      box.insert(mail({ sender: 'centralu', kind: 'notice', facts: { refused: { tool: 'start_agent', target: 't', firstLine: 'x', projectId } } }), [to(caller)]).id
    const one = refused('p1', A)
    const two = refused('p2', B)
    const three = refused('p1', C)
    box.insert(mail({ sender: 'centralu', kind: 'notice', facts: { quiet: true } }), [to(A)])
    expect(box.refusedRecords('p1').map((p) => p.message.id)).toEqual([one, three])
    expect(box.refusedRecords().map((p) => p.message.id).sort()).toEqual([one, two, three].sort())
    expect(box.refusedRecords('p9')).toEqual([])
  })
})

describe('a question’s choices have a column of their own (v70, #1630)', () => {
  it('round-trip as stored and never ride in facts', () => {
    const { box, send, db } = world()
    const id = send({ sender: A, needsReply: true, choices: ['main', 'release/1.4'] }, 'person')
    expect(box.message(id)).toMatchObject({ choices: ['main', 'release/1.4'], facts: {} })
    expect(db.prepare<[string], { choices: string; facts: string }>(`SELECT choices, facts FROM mail WHERE id = ?`).get(id)).toEqual({ choices: '["main","release/1.4"]', facts: '{}' })
    expect(box.message(send({ sender: A }, B))?.choices).toBeNull()
  })

  it('read as none when what is stored is not 2 to 6 strings, and a key of that name in facts is not a choice', () => {
    const { box, send, db } = world()
    const id = send({ sender: A, needsReply: true }, 'person')
    for (const raw of ['["only one"]', '{"a":1}', 'not json', '[1,2]']) {
      db.prepare(`UPDATE mail SET choices = ? WHERE id = ?`).run(raw, id)
      expect(box.message(id)?.choices).toBeNull()
    }
    db.prepare(`UPDATE mail SET choices = NULL, facts = ? WHERE id = ?`).run('{"choices":["x","y"]}', id)
    expect(box.message(id)?.choices).toBeNull()
  })
})
