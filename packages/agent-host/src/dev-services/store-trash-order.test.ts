/**
 * The session archive lists the most recently archived session first. Two archivings in one millisecond must not tie: the
 * order of equal times is up to SQLite (a macOS CI run listed "Session 2" among the newest ten and left out "Session 3").
 * The clock is frozen here, so every archiving reads the same time on every machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sessionLiveDefaults } from '@cc/protocol'
import { Store } from './store.js'

const session = (s: Store, id: string, projectId: string | null) =>
  s.sessions.upsertSession({
    id, projectId, kind: 'worker', tool: 'claude', externalId: null, name: `name of ${id}`, autoNamed: false, state: 'idle',
    lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null,
    verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null,
    parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
  })
const RECORD = { projectId: 'p1', projectName: 'alpha', projectPath: '/tmp/p1', removeExternal: false, removeWorktree: false }

let s: Store
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(Date.UTC(2026, 0, 2))
  s = new Store(':memory:')
  s.projects.addProject({ id: 'p1', path: '/tmp/p1', name: 'alpha' })
  for (const id of ['s1', 's2', 's3']) session(s, id, 'p1')
})
afterEach(() => {
  s.close()
  vi.useRealTimers()
})

describe('the order of the session archive', () => {
  it('lists sessions archived in one millisecond by the order they were archived in, not the order they were made in', async () => {
    for (const id of ['s2', 's3', 's1']) await s.trash.trashSession(id, RECORD)
    expect(s.trash.listTrash().map((r) => r.id)).toEqual(['s1', 's3', 's2'])
  })

  it('stamps each archiving above the last, so the time the window shows stays a time', async () => {
    for (const id of ['s2', 's3', 's1']) await s.trash.trashSession(id, RECORD)
    const at = s.trash.listTrash().map((r) => r.deletedAt)
    expect(at).toEqual([at[2]! + 2, at[2]! + 1, at[2]!])
    expect(at[2]).toBe(Date.UTC(2026, 0, 2))
  })

  it('does the same for the sessions a deleted project takes with it', () => {
    s.trash.deleteProject('p1')
    const at = s.trash.listTrash().map((r) => r.deletedAt)
    expect(new Set(at).size).toBe(3)
    expect(at).toEqual([...at].sort((a, b) => b - a))
  })

  it('puts a session that is restored and archived again ahead of the ones archived before it', async () => {
    for (const id of ['s2', 's3', 's1']) await s.trash.trashSession(id, RECORD)
    await s.trash.restoreSession('s3', 'p1')
    await s.trash.trashSession('s3', RECORD)
    expect(s.trash.listTrash().map((r) => r.id)).toEqual(['s3', 's1', 's2'])
  })
})
