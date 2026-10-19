/**
 * #418: a session's subagent steps go to the trash without the session, come back under their cards, and leave for
 * good only from the trash.
 *
 * The case measured: 46 MB of a 237 MB store were one live session's subagent steps, and the only way to let them go was
 * to delete the conversation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StoredMessage } from '@cc/protocol'
import { sessionLiveDefaults } from '@cc/protocol'
import { Store } from './store.js'

const session = (s: Store, id: string, projectId: string | null = 'p1') =>
  s.sessions.upsertSession({
    id, projectId, kind: 'worker', tool: 'claude', externalId: null, name: `name of ${id}`, autoNamed: false, state: 'idle',
    lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null,
    verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null,
    parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
  })

const seeded = (file = ':memory:') => {
  const s = new Store(file)
  s.projects.addProject({ id: 'p1', path: '/tmp/p1', name: 'alpha' })
  session(s, 's1')
  session(s, 's2', null)
  return s
}

const KEEP_ALL = { projectId: 'p1', projectName: 'alpha', projectPath: '/tmp/p1', removeExternal: false, removeWorktree: false }
const A = 'toolu_a'
const B = 'toolu_b'

/** `n` steps of the subagent `parent` launched, each a reply naming its number */
const steps = (s: Store, sessionId: string, parent: string, n: number) => {
  for (let i = 1; i <= n; i++) {
    s.messages.appendSubagentMessage(sessionId, parent, {
      role: 'assistant', kind: 'text', payload: { type: 'message_delta', sessionId, role: 'assistant', text: `${parent} step ${i} saw ./shot.png` }, ts: i,
    })
  }
}
const bytesOf = (sessionId: string, parent: string, from: number, to: number) => {
  let n = 0
  for (let i = from; i <= to; i++) n += Buffer.byteLength(JSON.stringify({ type: 'message_delta', sessionId, role: 'assistant', text: `${parent} step ${i} saw ./shot.png` }))
  return n
}
const seqs = (rows: StoredMessage[]) => rows.map((r) => r.seq)
const rowsLeft = (s: Store) =>
  ((s as unknown as { db: Database.Database }).db.prepare(`SELECT COUNT(*) as n FROM subagent_messages`).get() as { n: number }).n

describe("a session's subagent steps in the trash without it (#418)", () => {
  it('says what each live session holds, largest first, by runs, steps and bytes', () => {
    const s = seeded()
    steps(s, 's1', A, 2)
    steps(s, 's1', B, 3)
    steps(s, 's2', A, 7)
    expect(s.subagentSteps.listHeld()).toEqual([
      { sessionId: 's2', name: 'name of s2', tool: 'claude', projectId: null, projectName: null, runs: 1, steps: 7, bytes: bytesOf('s2', A, 1, 7) },
      { sessionId: 's1', name: 'name of s1', tool: 'claude', projectId: 'p1', projectName: 'alpha', runs: 2, steps: 5, bytes: bytesOf('s1', A, 1, 2) + bytesOf('s1', B, 1, 3) },
    ])
    expect(s.subagentSteps.listTrashed()).toEqual([])
    s.close()
  })

  it('moves them out from under their cards, keeps the conversation, and puts them back as they were', async () => {
    const s = seeded()
    const said: StoredMessage = { sessionId: 's1', seq: 1, role: 'user', kind: 'text', payload: { text: 'research it' }, ts: 1 }
    s.messages.appendMessages([said])
    steps(s, 's1', A, 3)
    steps(s, 's1', B, 2)

    expect(await s.subagentSteps.trash('s1', 1234)).toEqual({ steps: 5, bytes: bytesOf('s1', A, 1, 3) + bytesOf('s1', B, 1, 2) })
    expect(s.messages.loadSubagentMessages('s1', A)).toEqual([])
    expect(s.subagentSteps.trashedOf('s1', A)).toBe(3)
    expect(s.subagentSteps.trashedOf('s1', B)).toBe(2)
    // An image a trashed step named is not a reply the window shows any more
    expect(s.messages.replyTextsContaining('s1', './shot.png')).toEqual([])
    expect(s.subagentSteps.listHeld()).toEqual([])
    expect(s.subagentSteps.listTrashed()).toEqual([
      expect.objectContaining({ sessionId: 's1', runs: 2, steps: 5, deletedAt: 1234 }),
    ])
    // The conversation and the session are where they were
    expect(s.messages.loadMessages('s1', 200, undefined, { full: true })).toEqual([said])
    expect(s.trash.isTrashed('s1')).toBe(false)

    // A subagent still running numbers its next step after the trashed ones, so the two never meet on a restore
    s.messages.appendSubagentMessage('s1', A, { role: 'assistant', kind: 'text', payload: { type: 'message_delta', sessionId: 's1', role: 'assistant', text: 'later' }, ts: 9 })
    expect(seqs(s.messages.loadSubagentMessages('s1', A))).toEqual([4])

    expect(await s.subagentSteps.restore('s1')).toBe(true)
    expect(seqs(s.messages.loadSubagentMessages('s1', A))).toEqual([1, 2, 3, 4])
    expect(seqs(s.messages.loadSubagentMessages('s1', B))).toEqual([1, 2])
    expect(s.subagentSteps.trashedOf('s1', A)).toBe(0)
    expect(s.subagentSteps.listTrashed()).toEqual([])
    expect(await s.subagentSteps.restore('s1')).toBe(false)
    s.close()
  })

  it('moving twice makes one entry, dated by the later move', async () => {
    const s = seeded()
    steps(s, 's1', A, 2)
    await s.subagentSteps.trash('s1', 100)
    steps(s, 's1', B, 1)
    await s.subagentSteps.trash('s1', 200)
    expect(s.subagentSteps.listTrashed()).toEqual([expect.objectContaining({ sessionId: 's1', runs: 2, steps: 3, deletedAt: 200 })])
    s.close()
  })

  it('deleting them for good takes only the trashed steps, in chunks, and leaves the session and its other steps', async () => {
    const s = seeded()
    steps(s, 's1', A, 5)
    steps(s, 's2', A, 2)
    await s.subagentSteps.trash('s1')
    steps(s, 's1', B, 1)
    const [listed] = s.subagentSteps.listTrashed()
    const yields = vi.spyOn(globalThis, 'setImmediate')
    // 5 trashed steps in chunks of 2: three chunks, the event loop let go between them
    expect(await s.subagentSteps.purge('s1', listed!.deletedAt, 2)).toBe(true)
    expect(yields).toHaveBeenCalledTimes(2)
    yields.mockRestore()
    expect(s.subagentSteps.trashedOf('s1', A)).toBe(0)
    expect(s.messages.loadSubagentMessages('s1', A)).toEqual([])
    expect(seqs(s.messages.loadSubagentMessages('s1', B))).toEqual([1])
    expect(seqs(s.messages.loadSubagentMessages('s2', A))).toEqual([1, 2])
    expect(rowsLeft(s)).toBe(3)
    expect(s.sessions.listSessions().map((x) => x.id).sort()).toEqual(['s1', 's2'])
    expect(await s.subagentSteps.purge('s1', Number.MAX_SAFE_INTEGER)).toBe(false)
    s.close()
  })

  // #418 review: deleting for good took steps moved to the trash after the window read it, more than it had said
  it('deleting for good takes only the steps moved up to what the window listed; a later move, even in the same millisecond, stays', async () => {
    const s = seeded()
    steps(s, 's1', A, 2)
    await s.subagentSteps.trash('s1', 100)
    const [seen] = s.subagentSteps.listTrashed()
    expect(seen).toMatchObject({ steps: 2, deletedAt: 100 })
    // Another window moves the session's later steps, within the same millisecond
    steps(s, 's1', B, 3)
    await s.subagentSteps.trash('s1', 100)
    expect(s.subagentSteps.listTrashed()).toEqual([expect.objectContaining({ steps: 5, deletedAt: 101 })])

    expect(await s.subagentSteps.purge('s1', seen!.deletedAt)).toBe(true)
    expect(s.subagentSteps.trashedOf('s1', A)).toBe(0)
    expect(s.subagentSteps.trashedOf('s1', B)).toBe(3)
    expect(s.subagentSteps.listTrashed()).toEqual([expect.objectContaining({ runs: 1, steps: 3, deletedAt: 101 })])
    // Nothing is left up to the bound: refused, so a second press does not reach the later move
    expect(await s.subagentSteps.purge('s1', seen!.deletedAt)).toBe(false)
    s.close()
  })

  // #418 review: nothing held the bound that keeps a step written during a move under its card
  it('a step written while a move is under way stays under its card', async () => {
    const s = seeded()
    steps(s, 's1', A, 5)
    const real = globalThis.setImmediate
    let written = false
    const spy = vi.spyOn(globalThis, 'setImmediate').mockImplementation(((cb: () => void) => {
      if (!written) {
        written = true
        steps(s, 's1', B, 1)
      }
      return real(cb)
    }) as unknown as typeof setImmediate)
    // Chunks of 2: the step is written between the first chunk and the second
    expect(await s.subagentSteps.trash('s1', 100, 2)).toMatchObject({ steps: 5 })
    spy.mockRestore()
    expect(written).toBe(true)
    expect(seqs(s.messages.loadSubagentMessages('s1', B))).toEqual([1])
    expect(s.subagentSteps.trashedOf('s1', A)).toBe(5)
    s.close()
  })

  it('a session in the trash holds its trashed steps in its own entry, and its purge takes them', async () => {
    const s = seeded()
    steps(s, 's1', A, 3)
    await s.subagentSteps.trash('s1')
    await s.trash.trashSession('s1', KEEP_ALL)
    // Not two entries for the same rows, and nothing to move, restore or purge on their own
    expect(s.subagentSteps.listTrashed()).toEqual([])
    expect(await s.subagentSteps.trash('s1')).toBeNull()
    expect(await s.subagentSteps.restore('s1')).toBe(false)
    expect(await s.subagentSteps.purge('s1', Number.MAX_SAFE_INTEGER)).toBe(false)
    expect(s.trash.listTrash()[0]!.bytes).toBe(bytesOf('s1', A, 1, 3))
    // Restored, the session's steps are still in the trash
    await s.trash.restoreSession('s1', 'p1')
    expect(s.subagentSteps.listTrashed()).toEqual([expect.objectContaining({ sessionId: 's1', steps: 3 })])
    await s.trash.trashSession('s1', KEEP_ALL)
    await s.trash.purgeSession('s1')
    expect(rowsLeft(s)).toBe(0)
    s.close()
  })

  it('a session with no steps moves nothing, and one not here is refused', async () => {
    const s = seeded()
    expect(await s.subagentSteps.trash('s1')).toEqual({ steps: 0, bytes: 0 })
    expect(await s.subagentSteps.trash('nobody')).toBeNull()
    s.close()
  })
})

describe('v58 — trashed_at on subagent steps (#418)', () => {
  let dir = ''
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('is added to a store written before it, whose steps stay under their cards; an older build still writes steps', async () => {
    dir = mkdtempSync(join(tmpdir(), 'cc-v58-'))
    const file = join(dir, 'store.db')
    const old = seeded(file)
    steps(old, 's1', A, 2)
    old.close()
    const raw = new Database(file)
    raw.exec(`DROP INDEX subagent_messages_trash; ALTER TABLE subagent_messages DROP COLUMN trashed_at`)
    // The version just before this step (v57 is #1121's)
    raw.pragma('user_version = 57')
    raw.close()

    const s = new Store(file)
    expect(s.migrationsRun).toBe(3) // v58, then v59 (#1134) and v60 (#550)
    expect(seqs(s.messages.loadSubagentMessages('s1', A))).toEqual([1, 2])
    s.close()
    // What the build before v58 writes names no trashed_at: such a step is under its card
    const older = new Database(file)
    older.prepare(`INSERT INTO subagent_messages (session_id, parent_call_id, seq, role, kind, payload, ts) VALUES ('s1', ?, 3, 'assistant', 'text', '{}', 3)`).run(A)
    older.close()
    const again = new Store(file)
    expect(again.migrationsRun).toBe(0)
    expect(seqs(again.messages.loadSubagentMessages('s1', A))).toEqual([1, 2, 3])
    expect(await again.subagentSteps.trash('s1')).toMatchObject({ steps: 3 })
    again.close()
  })
})
