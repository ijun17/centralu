/**
 * Step 74 (#2258 item 1, docs/plans/mailbox.md M7, M8): the task rows become the one record of owed work. What a build before v70 kept beside
 * them (requests held for a busy session, report marks, delegated turns, whose a turn is) becomes mail once and goes, and the store's floor
 * goes to 70: the builds of v70 on (beta.58 on) write none of it but the marks they leave as they go, which stay in a table no build reads after this
 * step: store step v75 raises the store's floor to v74, and a later step drops the table.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { sessionAddress } from '../mail/address.js'
import { removeTree, tempRoot } from '../temp-dir.test-helpers.js'
import { Store, StoreTooNewError } from './store.js'
import type { MigrationStep } from './store/migrations/context.js'

/** The step these tests are about: a later step is its own file's to check */
const STEP = 74
const HOST = 'hub-0000abcd'
const at = (id: string) => sessionAddress(HOST, id)
const ADOPTED = 'Work given before this version of Centralu wrote it down as mail. The conversation of the session that does it shows what was asked.'

/** The newest step the next store knows */
let newest = STEP

/** The store as the build of `newest` opens it */
class Build extends Store {
  protected override migrationSteps(): MigrationStep[] {
    return super.migrationSteps().filter((s) => s.to <= newest)
  }

  get raw(): Database.Database {
    return this.db
  }
}

function open(version: number, file: string): Build {
  newest = version
  try {
    return new Build(file)
  } finally {
    newest = STEP
  }
}

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await removeTree(d)
})

/** A raw write as the build of `version` makes it, on a store that build opens */
function as<T>(version: number, file: string, f: (db: Database.Database) => T): T {
  const s = open(version, file)
  try {
    return f(s.raw)
  } finally {
    s.close()
  }
}

const count = (db: Database.Database, table: string) => (db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n
const setting = (db: Database.Database, key: string) => (db.prepare(`SELECT value FROM app_settings WHERE key = ?`).get(key) as { value: string } | undefined)?.value ?? null

/**
 * A store the build of v69 (beta.57) left: sessions a (the caller), w (a's child), b, c, d, t (in the trash) and one whose id no address carries;
 * a's task to w given by mail, a's task to c answered already, and a's message to d; requests it held for b and w, one of them longer than a task and
 * one blank; marks owed to a by w (which has that task open), by c and d (which have none open), by t and by a itself, and to w by b (which has none)
 */
function v69Store(): string {
  const d = tempRoot('cc-owed-work-')
  dirs.push(d)
  const file = `${d}/store.db`
  as(69, file, (db) => {
    const session = (id: string, askedBy: string | null, deleted = false) =>
      db.prepare(`INSERT INTO sessions (id, project_id, tool, name, created_at, asked_by_session_id, deleted_at) VALUES (?, 'p1', 'claude', ?, 1, ?, ?)`).run(id, id, askedBy, deleted ? 5 : null)
    db.prepare(`INSERT INTO projects (id, path, name, created_at) VALUES ('p1', '/tmp/p1', 'alpha', 1)`).run()
    session('a', null)
    session('w', 'a')
    session('b', null)
    session('t', null, true)
    session('x/y', null)
    session('c', null)
    session('d', null)
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('hub.selfId', ?)`).run(HOST)
    db.prepare(`INSERT INTO mail (id, sender, kind, root_id, body, origin, created_at) VALUES ('${HOST}.m_01', ?, 'task', '${HOST}.m_01', 'land #12', 'start_agent', 1)`).run(at('a'))
    db.prepare(`INSERT INTO mail_recipients (message_id, recipient, due_at, delivered_at) VALUES ('${HOST}.m_01', ?, 1, 1)`).run(at('w'))
    // Only an open task covers a mark: a settled one, or mail that is no task, does not
    db.prepare(`INSERT INTO mail (id, sender, kind, root_id, body, origin, created_at) VALUES ('${HOST}.m_00a', ?, 'task', '${HOST}.m_00a', 'done long ago', 'send_to_session', 1)`).run(at('a'))
    db.prepare(`INSERT INTO mail_recipients (message_id, recipient, due_at, delivered_at, settled) VALUES ('${HOST}.m_00a', ?, 1, 1, 'answered')`).run(at('c'))
    db.prepare(`INSERT INTO mail (id, sender, kind, root_id, body, origin, created_at) VALUES ('${HOST}.m_00b', ?, 'message', '${HOST}.m_00b', 'fyi', 'mail', 1)`).run(at('a'))
    db.prepare(`INSERT INTO mail_recipients (message_id, recipient, due_at, delivered_at) VALUES ('${HOST}.m_00b', ?, 1, 1)`).run(at('d'))
    const queue = db.prepare(`INSERT INTO queued_requests (id, session_id, caller_session_id, via, text, queued_at) VALUES (?, ?, ?, ?, ?, ?)`)
    queue.run('q1', 'b', 'a', 'agent_session', 'run the linter too', 1)
    queue.run('q2', 'w', 'a', 'ask_project', 'what does parse() return?', 2)
    queue.run('q3', 'b', 't', 'send_to_session', 'from the trash', 3)
    queue.run('q4', 'b', 'a', 'some_future_tool', 'unknown', 4)
    queue.run('q5', 'w', 'b', 'send_to_session', `  ${'x'.repeat(20_000)}`, 5)
    queue.run('q6', 'b', 'x/y', 'send_to_session', 'from an id no address carries', 6)
    queue.run('q7', 'b', 'a', 'send_to_session', ' \n\t ', 7)
    // The boundary of the cut: 16,000 characters stay whole, 16,001 are cut
    queue.run('q8', 'w', 'b', 'send_to_session', 'y'.repeat(16_000), 8)
    queue.run('q9', 'w', 'b', 'send_to_session', 'z'.repeat(16_001), 9)
    const mark = db.prepare(`INSERT INTO report_marks (session_id, caller_session_id, marked_at) VALUES (?, ?, ?)`)
    mark.run('w', 'a', 1)
    mark.run('b', 'w', 2)
    mark.run('t', 'a', 3)
    mark.run('a', 'a', 4)
    mark.run('c', 'a', 5)
    mark.run('d', 'a', 6)
    db.prepare(`INSERT INTO delegated_turns (session_id, caller_session_id, started_at) VALUES ('w', 'a', 1)`).run()
    for (const key of ['turn_inputs:w', 'report_turn:w', 'input_origins:a', 'report_paused:w', 'person_report_paused:a', 'turn_span:w', 'report_paused']) {
      db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, '{}')`).run(key)
    }
  })
  return file
}

describe('step 74: one record of owed work (#2258)', () => {
  it("turns a v69 build's held requests and task-less marks into tasks, then deletes every old row", () => {
    const file = v69Store()
    const s = open(STEP, file)
    try {
      const tasks = s.raw
        .prepare(`SELECT m.sender, r.recipient, m.body, m.origin, m.sender_project AS project, r.delivered_at AS delivered, r.read_at AS readAt, r.due_at - m.created_at AS dueIn FROM mail m JOIN mail_recipients r ON r.message_id = m.id WHERE m.kind = 'task' ORDER BY m.id`)
        .all()
      const adopted = (sender: string, recipient: string) => ({ sender: at(sender), recipient: at(recipient), body: ADOPTED, origin: 'send_to_session', project: 'p1', delivered: expect.any(Number), readAt: expect.any(Number), dueIn: 0 })
      expect(tasks).toEqual([
        { sender: at('a'), recipient: at('c'), body: 'done long ago', origin: 'send_to_session', project: null, delivered: 1, readAt: null, dueIn: 0 },
        { sender: at('a'), recipient: at('w'), body: 'land #12', origin: 'start_agent', project: null, delivered: 1, readAt: null, dueIn: 0 },
        // Held requests: not delivered, due after the delivery's 2 s gap; one from the trash, a blank one and one through a tool no build knows make none
        { sender: at('a'), recipient: at('b'), body: 'run the linter too', origin: 'agent_session', project: 'p1', delivered: null, readAt: null, dueIn: 2_000 },
        { sender: at('a'), recipient: at('w'), body: 'what does parse() return?', origin: 'ask_project', project: 'p1', delivered: null, readAt: null, dueIn: 2_000 },
        // Trimmed and cut as a task is, saying the rest was not kept; the one from an id no address carries makes none and stops nothing
        { sender: at('b'), recipient: at('w'), body: expect.stringMatching(/^x{15000}x*\n\[Centralu: cut here\. The request was longer; the rest was not kept\.\]$/), origin: 'send_to_session', project: 'p1', delivered: null, readAt: null, dueIn: 2_000 },
        { sender: at('b'), recipient: at('w'), body: 'y'.repeat(16_000), origin: 'send_to_session', project: 'p1', delivered: null, readAt: null, dueIn: 2_000 },
        { sender: at('b'), recipient: at('w'), body: expect.stringMatching(/^z+\n\[Centralu: cut here\. The request was longer; the rest was not kept\.\]$/), origin: 'send_to_session', project: 'p1', delivered: null, readAt: null, dueIn: 2_000 },
        // The marks with no open task: delivered and read, `send_to_session` since none was started by its caller. a's to w had one open, t is trashed,
        // a is itself; c's task from a is settled and d's mail from a is no task, so they make one each
        adopted('w', 'b'),
        adopted('a', 'c'),
        adopted('a', 'd'),
      ])
      expect([4, 6].map((i) => (tasks[i] as { body: string }).body.length)).toEqual([16_000, 16_000])
      expect(['queued_requests', 'report_marks', 'delegated_turns'].map((t) => count(s.raw, t))).toEqual([0, 0, 0])
      const keys = (s.raw.prepare(`SELECT key FROM app_settings WHERE key LIKE '%:%' OR key = 'report_paused' ORDER BY key`).all() as { key: string }[]).map((r) => r.key)
      expect(keys).toEqual(['report_paused', 'turn_span:w'])
      // The tasks are mail the store reads as any
      expect(s.mailbox.newestTask(at('w'), at('b'))).toMatchObject({ body: ADOPTED, origin: 'send_to_session' })
    } finally {
      s.close()
    }
    const again = open(STEP, file)
    try {
      expect(again.migrationsRun).toBe(0)
    } finally {
      again.close()
    }
  })

  it('a mark for a session its caller started gets a start_agent task; the host id is made when the store has none', () => {
    const file = v69Store()
    as(69, file, (db) => {
      db.exec(`DELETE FROM mail_recipients; DELETE FROM mail; DELETE FROM queued_requests; DELETE FROM report_marks WHERE session_id <> 'w'; DELETE FROM app_settings WHERE key = 'hub.selfId'`)
    })
    const s = open(STEP, file)
    try {
      const host = setting(s.raw, 'hub.selfId')
      expect(host).toMatch(/^hub-[0-9a-f]{8}$/)
      expect(s.mailbox.newestTask(sessionAddress(host!, 'a'), sessionAddress(host!, 'w'))).toMatchObject({ body: ADOPTED, origin: 'start_agent' })
    } finally {
      s.close()
    }
  })

  it('raises the floor to 70: the builds of v70 and v72 open the store, the build of v69 is refused and changes nothing', () => {
    const file = v69Store()
    open(STEP, file).close()
    expect(as(STEP, file, (db) => setting(db, 'min_reader_version'))).toBe('70')
    for (const version of [70, 72]) {
      const older = open(version, file)
      expect(older.migrationsRun).toBe(0)
      older.close()
    }
    expect(() => open(69, file)).toThrow(StoreTooNewError)
    expect(() => open(69, file)).toThrow(/can be read from store version 70 on; this Centralu knows store versions up to 69/)
    as(STEP, file, (db) => expect([db.pragma('user_version', { simple: true }), setting(db, 'min_reader_version')]).toEqual([STEP, '70']))
  })
})
