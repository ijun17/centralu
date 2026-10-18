/**
 * One stored row whose JSON cannot be read (#850 item 5): a bad row fails only itself, never the list or page it is
 * read in. Before, `JSON.parse` ran unguarded over every row, so one row written by a crash mid-write (or a newer build
 * with a different shape) made a whole conversation page, the session list or a machine's mirrored list throw.
 */
import { describe, expect, it, vi } from 'vitest'
import type Database from 'better-sqlite3'
import { sessionLiveDefaults, type SessionInfo } from '@cc/protocol'
import { Store } from './store.js'

const dbOf = (s: Store) => (s as unknown as { db: Database.Database }).db

function session(id: string, over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id, projectId: 'p1', kind: 'worker', tool: 'claude', externalId: null, name: id, autoNamed: false, state: 'idle',
    lastReadSeq: 0, lastSeq: 0, createdAt: 1, waitingSince: null, live: false, model: null, effort: null,
    verbosity: null, serviceTier: null, permissionPreset: 'normal', importedFrom: null, worktree: null,
    parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(), ...over,
  }
}

function seeded(): Store {
  const s = new Store()
  s.projects.addProject({ id: 'p1', path: '/tmp/p1', name: 'p1' })
  s.sessions.upsertSession(session('s1'))
  return s
}

describe('a stored row that is not JSON fails only itself (#850)', () => {
  it('a conversation page still reads every row, the bad one with an empty payload', () => {
    const s = seeded()
    s.messages.appendMessages([
      { sessionId: 's1', seq: 1, role: 'user', kind: 'text', payload: { text: 'one' }, ts: 1 },
      { sessionId: 's1', seq: 2, role: 'assistant', kind: 'text', payload: { text: 'two' }, ts: 2 },
      { sessionId: 's1', seq: 3, role: 'system', kind: 'tool_call', payload: { callId: 'c', summary: { tool: 'Bash', title: 't' }, input: {} }, ts: 3 },
      { sessionId: 's1', seq: 4, role: 'assistant', kind: 'text', payload: { text: 'four' }, ts: 4 },
    ])
    dbOf(s).prepare(`UPDATE messages SET payload = '{"text": "tw' WHERE session_id = 's1' AND seq = 2`).run()
    // A tool row goes through json_remove, which SQLite refuses on text that is not JSON
    dbOf(s).prepare(`UPDATE messages SET payload = 'not json' WHERE session_id = 's1' AND seq = 3`).run()

    // The page keeps its length: the window reads a short page as the start of the conversation
    const page = s.messages.loadMessages('s1', 10)
    expect(page.map((m) => m.seq)).toEqual([1, 2, 3, 4])
    expect(page.map((m) => m.payload)).toEqual([{ text: 'one' }, {}, {}, { text: 'four' }])
    expect(s.messages.loadMessages('s1', 10, undefined, { full: true }).map((m) => m.payload)[2]).toEqual({})
    expect(s.messages.loadMessagesFrom('s1', 1).map((m) => m.payload)).toEqual([{}, {}, { text: 'four' }])
  })

  it('a subagent step that is not JSON reads as an empty payload', () => {
    const s = seeded()
    s.messages.appendSubagentMessage('s1', 'call-1', { role: 'assistant', kind: 'text', payload: { text: 'a' }, ts: 1 })
    s.messages.appendSubagentMessage('s1', 'call-1', { role: 'assistant', kind: 'text', payload: { text: 'b' }, ts: 2 })
    dbOf(s).prepare(`UPDATE subagent_messages SET payload = '{' WHERE seq = 1`).run()
    expect(s.messages.loadSubagentMessages('s1', 'call-1').map((m) => m.payload)).toEqual([{}, { text: 'b' }])
  })

  it('the session list keeps every session when one scope list is not JSON', () => {
    const s = seeded()
    s.sessions.upsertSession(session('c1', { kind: 'coordinator', scopeSessionIds: ['s1'] }))
    dbOf(s).prepare(`UPDATE sessions SET scope_session_ids = '["s1"' WHERE id = 'c1'`).run()
    const listed = s.sessions.listSessions()
    expect(listed.map((x) => x.id).sort()).toEqual(['c1', 's1'])
    // Still a coordinator, now one that sees no session: an unreadable list grants nothing
    expect(listed.find((x) => x.id === 'c1')).toMatchObject({ kind: 'coordinator', scopeSessionIds: [] })
  })

  it("a linked machine's mirrored list skips the one header that is not JSON", () => {
    const s = seeded()
    s.machines.addLinkedMachine({ id: 'm1', name: 'm', sshTarget: 'h', remote: { shell: 'posix' }, addedAt: 1, acceptedVersions: null })
    s.machines.replaceMachineHeaders('m1', 'session', [{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    dbOf(s).prepare(`UPDATE machine_headers SET info = '{"id":' WHERE item_id = 'b'`).run()
    expect(s.machines.machineHeaders('m1', 'session')).toEqual([{ id: 'a' }, { id: 'c' }])
    // Patching the unreadable one leaves it for the next full mirror rather than throwing
    expect(() => s.machines.patchMachineSession('m1', 'b', { state: 'idle' })).not.toThrow()
    s.machines.patchMachineSession('m1', 'a', { state: 'idle' })
    expect(s.machines.machineHeaders('m1', 'session')).toEqual([{ id: 'a', state: 'idle' }, { id: 'c' }])
  })

  it('the trash keeps listing when a record is JSON but not an object', async () => {
    const s = seeded()
    s.sessions.upsertSession(session('s2'))
    const keep = { projectId: 'p1', projectName: 'p1', projectPath: '/tmp/p1', removeExternal: false, removeWorktree: false }
    await s.trash.trashSession('s1', keep)
    await s.trash.trashSession('s2', keep)
    dbOf(s).prepare(`UPDATE sessions SET trash = 'null' WHERE id = 's1'`).run()
    const listed = s.trash.listTrash()
    expect(listed.map((t) => t.id).sort()).toEqual(['s1', 's2'])
    // Unreadable reads as "keep everything": deleting for good must be asked for
    expect(listed.find((t) => t.id === 's1')?.record).toMatchObject({ removeExternal: false, removeWorktree: false })
  })
})

describe('a value a newer build wrote that this build cannot read (#384)', () => {
  /*
   * A newer build may add a preset (another word in `sessions.permission_preset`). Read as it was, every adapter and
   * gate here took the word it did not know for `normal`, the person's own settings, and `=== 'safe'` checks read it as
   * a session that may be raised. A permission that cannot be read is a refusal: it reads as `safe`, which asks about
   * everything, and the presets this build knows read as they are.
   */
  it('a permission preset this build does not know reads as safe, and the known ones as they are', () => {
    const s = seeded()
    s.sessions.upsertSession(session('s2', { permissionPreset: 'auto' }))
    s.sessions.upsertSession(session('s3', { permissionPreset: 'safe' }))
    dbOf(s).prepare(`UPDATE sessions SET permission_preset = 'plan' WHERE id = 's1'`).run()
    const presets = Object.fromEntries(s.sessions.listSessions().map((x) => [x.id, x.permissionPreset]))
    expect(presets).toEqual({ s1: 'safe', s2: 'auto', s3: 'safe' })
  })

  /*
   * The highest slot handed to a linked machine (#82) is a number in `app_settings`. One that is not a number made the
   * next slot NaN, and every `machines.add` failed on the table's NOT NULL with a raw SQL error that named nothing. The
   * mark keeps a removed machine's slot from coming back: once it cannot be read, the highest slot in use is all
   * there is, so it is used and the row is named on stderr.
   */
  it('a high-water mark for linked machines that is not a number still adds the machine, past every slot in use, and says so', () => {
    const s = seeded()
    s.machines.addLinkedMachine({ id: 'm1', name: 'm1', sshTarget: 'h1', remote: { shell: 'posix' }, addedAt: 1, acceptedVersions: null })
    s.machines.addLinkedMachine({ id: 'm2', name: 'm2', sshTarget: 'h2', remote: { shell: 'posix' }, addedAt: 2, acceptedVersions: null })
    s.settings.setAppSetting('links.slotHighWater', 'many')
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})

    const m3 = s.machines.addLinkedMachine({ id: 'm3', name: 'm3', sshTarget: 'h3', remote: { shell: 'posix' }, addedAt: 3, acceptedVersions: null })
    expect(m3.slot).toBe(3)
    expect(s.settings.appSetting('links.slotHighWater')).toBe('3')
    expect(said.mock.calls.map((c) => String(c[0])).join(' | ')).toMatch(/app_settings\.links\.slotHighWater .*"many"/)
    said.mockRestore()
  })
})
