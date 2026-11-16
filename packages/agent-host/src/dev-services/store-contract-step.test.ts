/**
 * Step 75 (#2258 item 1, docs/plans/mailbox.md §6.3, M7): the last move of thread mail. What a build of v61 to v64 left pending in its thread
 * tables becomes mail once, in the step, and from this build on only a migration step names those tables. The floor goes to 74: the builds of
 * v70 to v73 are refused, and the build of v74 opens the store and finds nothing left to move.
 *
 * The build of v64 is this build's `Store` with the steps after 64 left out, and its thread mail is written in plain SQL, as its `MailRecords`
 * wrote it. Only the clock's date is set, so the step's `Date.now()` is `NOW`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { sessionAddress } from '../mail/address.js'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { Store, StoreTooNewError } from './store.js'
import type { MigrationStep } from './store/migrations/context.js'

const STEP = 75
const HOST = 'hub-aaaaaaaa'
const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000
/** When the fixture's mail was sent */
const AT = NOW - 60_000
const S1 = sessionAddress(HOST, 's1')
const S2 = sessionAddress(HOST, 's2')
const S3 = sessionAddress(HOST, 's3')
const APP = `app:${HOST}/p1/board`
const WORK = `${HOST}.t_work`
const COLOURS = `${HOST}.t_colours`

/** The newest step the next store knows */
let newest = STEP

class Build extends Store {
  protected override migrationSteps(): MigrationStep[] {
    return super.migrationSteps().filter((s) => s.to <= newest)
  }

  get raw(): Database.Database {
    return this.db
  }

  /** Runs the steps up to `to` on this connection, as the build whose newest step that is does when it opens the store */
  upgrade(to = STEP): void {
    newest = to
    try {
      this.migrate()
    } finally {
      newest = STEP
    }
  }
}

/** The store as the build whose newest step is `version` opens it: in memory, or the one at `file` */
function open(version: number, file?: string): Build {
  newest = version
  try {
    return new Build(file)
  } finally {
    newest = STEP
  }
}

const stores: Build[] = []
const dirs: string[] = []
beforeEach(() => void vi.useFakeTimers({ toFake: ['Date'], now: NOW }))
afterEach(async () => {
  vi.useRealTimers()
  for (const s of stores.splice(0)) s.close()
  for (const d of dirs.splice(0)) await removeTree(d)
})

function rows<T>(db: Database.Database, sql: string, ...args: unknown[]): T[] {
  return db.prepare<unknown[], T>(sql).all(...args)
}

function session(db: Database.Database, id: string, s: { project?: string | null; assistant?: boolean; trashed?: boolean } = {}): string {
  db.prepare(`INSERT INTO sessions (id, project_id, tool, name, created_at, is_orchestrator, deleted_at) VALUES (?, ?, 'claude', ?, 1, ?, ?)`).run(id, s.project === undefined ? 'p1' : s.project, id, s.assistant ? 1 : 0, s.trashed ? 5 : null)
  return sessionAddress(HOST, id)
}

function thread(db: Database.Database, id: string, t: { origin?: string; projectId?: string | null; owner: string; assignee?: string | null }): string {
  db.prepare(
    `INSERT INTO mail_threads (id, home, project_id, subject, origin, depth, parent_id, follows, state, outcome, owner, assignee, next_step, links, rev, created_at, updated_at, state_since)
     VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, 'open', NULL, ?, ?, NULL, '{}', 0, ?, ?, ?)`,
  ).run(id, HOST, t.projectId ?? null, id, t.origin ?? 'mail', t.owner, t.assignee ?? null, AT, AT, AT)
  return id
}

type Post = { thread: string; sender: string; kind: string; to: readonly string[]; at?: number; replyTo?: string | null; wake?: string | null; needsOwner?: boolean; facts?: string }

/** A thread message with a receipt for each recipient, none delivered. `key` is the id without its host */
function post(db: Database.Database, key: string, m: Post): string {
  const id = `${HOST}.${key}`
  const at = m.at ?? AT
  const seq = rows<{ n: number }>(db, `SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM mail_messages WHERE thread_id = ?`, m.thread)[0]?.n ?? 1
  db.prepare(
    `INSERT INTO mail_messages (id, thread_id, seq, home_seq, sender, kind, urgent, needs_owner, wake, reply_to, body, facts, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(id, m.thread, seq, seq, m.sender, m.kind, m.needsOwner ? 1 : 0, m.wake ?? null, m.replyTo ?? null, `${m.kind} ${key}`, m.facts ?? '{}', at)
  for (const to of m.to) db.prepare(`INSERT INTO mail_receipts (message_id, recipient, due_at) VALUES (?, ?, ?)`).run(id, to, at)
  return id
}

/** Receipt fields as the build of v64 set them (`markAttempt`, `markDelivered`, `markHandledIds`, `setHeld`) */
function receipt(db: Database.Database, id: string, recipient: string, set: string, ...args: unknown[]): void {
  db.prepare(`UPDATE mail_receipts SET ${set} WHERE message_id = ? AND recipient = ?`).run(...args, id, recipient)
}
const delivered = (db: Database.Database, id: string, recipient: string, read = false) =>
  receipt(db, id, recipient, `delivered_at = ?${read ? ', read_at = ?' : ''}`, ...(read ? [AT, AT] : [AT]))
const held = (db: Database.Database, id: string, recipient: string, word: string) => receipt(db, id, recipient, 'held = ?', word)

/** A store the build of v64 served, with the project and three sessions of it */
function v64(file?: string): Build {
  const s = open(64, file)
  stores.push(s)
  expect(s.schemaVersion).toBe(64)
  s.raw.exec(`INSERT INTO projects (id, path, name, created_at) VALUES ('p1', '/tmp/p1', 'alpha', 1)`)
  for (const id of ['s1', 's2', 's3']) session(s.raw, id)
  return s
}

/**
 * Thread mail as the build of v64 left it:
 * - `q`, a question to two recipients: delivered to S2 and unread, not delivered to S3 (both pending);
 * - `a`, S2's answer, delivered to both and read (not pending), and `n`, a note pending for S1, read and handled by S3;
 * - `t`, a delegation's assign to S2, pending; `rep`, Centralu's quiet report to S1; `e`, an event;
 * - `ap`, an app's needsOwner notice to S1, held `loop`; `pol`, a note held `policy`; `dis`, one the person dismissed;
 * - `old`, a pending note sent 200 days ago.
 */
function fixture(db: Database.Database): Record<string, string> {
  thread(db, COLOURS, { owner: S1 })
  const q = post(db, 'm_0q', { thread: COLOURS, sender: S1, kind: 'question', to: [S2, S3] })
  receipt(db, q, S2, 'attempt_at = ?, attempts = attempts + 1', AT)
  delivered(db, q, S2)
  const a = post(db, 'm_0a', { thread: COLOURS, sender: S2, kind: 'answer', to: [S1, S3], replyTo: q, at: AT + 1000 })
  delivered(db, a, S1, true)
  delivered(db, a, S3, true)
  const n = post(db, 'm_0n', { thread: COLOURS, sender: S2, kind: 'note', to: [S1, S3], at: AT + 2000 })
  receipt(db, n, S3, 'read_at = ?, handled_at = ?', AT, AT)

  thread(db, WORK, { origin: 'start_agent', projectId: 'p1', owner: S1, assignee: S2 })
  const at = AT + 2000
  const t = post(db, 'm_t', { thread: WORK, sender: S1, kind: 'assign', to: [S2], at })
  const rep = post(db, 'm_r', { thread: WORK, sender: 'centralu', kind: 'report', to: [S1], at, wake: 'no', facts: JSON.stringify({ outcome: 'paused', waitingOn: [`${HOST}.t_x`, `${HOST}.t_y`], about: { session: S2 } }) })
  const e = post(db, 'm_e', { thread: WORK, sender: 'centralu', kind: 'event', to: [S1], at })
  const ap = post(db, 'm_ap', { thread: WORK, sender: APP, kind: 'notice', to: [S1], at, needsOwner: true })
  held(db, ap, S1, 'loop')
  const pol = post(db, 'm_pol', { thread: WORK, sender: S2, kind: 'note', to: [S1], at })
  held(db, pol, S1, 'policy')
  const dis = post(db, 'm_dis', { thread: WORK, sender: S2, kind: 'note', to: [S3], at })
  held(db, dis, S3, 'dismissed')
  const old = post(db, 'm_old', { thread: WORK, sender: S2, kind: 'note', to: [S1], at: NOW - 200 * DAY })
  return { q, a, n, t, rep, e, ap, pol, dis, old }
}

type Receipt = { message_id: string; recipient: string; delivered_at: number | null; read_at: number | null; handled_at: number | null; held: string | null }
type Moved = { message_id: string; recipient: string; via: string | null; delivered_at: number | null; held: string | null; settled: string | null }
const receipts = (db: Database.Database) => rows<Receipt>(db, `SELECT message_id, recipient, delivered_at, read_at, handled_at, held FROM mail_receipts ORDER BY message_id, recipient`)
const moved = (db: Database.Database) => rows<Moved>(db, `SELECT message_id, recipient, via, delivered_at, held, settled FROM mail_recipients ORDER BY message_id, recipient`)
const movedRow = (db: Database.Database, id: string) => moved(db).find((r) => r.message_id === id)
/** A moved message's facts as they are stored */
const storedFacts = (db: Database.Database, id: string | undefined): unknown => JSON.parse(rows<{ facts: string }>(db, `SELECT facts FROM mail WHERE id = ?`, id)[0]?.facts ?? 'null')

/** What the build of v74 moves at its every start: the receipts its move at ready selects */
const pendingForV74 = (db: Database.Database) =>
  rows<{ id: string }>(
    db,
    `SELECT m.id FROM mail_receipts r JOIN mail_messages m ON m.id = r.message_id JOIN mail_threads t ON t.id = m.thread_id
      WHERE r.handled_at IS NULL AND COALESCE(r.held, '') <> 'dismissed' AND m.created_at >= ?
        AND (r.delivered_at IS NULL OR r.read_at IS NULL OR m.kind = 'question')`,
    NOW - 180 * DAY,
  )

describe('step 75: the last move of thread mail', () => {
  it('copies each pending thread message once under its id, with its kind and facts as mail', () => {
    const s = v64()
    const ids = fixture(s.raw)
    const ran = s.migrationsRun
    s.upgrade()
    expect([s.schemaVersion, s.migrationsRun - ran]).toEqual([STEP, STEP - 64])
    const m = (k: string) => s.mailbox.message(ids[k] ?? '')
    expect(m('q')).toMatchObject({ kind: 'message', needsReply: true, legacyThread: COLOURS, origin: 'mail', senderProject: 'p1', facts: { legacyKind: 'question' }, rootId: ids.q, causeId: null, depth: 0 })
    expect(m('n')).toMatchObject({ kind: 'message', needsReply: false, origin: 'mail', facts: { legacyKind: 'note' } })
    expect(m('t')).toMatchObject({ kind: 'task', needsReply: false, origin: 'start_agent', senderProject: 'p1', facts: { legacyKind: 'assign' } })
    expect(m('rep')).toMatchObject({ kind: 'report', senderProject: null, origin: 'mail' })
    // The threads a report waited on are stored as their count
    expect(storedFacts(s.raw, ids.rep)).toEqual({ outcome: 'paused', waitingOn: 2, about: { session: S2 }, legacyKind: 'report', quiet: true })
    expect(m('e')).toMatchObject({ kind: 'notice', facts: { legacyKind: 'event', quiet: true } })
    expect(m('ap')).toMatchObject({ kind: 'notice', senderProject: null, facts: { legacyKind: 'notice', needsOwner: true } })
    expect(m('pol')).toMatchObject({ kind: 'message', facts: { legacyKind: 'note' } })
    // Neither a task nor an app's needsOwner notice is quiet
    expect([m('t')?.facts.quiet, m('ap')?.facts.quiet, m('t')?.facts.needsOwner]).toEqual([undefined, undefined, undefined])
    // Not pending: delivered and read, dismissed, or past retention
    for (const k of ['a', 'dis', 'old']) expect(m(k)).toBeUndefined()
    expect(rows(s.raw, `SELECT id FROM mail`)).toHaveLength(7)

    // The question to two recipients is one message with a row each: S2's delivered, S3's not
    expect(s.mailbox.recipients(ids.q ?? '')).toEqual([
      expect.objectContaining({ recipient: S2, settled: 'legacy', deliveredAt: AT, attempts: 1 }),
      expect.objectContaining({ recipient: S3, settled: 'legacy', deliveredAt: null, attempts: 0 }),
    ])
    expect(moved(s.raw)).toHaveLength(8)
    for (const r of moved(s.raw)) expect(r).toMatchObject({ settled: 'legacy', via: null })
  })

  it('marks every moved receipt handled, delivered and read, and leaves the rest and the tables as they were', () => {
    const s = v64()
    const ids = fixture(s.raw)
    const was = receipts(s.raw)
    const counts = () => ['mail_threads', 'mail_messages', 'mail_receipts', 'mail_participants', 'mail_blockers'].map((t) => rows<{ n: number }>(s.raw, `SELECT count(*) AS n FROM ${t}`)[0]?.n)
    const before = counts()
    s.upgrade()
    const left = receipts(s.raw).filter((r) => moved(s.raw).some((x) => x.message_id === r.message_id && x.recipient === r.recipient))
    expect(left).toHaveLength(8)
    for (const r of left) expect(r).toMatchObject({ handled_at: NOW, delivered_at: expect.any(Number), read_at: expect.any(Number) })
    // A delivery the old build made keeps its time; what it never delivered or read is stamped now
    expect(left.find((r) => r.message_id === ids.q && r.recipient === S2)).toMatchObject({ delivered_at: AT, read_at: NOW })
    expect(left.find((r) => r.message_id === ids.q && r.recipient === S3)).toMatchObject({ delivered_at: NOW, read_at: NOW })
    const untouched = (r: Receipt) => !left.some((x) => x.message_id === r.message_id && x.recipient === r.recipient)
    expect(receipts(s.raw).filter(untouched)).toEqual(was.filter(untouched))
    expect(receipts(s.raw).find((r) => r.message_id === ids.old)).toMatchObject({ handled_at: null, delivered_at: null })
    // The thread tables stay, unread from here on: the build of v74 still names them
    expect(counts()).toEqual(before)
    expect(pendingForV74(s.raw)).toEqual([])
  })

  it('moved undelivered rows stay pending, a recipient’s hold is carried, and a hold nothing sets now is ended (#2243)', () => {
    const s = v64()
    const ids = fixture(s.raw)
    s.upgrade()
    expect(s.mailbox.pendingFor(S1, NOW).map((p) => p.message.id)).toEqual([ids.n, ids.e, ids.rep])
    expect(s.mailbox.pendingFor(S3, NOW).map((p) => p.message.id)).toEqual([ids.q])
    // The auto receiver's first-contact hold went with D10: a note within one project is held by nothing now
    expect(s.mailbox.recipient(ids.pol ?? '', S1)).toMatchObject({ held: 'dismissed', attempts: 0 })
    expect(s.mailbox.recipient(ids.ap ?? '', S1)?.held).toBe('loop')
    expect(s.mailbox.heldRows().map((r) => r.messageId)).toEqual([ids.ap])
    // A moved row is settled `legacy`: never watched, so neither reminded nor waited on
    expect(s.mailbox.watchedTo(S3)).toEqual([])
  })

  it('moves a question read and not answered, and mail of exactly 180 days, and nothing a millisecond older', () => {
    const s = v64()
    thread(s.raw, WORK, { owner: S1 })
    const asked = post(s.raw, 'm_asked', { thread: WORK, sender: S1, kind: 'question', to: [S2] })
    delivered(s.raw, asked, S2, true)
    const told = post(s.raw, 'm_told', { thread: WORK, sender: S1, kind: 'note', to: [S2] })
    delivered(s.raw, told, S2, true)
    const edge = post(s.raw, 'm_edge', { thread: WORK, sender: S1, kind: 'note', to: [S2], at: NOW - 180 * DAY })
    post(s.raw, 'm_past', { thread: WORK, sender: S1, kind: 'note', to: [S2], at: NOW - 180 * DAY - 1 })
    s.upgrade()
    expect(moved(s.raw).map((r) => r.message_id)).toEqual([asked, edge])
    expect(s.mailbox.recipient(asked, S2)).toMatchObject({ deliveredAt: AT, readAt: AT, settled: 'legacy' })
    // Read, so not pending for a turn: it is the sender's unanswered question the Inbox shows
    expect(s.mailbox.pendingFor(S2, NOW).map((p) => p.message.id)).toEqual([edge])
  })

  it('a reply keeps its target’s root when the target is moved, whatever their times say, and answers nothing when it is not', () => {
    const s = v64()
    const ids = fixture(s.raw)
    const first = post(s.raw, 'm_first', { thread: WORK, sender: S2, kind: 'note', to: [S1], at: NOW - 1000 })
    // The clock went back between the two
    const back = post(s.raw, 'm_back', { thread: WORK, sender: S2, kind: 'note', to: [S1], replyTo: first, at: NOW - 5000 })
    const deeper = post(s.raw, 'm_deeper', { thread: WORK, sender: S1, kind: 'note', to: [S2], replyTo: back, at: NOW - 4000 })
    const agreed = post(s.raw, 'm_agreed', { thread: COLOURS, sender: S3, kind: 'answer', to: [S1], replyTo: ids.q, at: NOW - 10 })
    // The answer it replies to was read by everyone: not moved
    const late = post(s.raw, 'm_late', { thread: COLOURS, sender: S3, kind: 'note', to: [S1], replyTo: ids.a, at: NOW - 5 })
    s.upgrade()
    expect(s.mailbox.message(back)).toMatchObject({ replyTo: first, rootId: first })
    expect(s.mailbox.message(deeper)).toMatchObject({ replyTo: back, rootId: first })
    expect(s.mailbox.message(agreed)).toMatchObject({ replyTo: ids.q, rootId: ids.q, origin: 'mail' })
    expect(s.mailbox.message(late)).toMatchObject({ replyTo: null, rootId: late })
  })

  it('carries the person’s release of held mail: sent as it is, and never held again for that recipient', () => {
    const s = v64()
    thread(s.raw, WORK, { owner: S1 })
    const id = post(s.raw, 'm_resent', { thread: WORK, sender: S2, kind: 'note', to: [S1, S3] })
    held(s.raw, id, S3, 'released')
    s.upgrade()
    expect(s.mailbox.recipient(id, S3)).toMatchObject({ held: 'released', deliveredAt: null })
    expect(s.mailbox.recipient(id, S1)).toMatchObject({ held: null })
    expect(s.mailbox.message(id)?.facts).toMatchObject({ releasedTo: [S3] })
    expect(s.mailbox.pendingFor(S3, NOW).map((p) => p.message.id)).toEqual([id])
  })

  it('a kind or facts it cannot read moves as a message with the kind it was written with, and facts that are not an object as none', () => {
    const s = v64()
    const ids = fixture(s.raw)
    s.raw.prepare(`UPDATE mail_messages SET kind = 'from_a_newer_build' WHERE id = ?`).run(ids.n)
    s.raw.prepare(`UPDATE mail_messages SET facts = '{not json' WHERE id = ?`).run(ids.q)
    s.raw.prepare(`UPDATE mail_messages SET facts = '[1,2]' WHERE id = ?`).run(ids.t)
    s.raw.prepare(`UPDATE mail_receipts SET held = 'from_a_newer_build' WHERE message_id = ?`).run(ids.e)
    s.upgrade()
    expect(s.mailbox.message(ids.n ?? '')).toMatchObject({ kind: 'message', needsReply: false, facts: { legacyKind: 'from_a_newer_build' } })
    expect(s.mailbox.message(ids.q ?? '')).toMatchObject({ kind: 'message', needsReply: true, facts: { legacyKind: 'question' } })
    expect(s.mailbox.message(ids.t ?? '')?.kind).toBe('task')
    expect([storedFacts(s.raw, ids.q), storedFacts(s.raw, ids.t)]).toEqual([{ legacyKind: 'question' }, { legacyKind: 'assign' }])
    // A hold word no build of v64 wrote is no hold
    expect(s.mailbox.recipient(ids.e ?? '', S1)?.held).toBeNull()
    expect(rows(s.raw, `SELECT id FROM mail`)).toHaveLength(7)
  })

  it('an assign is a task only in a thread that gave work, and an app’s or Centralu’s message is quiet as the old delivery woke for it', () => {
    const s = v64()
    const kinds: Record<string, string> = {}
    for (const origin of ['mail', 'person', 'start_agent', 'agent_session', 'send_to_session', 'create_session', 'ask_project', 'app']) {
      thread(s.raw, `t_${origin}`, { origin, owner: S1 })
      kinds[origin] = post(s.raw, `m_${origin}`, { thread: `t_${origin}`, sender: S1, kind: 'assign', to: [S2] })
    }
    const quiet = (key: string, sender: string, kind: string, m: { wake?: string; needsOwner?: boolean } = {}) => post(s.raw, key, { thread: 't_mail', sender, kind, to: [S2], ...m })
    const cases: [string, boolean][] = [
      [quiet('q1', 'centralu', 'note'), false],
      [quiet('q2', 'centralu', 'note', { wake: 'no' }), true],
      [quiet('q3', S1, 'note', { wake: 'no' }), false],
      [quiet('q4', APP, 'note'), false],
      [quiet('q5', APP, 'note', { wake: 'no' }), true],
      [quiet('q6', APP, 'notice'), true],
      [quiet('q7', APP, 'notice', { wake: 'yes' }), false],
      [quiet('q8', APP, 'notice', { needsOwner: true }), false],
      [quiet('q9', APP, 'notice', { needsOwner: true, wake: 'no' }), true],
      [quiet('q10', S1, 'event', { wake: 'yes' }), true],
    ]
    s.upgrade()
    const taskOrigins = Object.entries(kinds).filter(([, id]) => s.mailbox.message(id)?.kind === 'task').map(([origin]) => origin)
    expect(taskOrigins).toEqual(['person', 'start_agent', 'agent_session', 'send_to_session', 'create_session', 'ask_project'])
    expect([s.mailbox.message(kinds.mail ?? '')?.kind, s.mailbox.message(kinds.app ?? '')?.kind]).toEqual(['message', 'message'])
    // The first message of a thread keeps the thread's origin, the rest are `mail`
    expect([s.mailbox.message(kinds.ask_project ?? '')?.origin, s.mailbox.message(cases[0]?.[0] ?? '')?.origin]).toEqual(['ask_project', 'mail'])
    expect(cases.map(([id]) => s.mailbox.message(id)?.facts.quiet === true)).toEqual(cases.map(([, q]) => q))
  })

  it('a sender’s project is its kept session’s, else its thread’s when it owns the thread, else none', () => {
    const s = v64()
    s.raw.exec(`INSERT INTO projects (id, path, name, created_at) VALUES ('p2', '/tmp/p2', 'beta', 1)`)
    const other = session(s.raw, 'other', { project: 'p2' })
    const gone = session(s.raw, 'gone', { project: 'p2', trashed: true })
    const unknown = sessionAddress(HOST, 'unknown')
    thread(s.raw, 't_other', { projectId: 'p1', owner: other })
    thread(s.raw, 't_gone', { projectId: 'p1', owner: gone })
    thread(s.raw, 't_unknown', { projectId: 'p1', owner: unknown })
    const say = (key: string, t: string, sender: string) => post(s.raw, key, { thread: t, sender, kind: 'note', to: [S1] })
    const cases: [string, string | null][] = [
      [say('m1', 't_other', other), 'p2'],
      [say('m2', 't_gone', gone), 'p1'],
      [say('m3', 't_unknown', unknown), 'p1'],
      [say('m4', 't_other', unknown), null],
      [say('m5', 't_other', gone), null],
      [say('m6', 't_other', S2), 'p1'],
      [say('m7', 't_other', 'person'), null],
    ]
    s.upgrade()
    expect(cases.map(([id]) => s.mailbox.message(id)?.senderProject)).toEqual(cases.map(([, project]) => project))
  })

  it('a row to the Assistant in a session’s request goes to the role, and a task to a trashed session is settled gone', () => {
    const s = v64()
    const assistant = session(s.raw, 'sa', { project: null, assistant: true })
    const former = session(s.raw, 'sf', { assistant: true, trashed: true })
    const trashed = session(s.raw, 'st', { trashed: true })
    // A session with the marker inside a project and kept is a project's own, not the Assistant
    const marked = session(s.raw, 'sm', { assistant: true })
    const ask = (key: string, origin: string, owner: string, assignee: string | null, to: string) => {
      thread(s.raw, `t_${key}`, { origin, owner, assignee })
      return post(s.raw, `m_${key}`, { thread: `t_${key}`, sender: owner, kind: 'assign', to: [to] })
    }
    const cases: [string, { via: string | null; settled: string }][] = [
      [ask('a1', 'ask_project', S2, assistant, assistant), { via: 'assistant', settled: 'legacy' }],
      // The Assistant that was trashed since: the role's, and a task to a trashed session
      [ask('a2', 'ask_project', S2, former, former), { via: 'assistant', settled: 'gone' }],
      [ask('a3', 'mail', S2, former, former), { via: 'assistant', settled: 'legacy' }],
      // Its own thread, a recipient that is not the assignee, a session that is not the Assistant
      [ask('a4', 'ask_project', assistant, assistant, assistant), { via: null, settled: 'legacy' }],
      [ask('a5', 'ask_project', S2, S3, assistant), { via: null, settled: 'legacy' }],
      [ask('a6', 'ask_project', S2, marked, marked), { via: null, settled: 'legacy' }],
      [ask('a7', 'start_agent', S2, trashed, trashed), { via: null, settled: 'gone' }],
      [ask('a8', 'mail', S2, trashed, trashed), { via: null, settled: 'legacy' }],
    ]
    s.upgrade()
    expect(cases.map(([id]) => movedRow(s.raw, id))).toEqual(cases.map(([id, row]) => expect.objectContaining({ message_id: id, ...row })))
  })

  it('ends the token guard’s hold and a policy hold today’s gate would not set, and keeps the untrusted asker’s request held (#2243)', () => {
    const s = v64()
    s.raw.exec(`INSERT INTO projects (id, path, name, created_at, trusted) VALUES ('px', '/tmp/px', 'untrusted', 1, 0), ('pt', '/tmp/pt', 'trusted', 1, 1)`)
    const assistant = session(s.raw, 'sa', { project: null, assistant: true })
    // A session of an untrusted project, one of a trusted project, and one this store never had
    const asker = session(s.raw, 'sx', { project: 'px' })
    const friend = session(s.raw, 'sy', { project: 'pt' })
    const far = sessionAddress(HOST, 'far')
    const trashed = session(s.raw, 'st', { trashed: true })
    const say = (key: string, sender: string, to: string, kind = 'note', origin = 'mail', projectId: string | null = null) => {
      thread(s.raw, `t_${key}`, { origin, owner: sender, assignee: to, projectId })
      return post(s.raw, `m_${key}`, { thread: `t_${key}`, sender, kind, to: [to] })
    }
    const request = say('request', asker, assistant, 'assign')
    const auto = say('auto', S3, S1)
    const budget = say('budget', S1, S3)
    const trusted = say('trusted', friend, S1)
    const given = say('given', asker, S1, 'assign', 'start_agent')
    const away = say('away', asker, far)
    // A task to a trashed session, settled `gone`: judged as the rest of what the step moves
    const left = say('left', asker, trashed, 'assign', 'start_agent')
    // A message to a trashed session: the gate holds only for a kept one
    const bin = say('bin', asker, trashed)
    // Its sender's project is its thread's, one this store has no row for: untrusted
    const stray = say('stray', far, S1, 'note', 'mail', 'pz')
    const plain = say('plain', S3, S1)
    // A sender with no project (no session here, and not its thread's owner) is no untrusted project's
    const nowhere = post(s.raw, 'm_nowhere', { thread: 't_plain', sender: far, kind: 'note', to: [S1] })
    held(s.raw, request, assistant, 'policy')
    held(s.raw, auto, S1, 'policy')
    held(s.raw, budget, S3, 'budget')
    held(s.raw, trusted, S1, 'policy')
    held(s.raw, given, S1, 'policy')
    held(s.raw, away, far, 'policy')
    held(s.raw, left, trashed, 'policy')
    held(s.raw, bin, trashed, 'policy')
    held(s.raw, nowhere, S1, 'policy')
    held(s.raw, stray, S1, 'policy')
    s.upgrade()
    expect(s.mailbox.heldRows().map((h) => [h.messageId, h.held]).sort()).toEqual([[request, 'policy'], [stray, 'policy']])
    // What goes is `dismissed`, with no retry left: same project, the token guard, a trusted project, a task (only a message is held), a recipient
    // that is no session here or a trashed one, a sender of no project
    for (const [id, to] of [[auto, S1], [budget, S3], [trusted, S1], [given, S1], [away, far], [left, trashed], [bin, trashed], [nowhere, S1]] as const) {
      expect(s.mailbox.recipient(id, to), id).toMatchObject({ held: 'dismissed', attemptAt: null, attempts: 0, lastError: null })
    }
    expect(movedRow(s.raw, left)?.settled).toBe('gone')
    // Never delivered, as before: neither an ended hold nor the request is pending for a turn
    expect(s.mailbox.pendingFor(S1, NOW).map((p) => p.message.id)).toEqual([plain])
    expect(s.mailbox.pendingFor(S3, NOW)).toEqual([])
  })

  it('judges only the rows it moves: a row moved at an earlier start and held by the delivery since stays held', () => {
    const s = v64()
    thread(s.raw, WORK, { owner: S3 })
    const earlier = post(s.raw, 'm_earlier', { thread: WORK, sender: S3, kind: 'note', to: [S1] })
    const now = post(s.raw, 'm_now', { thread: WORK, sender: S3, kind: 'note', to: [S1] })
    held(s.raw, now, S1, 'policy')
    // The build of v74 moved `earlier` at a start and its delivery held it; `now` it never saw
    s.upgrade(74)
    s.raw.prepare(`INSERT INTO mail (id, sender, sender_project, kind, needs_reply, root_id, body, origin, legacy_thread, created_at) VALUES (?, ?, 'p1', 'message', 0, ?, 'note', 'mail', ?, ?)`).run(earlier, S3, earlier, WORK, AT)
    s.raw.prepare(`INSERT INTO mail_recipients (message_id, recipient, due_at, held, settled, settled_at) VALUES (?, ?, ?, 'policy', 'legacy', ?)`).run(earlier, S1, AT, AT)
    s.raw.prepare(`UPDATE mail_receipts SET handled_at = ? WHERE message_id = ?`).run(AT, earlier)
    s.upgrade()
    expect([s.mailbox.recipient(earlier, S1)?.held, s.mailbox.recipient(now, S1)?.held]).toEqual(['policy', 'dismissed'])
  })

  it('a row already there beside a receipt not handled is not the step’s: its hold stays, and its receipt is handled', () => {
    const s = v64()
    thread(s.raw, WORK, { owner: S3 })
    const there = post(s.raw, 'm_there', { thread: WORK, sender: S3, kind: 'note', to: [S1] })
    s.upgrade(74)
    // No build leaves this (its move wrote both sides at once): the copy is written and held, the receipt still pending
    s.raw.prepare(`INSERT INTO mail (id, sender, sender_project, kind, needs_reply, root_id, body, origin, legacy_thread, created_at) VALUES (?, ?, 'p1', 'message', 0, ?, 'note', 'mail', ?, ?)`).run(there, S3, there, WORK, AT)
    s.raw.prepare(`INSERT INTO mail_recipients (message_id, recipient, due_at, held, settled, settled_at) VALUES (?, ?, ?, 'policy', 'legacy', ?)`).run(there, S1, AT, AT)
    s.upgrade()
    // The step's insert is ignored, so the row is none it wrote: judged, a note within one project would be dismissed
    expect(moved(s.raw)).toEqual([expect.objectContaining({ message_id: there, held: 'policy' })])
    expect(receipts(s.raw)).toEqual([expect.objectContaining({ message_id: there, handled_at: NOW })])
  })

  it('a step that fails midway leaves both sides as they were, and the next start moves everything', () => {
    const s = v64()
    fixture(s.raw)
    const was = receipts(s.raw)
    // The step's last statement for a receipt fails after its copy was written: a host that dies between the two sides
    s.raw.exec(`CREATE TRIGGER fail_handled BEFORE UPDATE OF handled_at ON mail_receipts BEGIN SELECT RAISE(ABORT, 'crash'); END`)
    expect(() => s.upgrade()).toThrow(/crash/)
    expect(s.schemaVersion).toBe(74)
    expect([moved(s.raw), rows(s.raw, `SELECT id FROM mail`), receipts(s.raw)]).toEqual([[], [], was])
    s.raw.exec(`DROP TRIGGER fail_handled`)
    s.upgrade()
    expect([s.schemaVersion, moved(s.raw).length]).toEqual([STEP, 8])
  })

  it('leaves a store without a thread table alone', () => {
    const s = v64()
    fixture(s.raw)
    s.raw.exec(`DROP TABLE mail_receipts`)
    s.upgrade()
    expect([s.schemaVersion, rows(s.raw, `SELECT id FROM mail`)]).toEqual([STEP, []])
  })
})

describe('step 75 and the builds before it', () => {
  function file(): string {
    const d = tempRoot('cc-contract-step-')
    dirs.push(d)
    return `${d}/store.db`
  }
  const floor = (db: Database.Database) => rows<{ value: string }>(db, `SELECT value FROM app_settings WHERE key = 'min_reader_version'`)[0]?.value

  it('raises the floor to 74: the builds of v70 to v73 are refused and change nothing, and the build of v74 opens it with nothing left to move', () => {
    const path = file()
    const first = v64(path)
    fixture(first.raw)
    first.upgrade()
    const after = { moved: moved(first.raw), receipts: receipts(first.raw) }
    expect([first.schemaVersion, floor(first.raw)]).toEqual([STEP, '74'])
    first.close()
    for (const version of [70, 71, 72, 73]) {
      expect(() => open(version, path), `v${version}`).toThrow(StoreTooNewError)
      expect(() => open(version, path), `v${version}`).toThrow(new RegExp(`can be read from store version 74 on; this Centralu knows store versions up to ${version}`))
    }
    const v74 = open(74, path)
    stores.push(v74)
    expect([v74.migrationsRun, v74.schemaVersion, floor(v74.raw)]).toEqual([0, STEP, '74'])
    // Its start's move selects nothing, and the marks it deletes at every start are in a table that is still there
    expect(pendingForV74(v74.raw)).toEqual([])
    expect(rows(v74.raw, `SELECT * FROM report_marks`)).toEqual([])
    expect({ moved: moved(v74.raw), receipts: receipts(v74.raw) }).toEqual(after)
  })

  it('runs once: opening the store again runs no step and moves nothing', () => {
    const path = file()
    const first = v64(path)
    fixture(first.raw)
    first.upgrade()
    const after = moved(first.raw)
    expect(after).not.toEqual([])
    // A receipt the step would move if it ran again (nothing writes one): S3's of the note, handled before the step, pending now
    receipt(first.raw, `${HOST}.m_0n`, S3, 'handled_at = NULL')
    expect(pendingForV74(first.raw)).toHaveLength(1)
    first.close()
    const again = open(STEP, path)
    stores.push(again)
    expect([again.migrationsRun, moved(again.raw)]).toEqual([0, after])
  })
})

/** A small seeded generator, so a failing case can be run again from its seed */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('the move is at most once, whatever the old receipts were', () => {
  const KINDS = ['assign', 'question', 'answer', 'note', 'report', 'notice', 'event'] as const
  const HOLDS = [null, null, 'uncertain', 'failed', 'loop', 'budget', 'policy', 'released', 'dismissed'] as const

  it('each pending receipt becomes exactly one row, every old receipt read is handled, and a crash moves nothing twice', () => {
    let linked = 0
    for (let seed = 1; seed <= 30; seed++) {
      const random = rng(seed)
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)] as T
      const s = v64()
      const db = s.raw
      thread(db, 't1', { origin: pick(['mail', 'start_agent', 'person']), owner: S1, assignee: S2 })
      const n = 1 + Math.floor(random() * 12)
      for (let i = 1; i <= n; i++) {
        const key = `m_${String(i).padStart(3, '0')}`
        // Time goes forward, now and then back (a clock set back), and some messages are past retention
        const at = random() < 0.1 ? NOW - 200 * DAY : random() < 0.2 ? NOW - 10_000 - i : NOW - 10_000 + i
        const replyTo = i > 1 && random() < 0.5 ? `${HOST}.m_${String(i - 1).padStart(3, '0')}` : null
        const to = [S1, S2, S3].filter(() => random() < 0.6)
        const id = post(db, key, { thread: 't1', sender: pick([S1, S2, 'centralu', APP]), kind: pick(KINDS), to, at, replyTo, wake: pick([null, 'no']), needsOwner: random() < 0.2 })
        for (const recipient of to) {
          if (random() < 0.4) delivered(db, id, recipient, random() < 0.5)
          if (random() < 0.2) receipt(db, id, recipient, 'read_at = COALESCE(read_at, ?), handled_at = ?', at, at)
          const word = pick(HOLDS)
          if (word) held(db, id, recipient, word)
        }
      }

      type Old = Receipt & { kind: string; created_at: number }
      const isPending = (r: Old) => r.handled_at === null && r.held !== 'dismissed' && r.created_at >= NOW - 180 * DAY && (r.delivered_at === null || r.read_at === null || r.kind === 'question')
      const all = () => rows<Old>(db, `SELECT r.*, m.kind, m.created_at FROM mail_receipts r JOIN mail_messages m ON m.id = r.message_id ORDER BY r.message_id, r.recipient`)
      const expected = all().filter(isPending).map((r) => `${r.message_id}|${r.recipient}`)

      if (expected.length > 0 && random() < 0.5) {
        db.exec(`CREATE TRIGGER crash BEFORE UPDATE OF handled_at ON mail_receipts BEGIN SELECT RAISE(ABORT, 'crash'); END`)
        expect(() => s.upgrade()).toThrow(/crash/)
        db.exec(`DROP TRIGGER crash`)
        expect([s.schemaVersion, moved(db)], `seed ${seed}`).toEqual([74, []])
      }
      s.upgrade()
      expect(moved(db).map((r) => `${r.message_id}|${r.recipient}`), `seed ${seed}`).toEqual(expected)
      expect(all().filter(isPending), `seed ${seed}`).toEqual([])
      for (const r of moved(db)) expect(r.settled).toBe('legacy')
      // No hold the delivery does not know is left on a moved row
      for (const r of moved(db)) expect([null, 'uncertain', 'failed', 'loop', 'policy', 'released', 'dismissed'], `seed ${seed}`).toContain(r.held)
      // A moved message answers its v61 reply target when that was moved too, and its root is that one's root, or itself
      const movedIds = new Set(rows<{ id: string }>(db, `SELECT id FROM mail`).map((m) => m.id))
      for (const m of rows<{ id: string; reply_to: string | null; root_id: string; old_reply: string | null }>(db, `SELECT m.id, m.reply_to, m.root_id, o.reply_to AS old_reply FROM mail m JOIN mail_messages o ON o.id = m.id`)) {
        expect(m.reply_to, `seed ${seed}`).toBe(m.old_reply !== null && movedIds.has(m.old_reply) ? m.old_reply : null)
        const root = rows<{ root_id: string }>(db, `SELECT root_id FROM mail WHERE id = ?`, m.reply_to ?? m.id)[0]
        expect(m.root_id, `seed ${seed}`).toBe(m.reply_to === null ? m.id : root?.root_id)
        if (m.reply_to !== null) linked += 1
      }
    }
    // The root rule above was checked on replies that were linked, not only on messages that answer nothing
    expect(linked).toBeGreaterThan(5)
  })
})
