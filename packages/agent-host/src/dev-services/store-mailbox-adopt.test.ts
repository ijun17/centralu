/**
 * The v65 step against a store the v64 build served, and the move of the mail it left pending (docs/plans/mailbox.md
 * §6.2, §6.3, M1).
 *
 * The v64 build is this build's `Store` with the steps after 64 left out: its schema, and its thread mail written by
 * the statements its `MailRecords` ran (this build's copy, and plain SQL where this build no longer has them). So a test here that reads with the v64
 * build after v65 ran is the swap and the rollback: an older host serving a store a newer one migrated.
 */
import { describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { sessionLiveDefaults } from '@cc/protocol'
import { sessionAddress } from '../mail/address.js'
import { Store } from './store.js'
import type { MigrationStep } from './store/migrations/context.js'
import { legacyChain, movePendingThreadMail } from './store/mailbox-adopt.js'

const HOST = 'hub-aaaaaaaa'
const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000
const S1 = sessionAddress(HOST, 's1')
const S2 = sessionAddress(HOST, 's2')
const S3 = sessionAddress(HOST, 's3')
const APP = `app:${HOST}/p1/board`

/** The newest step the next store knows: 64 is the build before this slice */
let newest = 65

/**
 * A store that is the v64 build until `upgrade`, which runs v65 on the same connection: the v64 build's records
 * (`mail`, `sessions`, which this slice leaves as they were) then work on the store v65 migrated, as a swap's older
 * host or a rollback does
 */
class Versioned extends Store {
  protected override migrationSteps(): MigrationStep[] {
    return super.migrationSteps().filter((s) => s.to <= newest)
  }

  get raw(): Database.Database {
    return this.db
  }

  upgrade(): void {
    newest = 65
    this.migrate()
  }
}

function v64Store(): Versioned {
  newest = 64
  try {
    return new Versioned()
  } finally {
    newest = 65
  }
}

/**
 * Thread mail as the v64 build leaves it, written through its own API:
 * - `q`, a question in a thread with two recipients: delivered to S2 and unread, not delivered to S3 (both pending);
 * - `a`, S2's answer, delivered to S1 and read (not pending), and `n`, a note to S1 not delivered (pending);
 * - `t`, a delegation's assign to S2, pending; `r`, Centralu's quiet report to S1, pending; `e`, an event, pending;
 * - `ap`, an app's needsOwner notice to S1, held `loop`; `pol`, a note held `policy`; `dis`, one the person dismissed;
 * - `old`, a pending note sent 200 days ago.
 */
function v64Mail(store: Versioned): Record<string, string> {
  expect(store.schemaVersion).toBe(64)
  const clock = { t: NOW - 60_000 }
  const r = store.mail
  const thread = { thread: { id: `${HOST}.t_colours` } }
  r.insertThread({ id: thread.thread.id, home: HOST, projectId: null, subject: 'colours', origin: 'mail', depth: 0, parentId: null, follows: [], state: 'open', owner: S1, assignee: null, next: null, links: {} }, clock.t)
  const say = (id: string, sender: string, kind: 'question' | 'answer' | 'note', body: string, to: readonly string[], replyTo: string | null = null) => {
    r.insertMessage({ id, threadId: thread.thread.id, sender, kind, urgent: false, needsOwner: false, wake: null, replyTo, body, facts: {}, dedupeKey: null, createdAt: clock.t })
    for (const x of to) r.insertReceipt(id, x, clock.t)
    return id
  }
  const q = say(`${HOST}.m_0q`, S1, 'question', 'which colour?', [S2, S3])
  setV64(store, S2, [q], 'attempt_at = ?, attempts = attempts + 1', clock.t)
  delivered(store, S2, [q], clock.t)
  clock.t += 1000
  const a = say(`${HOST}.m_0a`, S2, 'answer', 'nebula purple', [S1, S3], q)
  delivered(store, S1, [a], clock.t, true)
  delivered(store, S3, [a], clock.t, true)
  clock.t += 1000
  const n = say(`${HOST}.m_0n`, S2, 'note', 'also, green', [S1, S3])
  setV64(store, S3, [n], 'read_at = COALESCE(read_at, ?), handled_at = COALESCE(handled_at, ?)', clock.t, clock.t)

  r.insertThread({ id: `${HOST}.t_work`, home: HOST, projectId: 'p1', subject: 'land #12', origin: 'start_agent', depth: 1, parentId: null, follows: [], state: 'open', owner: S1, assignee: S2, next: null, links: {} }, clock.t)
  const post = (id: string, threadId: string, sender: string, kind: 'assign' | 'report' | 'event' | 'notice' | 'note', extra: { wake?: 'no' | null; needsOwner?: boolean; facts?: Record<string, unknown>; at?: number } = {}) => {
    r.insertMessage({ id, threadId, sender, kind, urgent: false, needsOwner: extra.needsOwner ?? false, wake: extra.wake ?? null, replyTo: null, body: `${kind} ${id}`, facts: extra.facts ?? {}, dedupeKey: null, createdAt: extra.at ?? clock.t })
    return id
  }
  const t = post(`${HOST}.m_t`, `${HOST}.t_work`, S1, 'assign')
  r.insertReceipt(t, S2, clock.t)
  const rep = post(`${HOST}.m_r`, `${HOST}.t_work`, 'centralu', 'report', { wake: 'no', facts: { outcome: 'paused', waitingOn: [`${HOST}.t_x`, `${HOST}.t_y`], about: { session: S2 } } })
  r.insertReceipt(rep, S1, clock.t)
  const e = post(`${HOST}.m_e`, `${HOST}.t_work`, 'centralu', 'event')
  r.insertReceipt(e, S1, clock.t)
  const ap = post(`${HOST}.m_ap`, `${HOST}.t_work`, APP, 'notice', { needsOwner: true })
  r.insertReceipt(ap, S1, clock.t)
  heldV64(store, S1, [ap], 'loop')
  const pol = post(`${HOST}.m_pol`, `${HOST}.t_work`, S2, 'note')
  r.insertReceipt(pol, S1, clock.t)
  heldV64(store, S1, [pol], 'policy')
  const dis = post(`${HOST}.m_dis`, `${HOST}.t_work`, S2, 'note')
  r.insertReceipt(dis, S3, clock.t)
  heldV64(store, S3, [dis], 'failed')
  r.releaseHeld(S3, [dis], 'dismissed', clock.t)
  const old = post(`${HOST}.m_old`, `${HOST}.t_work`, S2, 'note', { at: NOW - 200 * DAY })
  r.insertReceipt(old, S1, NOW - 200 * DAY)
  return { thread: thread.thread.id, q, a, n, t, rep, e, ap, pol, dis, old }
}

/** A v64 store with that mail in it, upgraded to v65 */
function upgraded(): { store: Versioned; db: Database.Database; ids: Record<string, string> } {
  const store = v64Store()
  const ids = v64Mail(store)
  store.upgrade()
  return { store, db: store.raw, ids }
}

/** Receipt fields as the v64 build set them (`markAttempt`, `markDelivered`, `markHandledIds`, `setHeld`), in plain SQL */
function setV64(store: Versioned, recipient: string, ids: readonly string[], set: string, ...args: unknown[]): void {
  store.raw.prepare(`UPDATE mail_receipts SET ${set} WHERE recipient = ? AND message_id IN (SELECT value FROM json_each(?))`).run(...args, recipient, JSON.stringify(ids))
}
const delivered = (store: Versioned, recipient: string, ids: readonly string[], at: number, read = false) =>
  setV64(store, recipient, ids, `delivered_at = ?, last_error = NULL${read ? ', read_at = COALESCE(read_at, ?)' : ''}`, ...(read ? [at, at] : [at]))
const heldV64 = (store: Versioned, recipient: string, ids: readonly string[], held: string) => setV64(store, recipient, ids, 'held = ?', held)

function rawRows<T>(db: Database.Database, sql: string, ...args: unknown[]): T[] {
  return db.prepare<unknown[], T>(sql).all(...args)
}

describe('v65 on a store the v64 build served', () => {
  it('v65 creates the mailbox tables and mail_turns.message_id and starter_id', () => {
    const store = v64Store()
    v64Mail(store)
    const ran = store.migrationsRun
    store.upgrade()
    expect(store.schemaVersion).toBe(65)
    expect(store.migrationsRun - ran).toBe(1)
    const tables = rawRows<{ name: string }>(store.raw, `SELECT name FROM sqlite_master WHERE type = 'table'`).map((t) => t.name)
    expect(tables).toEqual(expect.arrayContaining(['mail', 'mail_recipients', 'mail_threads', 'mail_receipts']))
    const cols = (t: string) => rawRows<{ name: string }>(store.raw, `SELECT name FROM pragma_table_info(?)`, t).map((c) => c.name)
    expect(cols('mail_turns')).toEqual(expect.arrayContaining(['thread_id', 'message_id', 'starter_id', 'ended_how']))
    expect(cols('sessions')).toContain('mail_args')
    const step = (new Store() as unknown as { migrationSteps(): MigrationStep[] }).migrationSteps().find((s) => s.to === 65)
    expect(step).toMatchObject({ breaksOlderReaders: false })
    expect(step?.heavy).toBeUndefined()
    store.close()
  })

  it('an older build’s mail queries run on a v65 store, and what it wrote reads as before', () => {
    const store = v64Store()
    const ids = v64Mail(store)
    const view = () => ({
      pending: [S1, S2, S3].map((x) => store.mail.pendingFor(x, NOW).map((p) => p.message.id)),
      receipts: Object.values(ids).map((id) => store.mail.receiptsOf(id)),
      thread: store.mail.messagesTail(ids.thread ?? '', 50),
      held: store.mail.heldReceipts(),
    })
    const was = view()
    store.upgrade()
    try {
      expect(view()).toEqual(was)
      // The v64 build's statements go on working: posting, turns, sessions, retention
      const next = `${HOST}.m_next`
      store.mail.insertMessage({ id: next, threadId: ids.thread ?? '', sender: S1, kind: 'note', urgent: false, needsOwner: false, wake: null, replyTo: null, body: 'still here', facts: {}, dedupeKey: null, createdAt: NOW })
      for (const x of [S2, S3]) store.mail.insertReceipt(next, x, NOW)
      expect(store.mail.receiptsOf(next).map((r) => r.recipient)).toEqual([S2, S3])
      store.raw.prepare(`INSERT INTO mail_turns (session_id, turn_seq, thread_id, started_by, started_at) VALUES ('s2', 1, ?, 'mail', ?)`).run(ids.thread ?? '', NOW)
      store.raw.prepare(`UPDATE mail_turns SET ended_at = ?, outcome = 'finished' WHERE session_id = 's2' AND turn_seq = 1 AND ended_at IS NULL`).run(NOW + 1)
      expect(rawRows(store.raw, `SELECT session_id, turn_seq, thread_id, started_by, started_at, ended_at, outcome FROM mail_turns WHERE session_id = 's2'`)).toEqual([
        { session_id: 's2', turn_seq: 1, thread_id: ids.thread, started_by: 'mail', started_at: NOW, ended_at: NOW + 1, outcome: 'finished' },
      ])
      store.projects.addProject({ id: 'p1', path: '/tmp/p1', name: 'alpha' })
      store.sessions.upsertSession({
        id: 's9', projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: 'nine', autoNamed: false, state: 'idle', lastReadSeq: 0, lastSeq: 0,
        createdAt: 1, waitingSince: null, live: false, model: null, effort: null, verbosity: null, serviceTier: null, permissionPreset: 'normal',
        importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
      })
      expect(store.sessions.listSessions().map((x) => x.name)).toEqual(['nine'])
      expect(store.mail.sweep(NOW)).toMatchObject({ threads: 0 })
    } finally {
      store.close()
    }
  })
})

type Receipt = { message_id: string; recipient: string; delivered_at: number | null; read_at: number | null; handled_at: number | null; held: string | null }
type Moved = { message_id: string; recipient: string; delivered_at: number | null; held: string | null; settled: string | null }
const receipts = (db: Database.Database) => rawRows<Receipt>(db, `SELECT message_id, recipient, delivered_at, read_at, handled_at, held FROM mail_receipts ORDER BY message_id, recipient`)
const moved = (db: Database.Database) => rawRows<Moved>(db, `SELECT message_id, recipient, delivered_at, held, settled FROM mail_recipients ORDER BY message_id, recipient`)

describe('movePendingThreadMail', () => {
  it('the move copies each pending thread message once with its id and marks the old receipt handled', () => {
    const { store, db, ids } = upgraded()
    expect(movePendingThreadMail(db, NOW, () => null)).toEqual({ messages: 7, recipients: 8 })
    const m = (k: string) => store.mailbox.message(ids[k] ?? '')
    expect(m('q')).toMatchObject({ kind: 'message', needsReply: true, legacyThread: ids.thread, origin: 'mail', facts: { legacyKind: 'question' }, rootId: ids.q, causeId: null, depth: 0 })
    expect(m('n')).toMatchObject({ kind: 'message', needsReply: false, facts: { legacyKind: 'note' } })
    expect(m('t')).toMatchObject({ kind: 'task', needsReply: false, origin: 'start_agent', senderProject: 'p1', facts: { legacyKind: 'assign' } })
    expect(m('rep')).toMatchObject({ kind: 'report', facts: { legacyKind: 'report', outcome: 'paused', waitingOn: 2 } })
    expect(m('e')).toMatchObject({ kind: 'notice', facts: { legacyKind: 'event', quiet: true } })
    expect(m('ap')).toMatchObject({ kind: 'notice', facts: { legacyKind: 'notice', needsOwner: true } })
    expect(m('pol')).toMatchObject({ kind: 'message', facts: { legacyKind: 'note' } })
    // Not pending: delivered and read, dismissed, or past retention
    for (const k of ['a', 'dis', 'old']) expect(m(k)).toBeUndefined()

    // The question to two recipients is one message with a row each: S2's delivered, S3's not
    expect(store.mailbox.recipients(ids.q ?? '')).toEqual([
      expect.objectContaining({ recipient: S2, settled: 'legacy', deliveredAt: NOW - 60_000 }),
      expect.objectContaining({ recipient: S3, settled: 'legacy', deliveredAt: null }),
    ])
    // The old receipts of everything moved are handled, and delivered for an older build
    const left = receipts(db).filter((r) => moved(db).some((x) => x.message_id === r.message_id && x.recipient === r.recipient))
    expect(left).toHaveLength(8)
    for (const r of left) expect(r).toMatchObject({ handled_at: NOW, delivered_at: expect.any(Number) })
    // And what was not moved is as it was
    expect(receipts(db).find((r) => r.message_id === ids.old)).toMatchObject({ handled_at: null, delivered_at: null })
    // The v64 build serving again delivers none of it
    expect([S1, S2, S3].flatMap((x) => store.mail.pendingFor(x, NOW).map((p) => p.message.id))).toEqual([ids.old])
    store.close()
  })

  it('the move keeps a quiet report quiet and an app’s needsOwner', () => {
    const { store, db, ids } = upgraded()
    movePendingThreadMail(db, NOW, () => null)
    expect(store.mailbox.message(ids.rep ?? '')?.facts.quiet).toBe(true)
    expect(store.mailbox.message(ids.t ?? '')?.facts.quiet).toBeUndefined()
    expect(store.mailbox.message(ids.ap ?? '')?.facts).toMatchObject({ needsOwner: true })
    expect(store.mailbox.message(ids.ap ?? '')?.facts.quiet).toBeUndefined()
    store.close()
  })

  it('a second move finds nothing', () => {
    const { store, db } = upgraded()
    movePendingThreadMail(db, NOW, () => null)
    const after = moved(db)
    expect(movePendingThreadMail(db, NOW + 1, () => null)).toEqual({ messages: 0, recipients: 0 })
    expect(moved(db)).toEqual(after)
    store.close()
  })

  it('a move that fails midway leaves both sides as they were', () => {
    const { store, db } = upgraded()
    const was = receipts(db)
    // The last statement of the move fails after the copies were written: the crash of a host between the two sides
    db.exec(`CREATE TRIGGER fail_handled BEFORE UPDATE OF handled_at ON mail_receipts BEGIN SELECT RAISE(ABORT, 'crash'); END`)
    expect(() => movePendingThreadMail(db, NOW, () => null)).toThrow(/crash/)
    expect(moved(db)).toEqual([])
    expect(rawRows(db, `SELECT id FROM mail`)).toEqual([])
    expect(receipts(db)).toEqual(was)
    db.exec(`DROP TRIGGER fail_handled`)
    expect(movePendingThreadMail(db, NOW, () => null)).toEqual({ messages: 7, recipients: 8 })
    store.close()
  })

  it('the move leaves history and mail past retention alone', () => {
    const { store, db, ids } = upgraded()
    movePendingThreadMail(db, NOW, () => null)
    expect(store.mailbox.message(ids.a ?? '')).toBeUndefined()
    expect(store.mailbox.message(ids.old ?? '')).toBeUndefined()
    store.close()
  })

  it('moved undelivered rows stay pending, and every old hold is carried: the move lets nothing held go', () => {
    const { store, db, ids } = upgraded()
    movePendingThreadMail(db, NOW, () => null)
    expect(store.mailbox.pendingFor(S1, NOW).map((p) => p.message.id)).toEqual([ids.n, ids.e, ids.rep])
    expect(store.mailbox.pendingFor(S3, NOW).map((p) => p.message.id)).toEqual([ids.q])
    expect(store.mailbox.recipient(ids.pol ?? '', S1)?.held).toBe('policy')
    expect(store.mailbox.recipient(ids.ap ?? '', S1)?.held).toBe('loop')
    expect(store.mailbox.heldRows().map((r) => r.messageId)).toEqual([ids.ap, ids.pol])
    // A moved row is settled `legacy`: never watched, so neither reminded nor waited on
    expect(store.mailbox.watchedTo(S3)).toEqual([])
    store.close()
  })

  it('a reply whose target moved in an earlier run keeps the target’s root', () => {
    const { store, db, ids } = upgraded()
    movePendingThreadMail(db, NOW, () => null)
    const reply = `${HOST}.m_agreed`
    store.mail.insertMessage({ id: reply, threadId: ids.thread ?? '', sender: S3, kind: 'answer', urgent: false, needsOwner: false, wake: null, replyTo: ids.q ?? null, body: 'agreed', facts: {}, dedupeKey: null, createdAt: NOW + 10 })
    store.mail.insertReceipt(reply, S1, NOW + 10)
    movePendingThreadMail(db, NOW + 20, () => null)
    expect(store.mailbox.message(reply)).toMatchObject({ replyTo: ids.q, rootId: ids.q })
    store.close()
  })

  it('the move marks the old receipt read, so the v64 build does not count moved mail as work in hand', () => {
    const { store, db, ids } = upgraded()
    // The v64 build's `hasMailInHand`: a receipt of the thread to the session, unread and not held
    const inHand = (threadId: string, recipient: string) =>
      rawRows(db, `SELECT 1 FROM mail_receipts r JOIN mail_messages m ON m.id = r.message_id WHERE m.thread_id = ? AND r.recipient = ? AND r.read_at IS NULL AND (r.held IS NULL OR r.held = 'released')`, threadId, recipient).length > 0
    expect(inHand(`${HOST}.t_work`, S2)).toBe(true)
    movePendingThreadMail(db, NOW, () => null)
    expect(inHand(`${HOST}.t_work`, S2)).toBe(false)
    expect(inHand(ids.thread ?? '', S3)).toBe(false)
    expect(receipts(db).find((r) => r.message_id === ids.q && r.recipient === S2)?.read_at).toBe(NOW)
    store.close()
  })

  it('the move carries the person’s Resend of policy-held mail as released, not held again', () => {
    const { store, db } = upgraded()
    const id = `${HOST}.m_resent`
    store.mail.insertMessage({ id, threadId: `${HOST}.t_work`, sender: S2, kind: 'note', urgent: false, needsOwner: false, wake: null, replyTo: null, body: 'resent', facts: {}, dedupeKey: null, createdAt: NOW - 1000 })
    store.mail.insertReceipt(id, S3, NOW - 1000)
    heldV64(store, S3, [id], 'policy')
    store.mail.releaseHeld(S3, [id], null, NOW - 500)
    expect(receipts(db).find((r) => r.message_id === id)?.held).toBe('released')
    movePendingThreadMail(db, NOW, () => null)
    expect(store.mailbox.recipient(id, S3)).toMatchObject({ held: 'released', deliveredAt: null })
    expect(store.mailbox.pendingFor(S3, NOW).map((p) => p.message.id)).toContain(id)
    store.close()
  })

  it('a reply stamped before its target (the clock went back) is still linked to it', () => {
    const { store, db } = upgraded()
    const post = (id: string, replyTo: string | null, at: number) => {
      store.mail.insertMessage({ id, threadId: `${HOST}.t_work`, sender: S2, kind: 'note', urgent: false, needsOwner: false, wake: null, replyTo, body: id, facts: {}, dedupeKey: null, createdAt: at })
      store.mail.insertReceipt(id, S1, at)
    }
    post(`${HOST}.m_first`, null, NOW - 1000)
    post(`${HOST}.m_back`, `${HOST}.m_first`, NOW - 5000)
    movePendingThreadMail(db, NOW, () => null)
    expect(store.mailbox.message(`${HOST}.m_back`)).toMatchObject({ replyTo: `${HOST}.m_first`, rootId: `${HOST}.m_first` })
    store.close()
  })

  it('legacyChain reads an old thread oldest first', () => {
    const { store, db, ids } = upgraded()
    expect(legacyChain(db, ids.thread ?? '', undefined, 50).map((m) => m.id)).toEqual([ids.q, ids.a, ids.n])
    expect(legacyChain(db, ids.thread ?? '', 3, 1).map((m) => m.id)).toEqual([ids.a])
    store.close()
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

  it('each pending receipt becomes exactly one row, every old receipt read is handled, and a repeat or a crash moves nothing twice', () => {
    let linked = 0
    for (let seed = 1; seed <= 30; seed++) {
      const random = rng(seed)
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)] as T
      const store = v64Store()
      const db = store.raw
      try {
        store.mail.insertThread({ id: 't1', home: HOST, projectId: null, subject: 's', origin: pick(['mail', 'start_agent', 'person']), depth: 0, parentId: null, follows: [], state: 'open', owner: S1, assignee: S2, next: null, links: {} }, NOW)
        const n = 1 + Math.floor(random() * 12)
        for (let i = 1; i <= n; i++) {
          const id = `${HOST}.m_${String(i).padStart(3, '0')}`
          // Time goes forward, now and then back (a clock set back), and some messages are past retention
          const at = random() < 0.1 ? NOW - 200 * DAY : random() < 0.2 ? NOW - 10_000 - i : NOW - 10_000 + i
          const replyTo = i > 1 && random() < 0.5 ? `${HOST}.m_${String(i - 1).padStart(3, '0')}` : null
          store.mail.insertMessage({ id, threadId: 't1', sender: pick([S1, S2, 'centralu', APP]), kind: pick(KINDS), urgent: false, needsOwner: random() < 0.2, wake: pick([null, 'no']), replyTo, body: 'b', facts: {}, dedupeKey: null, createdAt: at })
          for (const to of [S1, S2, S3].filter(() => random() < 0.6)) {
            store.mail.insertReceipt(id, to, at)
            if (random() < 0.4) delivered(store, to, [id], at, random() < 0.5)
            if (random() < 0.2) setV64(store, to, [id], 'read_at = COALESCE(read_at, ?), handled_at = COALESCE(handled_at, ?)', at, at)
            const held = pick(HOLDS)
            if (held) heldV64(store, to, [id], held)
          }
        }

        type Old = Receipt & { kind: string; created_at: number }
        const isPending = (r: Old) =>
          r.handled_at === null && r.held !== 'dismissed' && r.created_at >= NOW - 180 * DAY && (r.delivered_at === null || r.read_at === null || r.kind === 'question')
        const all = () => rawRows<Old>(db, `SELECT r.*, m.kind, m.created_at FROM mail_receipts r JOIN mail_messages m ON m.id = r.message_id ORDER BY r.message_id, r.recipient`)
        const expected = all().filter(isPending).map((r) => `${r.message_id}|${r.recipient}`)

        store.upgrade()
        if (expected.length > 0 && random() < 0.5) {
          db.exec(`CREATE TRIGGER crash BEFORE UPDATE OF handled_at ON mail_receipts BEGIN SELECT RAISE(ABORT, 'crash'); END`)
          expect(() => movePendingThreadMail(db, NOW, () => null)).toThrow(/crash/)
          db.exec(`DROP TRIGGER crash`)
          expect(moved(db), `seed ${seed}`).toEqual([])
        }
        const first = movePendingThreadMail(db, NOW, () => null)
        const second = movePendingThreadMail(db, NOW + 1, () => null)
        expect(moved(db).map((r) => `${r.message_id}|${r.recipient}`), `seed ${seed}`).toEqual(expected)
        expect(first.recipients, `seed ${seed}`).toBe(expected.length)
        expect(second, `seed ${seed}`).toEqual({ messages: 0, recipients: 0 })
        expect(all().filter(isPending), `seed ${seed}`).toEqual([])
        for (const r of moved(db)) expect(r.settled).toBe('legacy')
        // A moved message answers its v61 reply target when that was moved too, and its root is that one's root, or itself
        const movedIds = new Set(rawRows<{ id: string }>(db, `SELECT id FROM mail`).map((m) => m.id))
        for (const m of rawRows<{ id: string; reply_to: string | null; root_id: string; old_reply: string | null }>(
          db,
          `SELECT m.id, m.reply_to, m.root_id, o.reply_to AS old_reply FROM mail m JOIN mail_messages o ON o.id = m.id`,
        )) {
          expect(m.reply_to, `seed ${seed}`).toBe(m.old_reply !== null && movedIds.has(m.old_reply) ? m.old_reply : null)
          const root = rawRows<{ root_id: string }>(db, `SELECT root_id FROM mail WHERE id = ?`, m.reply_to ?? m.id)[0]
          expect(m.root_id, `seed ${seed}`).toBe(m.reply_to === null ? m.id : root?.root_id)
          if (m.reply_to !== null) linked += 1
        }
      } finally {
        store.close()
      }
    }
    // The root rule above was checked on replies that were linked, not only on messages that answer nothing
    expect(linked).toBeGreaterThan(5)
  })
})
