/**
 * #378 review: the record of a deleted app-agent session holds everything the purge then deletes of its rows: the
 * conversation and its subagents' steps (#222), copied whole or not at all.
 */
import { describe, expect, it } from 'vitest'
import type Database from 'better-sqlite3'
import { sessionLiveDefaults } from '@cc/protocol'
import { Store } from './store.js'

const KEEP_ALL = { projectId: 'p1', projectName: 'p1', projectPath: '/tmp/p1', removeExternal: false, removeWorktree: false }

const seeded = () => {
  const s = new Store(':memory:')
  s.projects.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
  s.sessions.upsertSession({
    id: 's1', projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: 'Notes · agent 10:00', autoNamed: false, state: 'idle',
    lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null,
    verbosity: null, serviceTier: null, permissionPreset: 'safe', importedFrom: null, worktree: null,
    parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: 'notes', ...sessionLiveDefaults(),
  })
  s.appRuns.beginAppRun({
    id: 'run1', projectId: 'p1', appId: 'notes', kind: 'broker', tool: 'run_agent', callerKind: 'session', callerSessionId: null,
    parentRunId: null, status: 'running', durationMs: null, argsDigest: 'd', argsSummary: 'x', error: null, createdAt: 1, sessionId: 's1',
  })
  s.appRuns.endAppRun('run1', { status: 'ok', durationMs: 5, error: null, agent: { request: 'Research it.', answer: 'Done.', output: null } })
  s.messages.appendMessages([
    { sessionId: 's1', seq: 1, role: 'user', kind: 'text', payload: { text: 'Research it.' }, ts: 1 },
    {
      sessionId: 's1', seq: 2, role: 'system', kind: 'tool_call',
      payload: { type: 'tool_call', sessionId: 's1', callId: 'toolu_agent', summary: { tool: 'Agent', title: 'Research', paths: [] } },
      ts: 2,
    },
    { sessionId: 's1', seq: 3, role: 'assistant', kind: 'text', payload: { text: 'Done.' }, ts: 3 },
  ])
  for (const text of ['look at the tests', 'tested twice'])
    s.messages.appendSubagentMessage('s1', 'toolu_agent', { role: 'assistant', kind: 'text', payload: { type: 'message_delta', sessionId: 's1', role: 'assistant', text }, ts: 2 })
  return s
}
const db = (s: Store) => (s as unknown as { db: Database.Database }).db
const count = (s: Store, sql: string) => (db(s).prepare(sql).get() as { n: number }).n
const keep = (s: Store) => s.keptRuns.keepRun({ runId: 'run1', sessionId: 's1', sessionName: 'Notes · agent 10:00', appName: 'Notes', projectName: 'p1', tool: 'claude', keptAt: 9 })

describe('the record of a deleted app-agent session (#378)', () => {
  it('keeps the subagents’ steps with the conversation, through the purge of the session, and deletes them with the record', async () => {
    const s = seeded()
    expect(keep(s)).toBe(true)
    await s.trash.trashSession('s1', KEEP_ALL)
    await s.trash.purgeSession('s1')
    expect(count(s, `SELECT COUNT(*) as n FROM subagent_messages`)).toBe(0)

    expect(count(s, `SELECT COUNT(*) as n FROM app_run_messages WHERE run_id = 'run1'`)).toBe(3)
    const steps = db(s).prepare(`SELECT parent_call_id as parent, seq, payload FROM app_run_subagent_messages WHERE run_id = 'run1' ORDER BY seq`).all() as { parent: string; seq: number; payload: string }[]
    expect(steps.map((r) => [r.parent, r.seq, (JSON.parse(r.payload) as { text: string }).text])).toEqual([
      ['toolu_agent', 1, 'look at the tests'],
      ['toolu_agent', 2, 'tested twice'],
    ])
    // The trash counts what the steps take too
    const [listed] = s.keptRuns.listKeptRuns()
    expect(listed!.bytes).toBeGreaterThan(steps.reduce((n, r) => n + Buffer.byteLength(r.payload), 0))

    expect(s.keptRuns.purgeKeptRuns(['run1'])).toBe(1)
    expect(count(s, `SELECT COUNT(*) as n FROM app_run_subagent_messages`)).toBe(0)
    s.close()
  })

  it('the run log’s retention takes the steps with the record', () => {
    const s = seeded()
    expect(keep(s)).toBe(true)
    s.appRuns.pruneAppRuns(10)
    expect([count(s, `SELECT COUNT(*) as n FROM app_run_records`), count(s, `SELECT COUNT(*) as n FROM app_run_subagent_messages`)]).toEqual([0, 0])
    s.close()
  })

  it.each(['app_run_messages', 'app_run_subagent_messages'])('keeps nothing, and says so, when a row of %s did not copy', (table) => {
    const s = seeded()
    // A row the copy skipped (as a write the disk refused would): the counts no longer match the session's
    db(s).exec(`CREATE TEMP TRIGGER skip_one BEFORE INSERT ON ${table} WHEN NEW.seq = 2 BEGIN SELECT RAISE(IGNORE); END`)
    expect(keep(s)).toBe(false)
    expect([
      count(s, `SELECT COUNT(*) as n FROM app_run_records`),
      count(s, `SELECT COUNT(*) as n FROM app_run_messages`),
      count(s, `SELECT COUNT(*) as n FROM app_run_subagent_messages`),
    ]).toEqual([0, 0, 0])
    s.close()
  })
})
