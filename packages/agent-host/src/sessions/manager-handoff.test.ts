/**
 * SessionManager through RPC with an in-memory adapter: handoff records and notes.
 * Shared fakes and the world each test starts from are in manager.test-helpers.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { SessionInfo } from '@cc/protocol'
import type { AgentAdapter } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'
import { createRpcHandler } from '../rpc.js'
import { FakeAdapter, managerWorld } from './manager.test-helpers.js'
import { lineageLine } from './handoff-record.js'
import { canSymlink, itSymlink, linkDir } from '../link.test-helpers.js'

let store: Store
let adapter: FakeAdapter
let codexAdapter: FakeAdapter
let mgr: SessionManager
let rpc: ReturnType<typeof createRpcHandler>

beforeEach(() => {
  ;({ store, adapter, codexAdapter, mgr, rpc } = managerWorld())
})

const addProject = () => rpc('projects.add', { path: tmpdir() }) as Promise<{ id: string; path: string }>

/**
 * A dead-agent handoff record (#78) — built without calling that session's tool.
 * The only material is the raw record in the store and, for codex, the compact summary from the
 * rollout.
 */
describe('the dead-agent handoff record (#78)', () => {
  it('falls back to the raw text with no summary; with one, the summary replaces everything before the pivot', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'codex' })) as SessionInfo
    store.messages.appendMessages([
      { sessionId: s.id, seq: 101, role: 'user', kind: 'text', payload: { text: 'Old question' }, ts: 1 },
      { sessionId: s.id, seq: 102, role: 'system', kind: 'marker', payload: { type: 'compaction', failed: false }, ts: 2 },
      { sessionId: s.id, seq: 103, role: 'user', kind: 'text', payload: { text: 'Question after compaction' }, ts: 3 },
      { sessionId: s.id, seq: 104, role: 'system', kind: 'tool_call', payload: { callId: 'c', summary: { tool: 'Bash', title: 'ls' } }, ts: 4 },
    ])

    // Summary extraction fails (adapter not implemented) -> the raw-text path: what came before the pivot is
    // included too.
    let out = await mgr.handoffNotes.exportHandoffRecord(s.id, 'claude')
    expect(out.text).toContain('[user] Old question')
    expect(out.text).toContain('[user] Question after compaction')
    expect(out.text).toContain('[104] Bash ls')
    /*
     * **The text goes out as a file** (#102). It has to be the same location as the mode where
     * it comes from the agent, so the first message the successor receives is identical in both
     * modes — that convergence is this feature's contract. The path differs **per handing-off
     * session** (#104): if a project has two handoffs, a single-named file would overwrite
     * itself. The location is the data folder (#142).
     */
    expect(out.path).toBe(join(process.env.CC_DATA_DIR!, 'handoff', p.id, `${s.id}.md`))
    expect(readFileSync(out.path, 'utf8')).toBe(out.text)
    expect(out.text.split('\n')[0]).toBe(`# Handoff · ${JSON.stringify(s.name)} · codex → claude`)

    // Once a codex rollout summary arrives — asked by that session's externalId, the summary replaces
    // everything before the pivot.
    const asked: string[] = []
    ;(codexAdapter as AgentAdapter).lastCompactSummary = async (ext: string) => {
      asked.push(ext)
      return 'Original compact summary text pulled from the rollout. '.repeat(30)
    }
    out = await mgr.handoffNotes.exportHandoffRecord(s.id)
    expect(asked).toEqual(['ext-1'])
    expect(out.text).toContain('Original compact summary text pulled from the rollout')
    expect(out.text).not.toContain('Old question')
    expect(out.text).toContain('Question after compaction')

    await expect(mgr.handoffNotes.exportHandoffRecord('nope')).rejects.toThrow(/Session not found/)
  })
})

describe('the contents of a handoff record (#1481)', () => {
  it('lists the children of the original by state, its running background work, and the note it took over from', async () => {
    const p = await addProject()
    const orig = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'codex' })) as SessionInfo
    const kid = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'codex' })) as SessionInfo
    const meta = (mgr as unknown as { meta: Map<string, SessionInfo> }).meta
    meta.get(kid.id)!.askedBy = orig.id
    meta.get(orig.id)!.backgroundTasks = [
      { id: 'bg-run', kind: 'shell', description: 'usage watcher', status: 'running' },
      { id: 'bg-done', kind: 'shell', description: 'finished build', status: 'completed' },
    ]
    const earlier = '11111111-1111-4111-8111-111111111111'
    store.messages.appendMessages([
      { sessionId: orig.id, seq: 101, role: 'system', kind: 'marker', payload: { type: 'handoff', sessionId: orig.id, seq: 101, from: 'x', note: 'n', fromSessionId: earlier }, ts: 1 },
      { sessionId: orig.id, seq: 102, role: 'assistant', kind: 'text', payload: { text: 'State: the parser is done.' }, ts: 2 },
    ])

    const out = await mgr.handoffNotes.exportHandoffRecord(orig.id)

    expect(out.text).toContain(`previous handoff note (this session took over from another; the file is rewritten by every handoff from that session, and may be gone): ${join(process.env.CC_DATA_DIR!, 'handoff', p.id, `${earlier}.md`)}`)
    expect(out.text).toContain('Report at seq 102:\n    State: the parser is done.')
    expect(out.text).toMatch(new RegExp(`- "${kid.name}" — finished — id: ${kid.id}`))
    expect(out.text).toContain('- shell "usage watcher" — id: bg-run')
    expect(out.text).not.toContain('finished build')
    expect(out.text).toMatch(/\| Contents \(this section\) \| \d+–\d+ \|/)
  })
})

describe('the handoff lineage in a note (#1487)', () => {
  it('names the session and those it took over from in a record and in an agent’s note, nearest first, deleted ones left out', async () => {
    const p = await addProject()
    const make = async () => (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as SessionInfo
    const [grand, mid, orig] = [await make(), await make(), await make()]
    const handoffFrom = (id: string, from: string) =>
      store.messages.appendMessages([{ sessionId: id, seq: 101, role: 'system', kind: 'marker', payload: { type: 'handoff', sessionId: id, seq: 101, from: 'x', note: 'n', fromSessionId: from }, ts: 1 }])
    handoffFrom(mid.id, grand.id)
    handoffFrom(orig.id, mid.id)
    const line = lineageLine([orig.id, mid.id, grand.id])
    expect((await mgr.handoffNotes.exportHandoffRecord(orig.id)).text).toContain(line)

    const before = store.messages.loadMessages(orig.id, 1).at(-1)?.seq ?? 0
    await rpc('agents.send', { sessionId: orig.id, text: 'write the note' })
    adapter.handleOf(orig.id)!.emitDelta('The agent’s own note')
    adapter.handleOf(orig.id)!.finishTurn()
    const got = (await rpc('agents.exportHandoffNote', { sessionId: orig.id, afterSeq: before })) as { text: string }
    expect(got.text.startsWith(`${line}\n`)).toBe(true)
    expect(got.text).toContain('The agent’s own note')

    // A handoff names a live session of its own project: another project's, an archived one and an unknown id are refused,
    // so a marker cannot point a session at text it was never given (#1487 review)
    const otherDir = mkdtempSync(join(tmpdir(), 'cc-1487-other-'))
    const other = (await rpc('projects.add', { path: otherDir })) as { id: string; path: string }
    const stranger = (await rpc('agents.createSession', { projectId: other.id, cwd: other.path, tool: 'claude' })) as SessionInfo
    const offer = (fromSessionId: string, project = p) =>
      rpc('agents.createSession', { projectId: project.id, cwd: project.path, tool: 'claude', handoff: { from: 'x', note: 'n', fromSessionId } })
    await expect(offer(stranger.id)).rejects.toThrow(/live session of the same project/)
    await expect(offer('00000000-0000-4000-8000-000000000000')).rejects.toThrow(/live session of the same project/)
    // A session of the same project that is in the session archive is refused the same way
    const archived = await make()
    await rpc('agents.deleteSession', { sessionId: archived.id })
    expect(store.trash.isTrashed(archived.id)).toBe(true)
    await expect(offer(archived.id)).rejects.toThrow(/live session of the same project/)
    const heir = (await offer(orig.id)) as SessionInfo
    expect(store.handoffs.predecessorOf(heir.id)).toBe(orig.id)
    rmSync(otherDir, { recursive: true, force: true })

    // A predecessor deleted for good ends the list there
    await store.trash.trashSession(mid.id, { projectId: p.id, projectName: null, projectPath: null, removeExternal: false, removeWorktree: false })
    await store.trash.purgeSession(mid.id)
    expect((await mgr.handoffNotes.exportHandoffRecord(orig.id)).text).toContain(lineageLine([orig.id]))
  })
})

/**
 * The lifetime of a handoff note (#106).
 *
 * A real incident: a successor was told to read `.centralu/handoff/<predecessor>.md`, and that
 * directory was created at 20:03 and empty by 20:06. The successor could not produce a single
 * character — it received the path to a file that no longer existed, and that text could never
 * be recreated (because the session that wrote it had just been replaced).
 *
 * Cleanup moved twice before landing here: right after `createSession` (before #102) -> once the
 * successor's first turn completes (#102) -> two moments that cannot race the reader (session
 * deletion, startup).
 */
describe("a handoff note does not race its reader (#106)", () => {
  let dir: string
  let data: string
  let pid = ''
  // The note lives in the data folder (#142) — each test uses its own data folder.
  const note = (id: string) => join(data, 'handoff', pid, `${id}.md`)
  const placeNote = (id: string, text = 'Please continue') => {
    mkdirSync(join(data, 'handoff', pid), { recursive: true })
    writeFileSync(note(id), text)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cc-handoff-'))
    data = mkdtempSync(join(tmpdir(), 'cc-handoff-data-'))
    vi.stubEnv('CC_DATA_DIR', data)
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    rmSync(data, { recursive: true, force: true })
  })

  const project = async () => {
    const p = (await rpc('projects.add', { path: dir })) as { id: string; path: string }
    pid = p.id
    return p
  }

  it("the successor's note survives deleting the predecessor — deletion is the last step of a handoff", async () => {
    const p = await project()
    const dying = (await rpc('agents.createSession', { projectId: p.id, cwd: dir, tool: 'claude' })) as SessionInfo
    placeNote(dying.id)
    await rpc('agents.createSession', {
      projectId: p.id, cwd: dir, tool: 'claude',
      handoff: { from: dying.name, note: 'Please continue', fromSessionId: dying.id },
    })

    await mgr.trashSession(dying.id)
    await mgr.trash.purgeSession(dying.id)
    expect(existsSync(note(dying.id))).toBe(true)
  })

  it('a sweep already under way does not judge a note by who owned it when the sweep began', async () => {
    const p = await project()
    const handing = (await rpc('agents.createSession', { projectId: p.id, cwd: dir, tool: 'claude' })) as SessionInfo
    placeNote(handing.id)
    const other = (await rpc('agents.createSession', { projectId: p.id, cwd: dir, tool: 'claude' })) as SessionInfo
    await mgr.trashSession(other.id)

    // Purging another session sweeps the project's notes. While that sweep reads the folder, the person
    // moves the note's session to the session archive, which keeps its note (#204).
    const claimed = store.handoffs.handoffPredecessors.bind(store.handoffs)
    let trashing: Promise<void> | undefined
    const spy = vi.spyOn(store.handoffs, 'handoffPredecessors').mockImplementation(() => {
      trashing ??= mgr.trashSession(handing.id)
      return claimed()
    })
    try {
      await mgr.trash.purgeSession(other.id)
      // A sweep that asks per note may never need the claims for this one (it is still live when judged);
      // the session archive then lands after the sweep, which must keep the note just the same
      await (trashing ??= mgr.trashSession(handing.id))
    } finally {
      spy.mockRestore()
    }

    expect(store.trash.trashedIds().has(handing.id)).toBe(true)
    expect(existsSync(note(handing.id))).toBe(true)
  })

  it('it is swept away once the session that inherited the note is also gone — no one is left to read it', async () => {
    const p = await project()
    const dying = (await rpc('agents.createSession', { projectId: p.id, cwd: dir, tool: 'claude' })) as SessionInfo
    placeNote(dying.id)
    const heir = (await rpc('agents.createSession', {
      projectId: p.id, cwd: dir, tool: 'claude',
      handoff: { from: dying.name, note: 'Please continue', fromSessionId: dying.id },
    })) as SessionInfo

    await mgr.trashSession(dying.id)
    await mgr.trashSession(heir.id)
    // Both in the session archive: either could be restored and ask for the note, so it stays (#204)
    expect(existsSync(note(dying.id))).toBe(true)
    await mgr.trash.purgeSession(dying.id)
    expect(existsSync(note(dying.id))).toBe(true)
    await mgr.trash.purgeSession(heir.id)
    expect(existsSync(note(dying.id))).toBe(false)
  })

  it('a note whose session is in the session archive survives a sweep, and goes when that session is deleted for good (#204)', async () => {
    const p = await project()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: dir, tool: 'claude' })) as SessionInfo
    placeNote(s.id)
    placeNote('gone-session', 'nobody owns this')
    await mgr.trashSession(s.id)

    // A restart sweeps orphan notes. One in the session archive is not an orphan: restoring it must find its note
    new SessionManager(store, new Map([['claude', adapter as AgentAdapter]]), () => {})
    await vi.waitFor(() => expect(existsSync(note('gone-session'))).toBe(false))
    expect(existsSync(note(s.id))).toBe(true)

    await mgr.trash.purgeSession(s.id)
    expect(existsSync(note(s.id))).toBe(false)
  })

  it('startup sweeps orphans — there is no in-progress handoff at that moment', async () => {
    const p = await project()
    const alive = (await rpc('agents.createSession', { projectId: p.id, cwd: dir, tool: 'claude' })) as SessionInfo
    placeNote(alive.id, 'the note of the session still alive')
    placeNote('vanished-session', 'a note with no owner')

    // Reopening the same store is exactly a restart.
    const reborn = new SessionManager(store, new Map([['claude', adapter as AgentAdapter]]), () => {})
    await vi.waitFor(() => {
      expect(existsSync(note('vanished-session'))).toBe(false)
    })
    expect(existsSync(note(alive.id))).toBe(true)
    expect(reborn.listSessions().length).toBeGreaterThan(0)

    // An empty directory is left behind (#104) — removing the whole folder would take down a handoff that
    // started in the meantime.
    expect(existsSync(join(data, 'handoff', p.id))).toBe(true)
  })
})

/**
 * A handoff note lives outside the user's repository (#142).
 *
 * The old location, `<project>/.centralu/handoff/`, was inside the user's repository and so not
 * ignored by git, and cleanup trusted that folder: committing `.centralu/handoff -> ..` in a
 * repository made the host delete every `*.md` at the repository root each time it started
 * (measured — README.md and CHANGELOG.md vanished without even passing through the session archive). The
 * note now lives in the data folder, and the host neither reads, writes, nor cleans the old
 * location. It also leaves alone any note already sitting in the old location — an old successor
 * session is still holding that path.
 */
describe('a handoff note lives in the data folder (#142)', () => {
  let repo: string
  let outside: string
  let data: string

  beforeEach(() => {
    data = mkdtempSync(join(tmpdir(), 'cc-142-data-'))
    vi.stubEnv('CC_DATA_DIR', data)
    // A real repository — commits README.md and a `.centralu/handoff` link pointing at the repository root.
    // (the link is a tracked symlink to an ancestor, which a junction cannot stand in for: git would walk into it)
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'cc-142-repo-')))
    outside = realpathSync(mkdtempSync(join(tmpdir(), 'cc-142-outside-')))
    const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' })
    git('init', '-q')
    writeFileSync(join(repo, 'README.md'), '# User README\n')
    writeFileSync(join(repo, 'CHANGELOG.md'), '# User changelog\n')
    mkdirSync(join(repo, '.centralu'))
    if (canSymlink) symlinkSync('..', join(repo, '.centralu', 'handoff'))
    git('add', '-A')
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init')
    writeFileSync(join(outside, 'NOTES.md'), 'a note outside the repository')
  })
  afterEach(() => {
    for (const d of [repo, outside, data]) rmSync(d, { recursive: true, force: true })
  })

  const status = () => execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' })
  const repoFiles = () => ['README.md', 'CHANGELOG.md'].map((f) => existsSync(join(repo, f)))

  itSymlink("startup cleanup and session deletion do not follow the link and delete files in the user's repository", async () => {
    const p = (await rpc('projects.add', { path: repo })) as { id: string }
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: repo, tool: 'claude' })) as SessionInfo
    // Exactly the shape the old cleanup used to delete: a `*.md` named anything but a session id — both at
    // the repository root and outside the repository the link points to.
    const orphan = join(data, 'handoff', p.id, 'gone-session.md')
    mkdirSync(join(data, 'handoff', p.id), { recursive: true })
    writeFileSync(orphan, 'a note with no owner')

    // Restart — the moment startup cleanup runs. Knowing cleanup ran is evidenced by the orphan in the data
    // folder being swept.
    new SessionManager(store, new Map([['claude', adapter as AgentAdapter]]), () => {})
    await vi.waitFor(() => expect(existsSync(orphan)).toBe(false))
    expect(repoFiles()).toEqual([true, true])

    // Session deletion triggers cleanup too — the same holds even when the link points outside the
    // repository.
    rmSync(join(repo, '.centralu', 'handoff'))
    linkDir(outside, join(repo, '.centralu', 'handoff'))
    await mgr.trashSession(s.id)
    await mgr.trash.purgeSession(s.id)
    expect(repoFiles()).toEqual([true, true])
    expect(readdirSync(outside)).toEqual(['NOTES.md'])
  })

  itSymlink('both record mode and agent mode write to the same location (the data folder), and nothing is written to the repository', async () => {
    const p = (await rpc('projects.add', { path: repo })) as { id: string }
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: repo, tool: 'claude' })) as SessionInfo
    const expected = join(data, 'handoff', p.id, `${s.id}.md`)

    // Record mode: the host builds it from the raw text.
    const record = (await rpc('agents.exportHandoffRecord', { sessionId: s.id, toTool: 'codex' })) as { text: string; path: string }
    expect(record.path).toBe(expected)
    expect(readFileSync(expected, 'utf8')).toBe(record.text)

    // Agent mode: remembers the position right before asking, then asks. The agent answers without writing a
    // file.
    const before = store.messages.loadMessages(s.id, 1).at(-1)?.seq ?? 0
    await rpc('agents.send', { sessionId: s.id, text: 'please write the handoff note as your answer' })
    const h = adapter.handleOf(s.id)!
    h.emitToolCall('Bash', 'git status') // Checks status first — whatever came before this is not the note.
    // While the turn is still running it is "not yet" — the last text at that point could be a progress
    // report.
    expect(await rpc('agents.exportHandoffNote', { sessionId: s.id, afterSeq: before })).toBeNull()
    h.emitDelta('# 1. Project and goal\nA note the agent wrote as its answer')
    h.finishTurn()
    const got = (await rpc('agents.exportHandoffNote', { sessionId: s.id, afterSeq: before })) as { text: string; path: string }
    // The host's lineage line leads the agent's own words (#1487): this session is the only one before the successor
    expect(got).toEqual({ text: `${lineageLine([s.id])}\n# 1. Project and goal\nA note the agent wrote as its answer`, path: expected })
    expect(readFileSync(expected, 'utf8')).toBe(got.text)

    // The user's repository is unchanged — not a single untracked file.
    expect(status()).toBe('')
    expect(readdirSync(repo).sort()).toEqual(['.centralu', '.git', 'CHANGELOG.md', 'README.md'])
  })

  itSymlink('a successor is granted read access to the note folder — at creation and on wake-up, only for a session that inherited one', async () => {
    const p = (await rpc('projects.add', { path: repo })) as { id: string }
    const dying = (await rpc('agents.createSession', { projectId: p.id, cwd: repo, tool: 'claude' })) as SessionInfo
    expect(adapter.lastOpts?.readableDirs).toBeUndefined() // A session that did not inherit anything gets nothing extra.
    const heir = (await rpc('agents.createSession', {
      projectId: p.id, cwd: repo, tool: 'claude',
      handoff: { from: dying.name, note: 'note', fromSessionId: dying.id },
    })) as SessionInfo
    expect(adapter.lastOpts?.readableDirs).toEqual([join(data, 'handoff', p.id)])

    // Granted again on wake-up after a restart too — the first message still points at that path.
    const reborn = new SessionManager(store, new Map([['claude', adapter as AgentAdapter]]), () => {})
    await reborn.resumeSession(heir.id)
    expect(adapter.lastOpts?.sessionId).toBe(heir.id)
    expect(adapter.lastOpts?.readableDirs).toEqual([join(data, 'handoff', p.id)])
  })
})
