/**
 * SessionManager through RPC with an in-memory adapter: projects, their trust, order and defaults.
 * Shared fakes and the world each test starts from are in manager.test-helpers.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join, sep } from 'node:path'
import { tmpdir } from 'node:os'
import type { NormalizedEvent, SessionInfo } from '@cc/protocol'
import { Store } from '../dev-services/store.js'
import { plantedRepo } from '../dev-services/planted-repo.test-helpers.js'
import { removeTree } from '../temp-dir.test-helpers.js'
import { SessionManager } from './manager.js'
import { createRpcHandler } from '../rpc.js'
import { SLOW } from '../../../../tooling/test-timing.js'
import { FakeAdapter, managerWorld, projectDirs } from './manager.test-helpers.js'

let store: Store
let adapter: FakeAdapter
let mgr: SessionManager
let events: NormalizedEvent[]
let rpc: ReturnType<typeof createRpcHandler>

beforeEach(() => {
  ;({ store, adapter, mgr, events, rpc } = managerWorld())
})

const addProject = () => rpc('projects.add', { path: tmpdir() }) as Promise<{ id: string; path: string }>

/** A new empty folder for a project of a test's own, removed after the test (#845) */
const projectDir = projectDirs()

describe('projects', () => {
  it('registers and shows up in the list', async () => {
    const p = await addProject()
    expect(p.path).toBe(tmpdir())
    expect((await rpc('projects.list', {}) as unknown[]).length).toBe(1)
  })

  it('rejects a directory that does not exist', async () => {
    await expect(rpc('projects.add', { path: '/nope/does/not/exist' })).rejects.toThrow(/Directory not found/)
  })

  it('re-registering the same path does not create a duplicate', async () => {
    await addProject()
    await addProject()
    expect((await rpc('projects.list', {}) as unknown[]).length).toBe(1)
  })

  /*
   * #849: `C:\proj\`, `c:\proj` and `C:\Proj` were registered as three projects of one folder. A trailing separator does
   * that anywhere; case, the drive letter's included, and a short name (`RUNNER~1`) only where paths fold case.
   */
  /*
   * #849 review: the folder match folded case with JS's rules, where the Kelvin sign (U+212A) lowers to k. Windows
   * keeps the two apart, so two folders became one project. Only the real spelling on disk is compared now.
   */
  it('keeps two folders apart whose names only JS folds together', async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-two-projects-')))
    try {
      const kelvin = join(dir, 'Keep')
      const plain = join(dir, 'keep')
      mkdirSync(kelvin)
      // A file system that folds them too (APFS) has one folder here, and nothing to keep apart
      if (!existsSync(plain)) {
        mkdirSync(plain)
        const one = (await rpc('projects.add', { path: kelvin })) as { id: string }
        const two = (await rpc('projects.add', { path: plain })) as { id: string }
        expect(two.id).not.toBe(one.id)
        expect(((await rpc('projects.list', {})) as unknown[]).length).toBe(2)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('registers one folder as one project, whatever the spelling', async () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-one-project-long-name-')))
    try {
      const first = (await rpc('projects.add', { path: `${dir.slice(0, 1).toLowerCase()}${dir.slice(1)}${sep}` })) as { id: string; path: string }
      // Kept without the separator, and the drive letter (Windows) in capitals
      expect(first.path).toBe(dir)
      const spellings = [dir]
      if (process.platform === 'win32') {
        const short = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `"for %I in ("${dir}") do @echo %~sI"`], {
          windowsVerbatimArguments: true,
        }).stdout.toString().trim()
        expect(short, 'this volume makes short names').not.toBe(dir)
        spellings.push(dir.toUpperCase(), dir.toLowerCase(), short)
      }
      for (const path of spellings) {
        expect(((await rpc('projects.add', { path })) as { id: string }).id, path).toBe(first.id)
      }
      expect((await rpc('projects.list', {})) as { path: string }[]).toEqual([expect.objectContaining({ id: first.id, path: dir })])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  /*
   * The sidebar's change count re-asks through this door every time a turn ends (issue #41).
   * So this must be a path that measures **only one** project — if it builds the whole list and
   * keeps just one row, a single turn runs git status once per registered project.
   */
  it('gitStatus returns the one project asked about, and rejects an unknown id', async () => {
    const p = await addProject()
    const one = (await rpc('projects.gitStatus', { projectId: p.id })) as { id: string; path: string }
    expect(one.id).toBe(p.id)
    expect(one.path).toBe(p.path)
    await expect(rpc('projects.gitStatus', { projectId: 'nope' })).rejects.toThrow(/Project not found/)
  })

  /*
   * #407: adding a folder is enough for the host to read it, so every read a project's screens make
   * must run none of the repository's programs until the person trusts it. The reads themselves are
   * covered one by one in git-untrusted.test.ts; this is the wiring — each door passes the
   * project's trust, read fresh, rather than a default.
   */
  it('runs none of the repository’s programs before project trust, through every door that reads it', async () => {
    const planted = plantedRepo()
    try {
      const project = (await rpc('projects.add', { path: planted.dir })) as { id: string }
      const projectId = project.id
      await rpc('projects.list', {})
      await rpc('projects.gitStatus', { projectId })
      await rpc('git.status', { projectId })
      await rpc('git.diff', { projectId, path: 'a.txt' })
      await rpc('git.diff', { projectId, path: 'new.txt' })
      await rpc('git.log', { projectId })
      await rpc('git.commitDetail', { projectId, sha: planted.signed })
      await rpc('git.ignoredEntries', { projectId })
      await rpc('git.checkout', { projectId, branch: 'main', dryRun: true })
      await rpc('fs.listDir', { projectId, path: '' })
      await rpc('files.search', { projectId, query: 'new' })
      await expect(
        rpc('agents.createSession', { projectId, cwd: planted.dir, tool: 'claude', worktree: true }),
      ).rejects.toThrow(/trusted project/)
      expect(planted.ran()).toEqual([])

      await rpc('projects.setTrusted', { projectId, trusted: true })
      await rpc('projects.gitStatus', { projectId })
      expect(planted.ran()).toContain('fsmonitor')
    } finally {
      await removeTree(planted.root)
    }
    /*
     * Its own limit, because the work is the point: a planted repository and every door that reads it, each a real
     * git process (about twenty). That took 2.3 to 4.0 s on windows-2022 and 17.4 s once on a loaded runner, past the
     * 15 s default (#845); nothing here waits on time, so there is nothing to wait on instead.
     */
  }, 30_000 * SLOW)

  /*
   * The last tool chosen becomes that project's default (2026-08-27 flow review).
   *
   * default_tool was hardcoded to 'claude' when a project was created, and there was **no place**
   * that ever updated it afterward — a person using codex had to reselect it forever, on every new
   * session. The fact that matters here is not the settings screen but the act of creating a
   * session, so both the UI and the orchestrator get the same rule.
   */
  it('creating a session makes that tool the project default', async () => {
    const p = await addProject()
    const list = async () => ((await rpc('projects.list', {})) as { id: string; defaultTool: string }[])
    expect((await list()).find((x) => x.id === p.id)!.defaultTool).toBe('claude')

    await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'codex' })
    expect((await list()).find((x) => x.id === p.id)!.defaultTool).toBe('codex')

    // Switching back follows the same path — the last choice always wins.
    await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })
    expect((await list()).find((x) => x.id === p.id)!.defaultTool).toBe('claude')
  })
})

/**
 * When project trust reaches a session (M4 decision 3, #92).
 *
 * A repository's files (.claude/, .codex/) are read once when the tool process starts. So the
 * manager passes along the trust value **at the moment the session is launched**, and changing
 * trust afterward does not swap out a running process — it takes effect the next time one starts.
 */
describe('project trust → session (#92)', () => {
  it('a session receives the trust value at launch, and gets the changed value the next time it starts (restart)', async () => {
    const p = await addProject()
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as { id: string }
    // A newly registered project is untrusted (v33's default).
    expect(adapter.lastOpts?.projectTrusted).toBe(false)
    const first = adapter.last

    await rpc('projects.setTrusted', { projectId: p.id, trusted: true })
    // The running session is unchanged — the process was not swapped.
    expect(adapter.last).toBe(first)

    await rpc('agents.restartSession', { sessionId: s.id })
    expect(adapter.last).not.toBe(first)
    expect(adapter.lastOpts?.projectTrusted).toBe(true)

    // Revoking follows the same path.
    await rpc('projects.setTrusted', { projectId: p.id, trusted: false })
    await rpc('agents.restartSession', { sessionId: s.id })
    expect(adapter.lastOpts?.projectTrusted).toBe(false)
  })

  it('a session with no project (the orchestrator) starts untrusted — that folder is a place workers can write to', async () => {
    await mgr.orchestrator()
    expect(adapter.lastOpts?.projectTrusted).toBe(false)
  })
})

/**
 * M2.6 dogfooding. "Hide (archive)" used to sit alongside this — dropped on 2026-09-02: there was
 * a door in (`d` in the inbox) but no door out, so to a person it looked the same as delete.
 * All that is left is delete, which makes what delete actually erases matter more.
 */
/*
 * #288 changed the grid's RPC from bare session ids to tagged panels, by expanding it (protocol.md §4) rather than
 * bumping PROTOCOL_VERSION: a UI one build older still speaks the old shape to this host, and must keep working.
 */
describe('the grid RPC speaks panels only (#288, #1143)', () => {
  it('refuses a save of bare session ids, the shape of a window before panels', async () => {
    const p = await addProject()
    const a = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as SessionInfo
    await expect(rpc('grid.set', { sessionIds: [a.id] })).rejects.toThrow()
  })

  it('saves panels and gets panels back, with or without `tagged`, which a beta.45 host needs', async () => {
    const p = await addProject()
    const a = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as SessionInfo
    const panels = [
      { kind: 'app', projectId: p.id, appId: 'slider' },
      { kind: 'session', sessionId: a.id },
      { kind: 'app', projectId: null, appId: 'notes' },
    ]
    expect(await rpc('grid.set', { panels })).toEqual(panels)
    expect(await rpc('grid.get', { tagged: true })).toEqual(panels)
    expect(await rpc('grid.get', {})).toEqual(panels)
  })

  it('refuses a save that names no panels', async () => {
    await expect(rpc('grid.set', {})).rejects.toThrow()
  })

  // #306: the span the person chose for an app panel goes through the RPC and comes back with it
  it('an app panel’s span is saved and read back with its placement, and one out of bounds is refused', async () => {
    const p = await addProject()
    const a = (await rpc('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as SessionInfo
    const panels = [
      { kind: 'session', sessionId: a.id },
      { kind: 'app', projectId: p.id, appId: 'board', span: { cols: 2, rows: 1 } },
      { kind: 'app', projectId: null, appId: 'notes' },
    ]
    expect(await rpc('grid.set', { panels })).toEqual(panels)
    expect(await rpc('grid.get', { tagged: true })).toEqual(panels)
    await expect(
      rpc('grid.set', { panels: [{ kind: 'app', projectId: null, appId: 'notes', span: { cols: 9, rows: 1 } }] }),
    ).rejects.toThrow()
  })
})

/**
 * Order is one global sequence (sidebar_order). Dragging to reorder within one project must not
 * scramble another project's order too — only the slots this project occupied change.
 */
describe('reordering within a project does not disturb the global order', () => {
  it('a session that was not moved stays exactly where it was', async () => {
    const p1 = (await rpc('projects.add', { path: projectDir('cc-p1-') })) as { id: string; path: string }
    const p2 = (await rpc('projects.add', { path: projectDir('cc-p2-') })) as { id: string; path: string }
    // Global order: a1, b1, a2, b2 (creation order)
    const mk = async (proj: { id: string; path: string }) =>
      ((await rpc('agents.createSession', { projectId: proj.id, cwd: proj.path, tool: 'claude' })) as { id: string }).id
    const a1 = await mk(p1)
    const b1 = await mk(p2)
    const a2 = await mk(p1)
    const b2 = await mk(p2)

    // Reverse the order only within p1.
    const after = mgr.reorderSessions(p1.id, [a2, a1]).map((s) => s.id)

    // Only p1's slots (1st and 3rd) change; p2 stays the same.
    expect(after).toEqual([a2, b1, a1, b2])
    // The storage matches the same order — it must not fall out of sync with the screen after a restart.
    expect(store.sessions.listSessions().map((s) => s.id)).toEqual([a2, b1, a1, b2])
  })

  it('sorts the sessions in place, so a module that holds the map reads the new order (#1143)', async () => {
    const p1 = (await rpc('projects.add', { path: projectDir('cc-p1-') })) as { id: string; path: string }
    const mk = async () =>
      ((await rpc('agents.createSession', { projectId: p1.id, cwd: p1.path, tool: 'claude' })) as { id: string }).id
    const a1 = await mk()
    const a2 = await mk()
    // What a module reaching the manager's sessions holds, taken before the reorder
    const held = (mgr as unknown as { meta: Map<string, SessionInfo> }).meta

    mgr.reorderSessions(p1.id, [a2, a1])

    expect([...held.keys()]).toEqual([a2, a1])
    expect((mgr as unknown as { meta: Map<string, SessionInfo> }).meta).toBe(held)
  })
})

/**
 * The foundation of the session tree (#69-1): a worktree session never stands without a manager.
 *
 * The #1 documented failure in this category is the orphan worktree (Vibe Kanban
 * #1764/#2335/#1571). Orphans happen when nobody is responsible, so membership is enforced at
 * two points — attached at creation, and adopted at startup.
 */
describe('the last model/effort chosen becomes the project default (#69 5) — per tool (#107)', () => {
  type Listed = { id: string; defaultModels: Record<string, { model: string | null; effort: string | null }> }
  const defaultsOf = async (projectId: string) =>
    ((await rpc('projects.list', {})) as Listed[]).find((x) => x.id === projectId)?.defaultModels

  it("changing settings writes to that session's tool slot", async () => {
    const p = await addProject()
    const a = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as SessionInfo
    await mgr.updateSettings(a.id, { model: 'opus', effort: 'high' })

    expect(await defaultsOf(p.id)).toEqual({ claude: { model: 'opus', effort: 'high' } })
  })

  /*
   * #107, a real incident: a project with `default_tool=codex` was holding
   * `default_model=opus[1m]`, and a codex session born there died with a 400 on every turn. This
   * happened because there was only one slot — the two tools' selections must not be able to
   * overwrite each other.
   */
  it('selections for different tools do not overwrite each other', async () => {
    const p = await addProject()
    const a = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'claude' })) as SessionInfo
    await mgr.updateSettings(a.id, { model: 'opus', effort: 'high' })
    const b = (await rpc('agents.createSession', { projectId: p.id, cwd: p.path, tool: 'codex' })) as SessionInfo
    await mgr.updateSettings(b.id, { model: 'gpt-5-codex' })

    expect(await defaultsOf(p.id)).toEqual({
      claude: { model: 'opus', effort: 'high' },
      codex: { model: 'gpt-5-codex', effort: null },
    })
  })
})

describe('project trust changes restart live sessions (#663)', () => {
  const trustNotices = () => events.filter((e) => e.type === 'notice' && e.label === 'restart' && /trust/.test(e.text))

  it('restarts an idle session with the project setting sources when the project becomes trusted', async () => {
    const project = await addProject()
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    const old = adapter.handleOf(session.id)!
    expect(adapter.lastOpts?.projectTrusted).toBe(false)

    await mgr.setProjectTrusted(project.id, true)

    expect(old.disposed).toBe(true)
    expect(adapter.handleOf(session.id)).not.toBe(old)
    expect(adapter.lastOpts?.projectTrusted).toBe(true)
    expect(store.settings.appSetting(`launch_settings:${session.id}`)).toContain('trusted')
    expect(trustNotices()).toHaveLength(1)
    expect(trustNotices()[0]).toMatchObject({ sessionId: session.id, text: expect.stringContaining('now reads the project') })
  })

  it('restarts an idle session with user-only sources when the project is no longer trusted', async () => {
    const project = await addProject()
    await mgr.setProjectTrusted(project.id, true)
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    const old = adapter.handleOf(session.id)!
    expect(adapter.lastOpts?.projectTrusted).toBe(true)

    await mgr.setProjectTrusted(project.id, false)

    expect(old.disposed).toBe(true)
    expect(adapter.handleOf(session.id)).not.toBe(old)
    expect(adapter.lastOpts?.projectTrusted).toBe(false)
    expect(trustNotices()).toHaveLength(1)
    expect(trustNotices()[0]).toMatchObject({ sessionId: session.id, text: expect.stringContaining('only your own settings') })
  })

  it('restarts an in-turn session at the end of its turn', async () => {
    const project = await addProject()
    const session = await mgr.createSession({ projectId: project.id, cwd: project.path, tool: 'claude', permissionPreset: 'normal' })
    const old = adapter.handleOf(session.id)!
    await rpc('agents.send', { sessionId: session.id, text: 'work' })

    await mgr.setProjectTrusted(project.id, true)
    expect(old.disposed).toBe(false)
    expect(trustNotices()).toHaveLength(0)

    old.finishTurn()
    await vi.waitFor(() => expect(adapter.handleOf(session.id)).not.toBe(old))
    expect(old.disposed).toBe(true)
    expect(adapter.lastOpts?.projectTrusted).toBe(true)
    expect(trustNotices()).toHaveLength(1)
  })

  it('leaves the sessions of other projects alone', async () => {
    const project = await addProject()
    const other = await rpc('projects.add', { path: projectDir('trust-other-') }) as { id: string; path: string }
    const bystander = await mgr.createSession({ projectId: other.id, cwd: other.path, tool: 'claude', permissionPreset: 'normal' })
    const handle = adapter.handleOf(bystander.id)!

    await mgr.setProjectTrusted(project.id, true)

    expect(handle.disposed).toBe(false)
    expect(adapter.handleOf(bystander.id)).toBe(handle)
    expect(trustNotices()).toHaveLength(0)
  })
})
