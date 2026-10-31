/**
 * SessionManager through RPC with an in-memory adapter: past sessions, resuming and catching up on a conversation.
 * Shared fakes and the world each test starts from are in manager.test-helpers.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { AdapterCapabilities, NormalizedEvent, SessionInfo, StoredMessage, ToolName } from '@cc/protocol'
import { sessionLiveDefaults } from '@cc/protocol'
import { UPDATE_CONTINUE_TEXT } from '../adapters/input-receipts.js'
import type { AgentAdapter, CreateSessionOpts, EventSink, HistoryEvent, HistoryMessage } from '../adapters/contract.js'
import { Store } from '../dev-services/store.js'
import { SessionManager } from './manager.js'
import { createRpcHandler } from '../rpc.js'
import { CwdFiledAdapter, FakeAdapter, managerWorld } from './manager.test-helpers.js'

let store: Store
let adapter: FakeAdapter
let mgr: SessionManager
let events: NormalizedEvent[]
let rpc: ReturnType<typeof createRpcHandler>

beforeEach(() => {
  ;({ store, adapter, mgr, events, rpc } = managerWorld())
})

const addProject = () => rpc('projects.add', { path: tmpdir() }) as Promise<{ id: string; path: string }>

/**
 * Loading past sessions (FR-10 extension).
 * The path for taking over a conversation the tool already has — the list and body come from the
 * adapter's official API.
 */
describe('loading past sessions', () => {
  class ListingAdapter extends FakeAdapter {
    override readonly capabilities: AdapterCapabilities = {
      approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false,
    }
    listed: { cwd: string; limit: number } | null = null
    read: { externalId: string; cwd: string } | null = null
    fail: Error | null = null
    async listExternalSessions(cwd: string, limit: number) {
      this.listed = { cwd, limit }
      if (this.fail) throw this.fail
      return [{ externalId: 'ext-past', title: 'Work from yesterday', updatedAt: 111, branch: 'main' }]
    }
    async readExternalHistory(externalId: string, cwd: string) {
      this.read = { externalId, cwd }
      if (this.fail) throw this.fail
      return [
        { role: 'user' as const, text: 'fix the test' },
        { role: 'assistant' as const, text: 'Fixed it.' },
      ]
    }
  }

  const withListing = () => {
    const a = new ListingAdapter()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    return { a, m, rpc: createRpcHandler(m, adapters) }
  }

  it('gives a list of past sessions the tool has on file', async () => {
    const { a, m, rpc: call } = withListing()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const res = await m.externals.listExternalSessions(p.id, 'claude', 30)
    expect(res.supported).toBe(true)
    expect(a.listed).toEqual({ cwd: tmpdir(), limit: 30 })
    expect(res.sessions).toEqual([
      { externalId: 'ext-past', tool: 'claude', title: 'Work from yesterday', updatedAt: 111, createdAt: null, branch: 'main', imported: false, importedAs: null },
    ])
  })

  it('failing to fetch the list gives a reason instead of throwing — creating a new session must still work', async () => {
    const { a, m, rpc: call } = withListing()
    a.fail = new Error('codex needs an update')
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const res = await m.externals.listExternalSessions(p.id, 'claude', 30)
    expect(res).toMatchObject({ supported: false, reason: 'codex needs an update', sessions: [] })
    // Even if the listing dies, the creation path is unaffected.
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    expect(s.id).toBeTruthy()
  })

  it('an unsupported adapter answers with supported=false', async () => {
    const p = await addProject()
    const res = await mgr.externals.listExternalSessions(p.id, 'claude', 30)
    expect(res.supported).toBe(false)
    expect(res.sessions).toEqual([])
  })

  it('loading restores the past conversation into the record, marked as already read', async () => {
    const { a, m, rpc: call } = withListing()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude',
      resumeExternalId: 'ext-past', importHistory: true,
    })) as { id: string; name: string; lastSeq: number; lastReadSeq: number }

    expect(a.read).toEqual({ externalId: 'ext-past', cwd: tmpdir() })
    const msgs = (await call('messages.load', { sessionId: s.id, limit: 100 })) as { role: string; payload: { text: string } }[]
    expect(msgs.map((x) => [x.role, x.payload.text])).toEqual([
      ['user', 'fix the test'],
      ['assistant', 'Fixed it.'],
    ])
    // A loaded conversation does not summon the person — an unread badge must not appear.
    const after = m.listSessions().find((x) => x.id === s.id)!
    expect(after.lastReadSeq).toBe(after.lastSeq)
    expect(after.lastSeq).toBe(2)
    // The session name comes from the resumed conversation.
    expect(after.name).toBe('fix the test')
  })

  it('a loaded session is also marked imported in the list — so the same conversation is not opened twice', async () => {
    const { m, rpc: call } = withListing()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-past', importHistory: true,
    })
    const res = await m.externals.listExternalSessions(p.id, 'claude', 30)
    expect(res.sessions[0]!.imported).toBe(true)
  })

  it('the session still comes alive even if the history cannot be read — there is no reason to block the conversation too', async () => {
    const { a, m, rpc: call } = withListing()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const created = call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-past', importHistory: true,
    })
    a.fail = new Error('Could not read the transcript')
    const s = (await created) as { id: string }
    expect(m.isLive(s.id)).toBe(true)
  })
})

/**
 * On the wake-up path there are times it does not have to pay **the cost of re-reading the
 * external record**.
 *
 * This catch-up is the correction that pulls in what was said outside the app (in the tool's
 * terminal), and it used to read the whole transcript every time, even when nothing had been
 * written outside. The cost grows with the conversation's length — measured at 48.6MB / 8.9s on
 * a 775-turn codex thread, and that 8.9s is paid **before the first message goes out**.
 *
 * Three contracts hold here: do not read if nothing changed, read if it changed, and **read if
 * it is unknown.** The last one matters most — folding "unknown" into "unchanged" means whatever
 * was said outside never comes in, ever.
 */
describe('a record unchanged outside is not read again', () => {
  class SyncAdapter extends FakeAdapter {
    updatedAt = 100
    reads = 0
    lists = 0
    async listExternalSessions() {
      this.lists++
      return [{ externalId: 'ext-1', title: 'Work from yesterday', updatedAt: this.updatedAt }]
    }
    async readExternalHistory() {
      this.reads++
      return [{ role: 'user' as const, text: 'something said outside' }]
    }
  }
  /** A tool that cannot give a list — there is no way to know the timestamp. */
  class BlindAdapter extends FakeAdapter {
    reads = 0
    async readExternalHistory() {
      this.reads++
      return [{ role: 'user' as const, text: 'something said outside' }]
    }
  }

  /** Standing a new manager up on the same store = turning the app off and on (the cache is empty, but the marker remains). */
  const relaunch = (a: AgentAdapter) => {
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    return { m, call: createRpcHandler(m, adapters) }
  }

  const sleepingSession = async (a: AgentAdapter) => {
    const { m, call } = relaunch(a)
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as {
      id: string
    }
    await m.disposeAll() // The state after a host restart: the record exists, only the process is missing.
    return s.id
  }

  it('does not read on the second wake-up — and does not re-ask for the list either', async () => {
    const a = new SyncAdapter()
    const id = await sleepingSession(a)

    const first = relaunch(a)
    await first.call('agents.send', { sessionId: id, text: 'continue' })
    expect(a.reads).toBe(1)
    /*
      Fetching the list is **a cost paid regardless** (externalGone already asks "does this
      conversation still exist?"). This is evidence of nothing more than not throwing away the
      updatedAt that rides along in that answer — no extra round trip was added.
    */
    expect(a.lists).toBe(1)

    await first.m.disposeAll()
    const second = relaunch(a)
    await second.call('agents.send', { sessionId: id, text: 'once more' })
    expect(a.reads).toBe(1) // Nothing changed outside, so the 48.6MB is not fetched again.
  })

  it('reads when the conversation continued outside — saving effort must not mean missing it', async () => {
    const a = new SyncAdapter()
    const id = await sleepingSession(a)

    const first = relaunch(a)
    await first.call('agents.send', { sessionId: id, text: 'continue' })
    expect(a.reads).toBe(1)

    await first.m.disposeAll()
    a.updatedAt = 200 // The conversation continued in the terminal.
    const second = relaunch(a)
    await second.call('agents.send', { sessionId: id, text: 'once more' })
    expect(a.reads).toBe(2)
  })

  it('a tool whose timestamp is unknown still reads every time, as before', async () => {
    const a = new BlindAdapter()
    const id = await sleepingSession(a)

    const first = relaunch(a)
    await first.call('agents.send', { sessionId: id, text: 'continue' })
    await first.m.disposeAll()
    const second = relaunch(a)
    await second.call('agents.send', { sessionId: id, text: 'once more' })

    expect(a.reads).toBe(2)
  })

  /*
   * A tool with a writer lock (codex): nothing outside can write while we hold the handle. So a
   * timestamp taken at the moment we let go can mean "every change older than this is ours."
   * Without this, updatedAt climbs on every in-app turn, and a daily session's first wake-up of
   * the morning always paid for a full read (measured at 48.6MB / 8.9s).
   */
  class LockingAdapter extends SyncAdapter {
    override readonly capabilities: AdapterCapabilities = {
      approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: true, backgroundTasks: false,
    }
  }

  it('a locking tool does not re-read because of an in-app conversation — the release marker covers it', async () => {
    const a = new LockingAdapter()
    const first = relaunch(a)
    const p = (await first.call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await first.call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as {
      id: string
    }
    // Talked inside the app — the tool's updatedAt climbs (all of it is ours, since it is before release).
    await first.call('agents.send', { sessionId: s.id, text: 'do the work' })
    a.updatedAt = Date.now() - 1000
    await first.m.disposeAll() // The marker gets stamped here.

    const second = relaunch(a)
    await second.call('agents.send', { sessionId: s.id, text: 'continue' })
    expect(a.reads).toBe(0) // Everything that changed is something we said — the full transcript is not read.
  })

  it('a locking tool still reads if something is written outside after release — the marker is laziness, not earmuffs', async () => {
    const a = new LockingAdapter()
    const first = relaunch(a)
    const p = (await first.call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await first.call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as {
      id: string
    }
    await first.m.disposeAll()

    a.updatedAt = Date.now() + 60_000 // Continued in the terminal after release.
    const second = relaunch(a)
    await second.call('agents.send', { sessionId: s.id, text: 'continue' })
    expect(a.reads).toBe(1)
  })

  it('a tool without a lock gets no marker stamped — something written outside while it was alive must not disappear', async () => {
    const a = new SyncAdapter() // exclusiveWriter: false (the shape of claude)
    const first = relaunch(a)
    const p = (await first.call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await first.call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as {
      id: string
    }
    // Also written outside while alive (possible because claude has no lock).
    a.updatedAt = Date.now() - 1000
    await first.m.disposeAll()

    const second = relaunch(a)
    await second.call('agents.send', { sessionId: s.id, text: 'continue' })
    expect(a.reads).toBe(1) // If the marker had covered that message, this would be 0.
  })
})

/**
 * What hiding means: **it clears the conversation from Centralu's list only.**
 * The conversation still remains in the tool (claude/codex), so it must be recoverable through
 * "past conversations." If that path is blocked, hiding becomes deletion in all but name.
 */
describe('a deleted session can be recovered from the past-conversations list', () => {
  class ListingAdapter2 extends FakeAdapter {
    override readonly capabilities: AdapterCapabilities = {
      approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false,
    }
    async listExternalSessions() {
      return [{ externalId: 'ext-past', title: 'Work from yesterday', updatedAt: 111 }]
    }
    async readExternalHistory() {
      return [{ role: 'user' as const, text: 'Work from yesterday' }]
    }
  }

  it('is shown as "already imported" while in the list, and can be pulled in again once deleted', async () => {
    const a = new ListingAdapter2()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    const call = createRpcHandler(m, adapters)
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }

    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude',
      resumeExternalId: 'ext-past', importHistory: true,
    })) as { id: string }

    // While it is in the list, it is blocked from being opened again — and it also reports which session it
    // is open as.
    const listed = (await m.externals.listExternalSessions(p.id, 'claude', 30)).sessions[0]!
    expect(listed.imported).toBe(true)
    expect(listed.importedAs).toBe(s.id)

    await m.trashSession(s.id)

    /*
      A deleted session **must be recoverable** from the past-conversations list. Blocking it here
      makes deletion look like it burned down the tool's record too — the sentence the delete
      dialog promises (the conversation stays in the tool, and can be pulled back out via
      + → Past conversations) is exactly this assertion.
    */
    expect((await m.externals.listExternalSessions(p.id, 'claude', 30)).sessions[0]!.imported).toBe(false)
  })
})

/**
 * When the tool has no record of the conversation we are trying to resume.
 *
 * Measured: resuming anyway starts the process and the first turn dies with
 * error_during_execution — not a silent success (that would be worst), but it tells the user
 * nothing about the cause.
 *
 * And the cause is not necessarily a deletion. The tool files conversations **by working
 * directory**, so "not found" also means "this folder moved" — which is what actually happened
 * in issue #28. These tests hold the message to the observation.
 */
describe('when the tool cannot find the conversation', () => {
  class GoneAdapter extends FakeAdapter {
    override readonly capabilities: AdapterCapabilities = {
      approvals: true, contextUsage: 'exact', resume: true, autoTitle: true, attachments: [], verbosities: [], exclusiveWriter: false, backgroundTasks: false,
    }
    /** The list of ids the tool will answer that it has. */
    present: string[] = ['ext-1']
    failList = false
    async listExternalSessions() {
      if (this.failList) throw new Error('could not fetch the list')
      return this.present.map((externalId) => ({ externalId, title: externalId, updatedAt: 1 }))
    }
    /** The forked-from original id — the test checks the original was not touched. */
    forkedFrom: string | null = null
    /** Turning it off means "this tool cannot fork" (an optional method is itself the capability). */
    canFork = true
    forkConversation = async (externalId: string) => {
      if (!this.canFork) throw new Error('unreachable — if canFork=false there should be no such method')
      this.forkedFrom = externalId
      this.present = [...this.present, 'forked-1']
      return 'forked-1'
    }
  }

  const setup = () => {
    const a = new GoneAdapter()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    return { a, m, call: createRpcHandler(m, adapters) }
  }

  it('says only that it was not found — never that it was deleted', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    const startedIn = a.lastCwd
    // Bring down only the process (the same state as a host restart)
    await m.disposeAll()

    a.present = [] // the tool no longer lists it — an absence is all we actually know
    const r = await m.resumeSession(s.id)

    expect(r.resumed).toBe(false)
    /*
     * This used to assert `/was deleted in Claude Code/` — the test was pinning the lie in
     * place. All the tool reported was an absence, and an absence has two causes we cannot
     * tell apart from here: removed there, or the folder moved (issue #28). So: report the
     * observation, name the directory we looked in, claim no deletion nobody witnessed.
     */
    expect(r.reason).toMatch(/has no record of this conversation/)
    expect(r.reason).toContain(startedIn!)
    expect(r.reason).not.toMatch(/delete/i)
    // The record must remain readable — this does not delete the session.
    expect(m.listSessions().find((x) => x.id === s.id)).toBeDefined()
  })

  /*
   * codex limits a conversation to one writer ("already has an active writer"). This failure
   * used to get papered over as "codex app-server exited" by the time it reached the screen, so
   * the person was told a process had died when it had not, and got no way out. The reason has
   * to arrive as a **signal**, not a sentence, for the UI to be able to offer a fork.
   */
  it('gives a locked signal along with the failure when another side holds the conversation', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    // Bring down only the process (the same state as a host restart)
    await m.disposeAll()

    a.failCreate = Object.assign(new Error('This conversation is already open elsewhere'), {
      code: 'conversation_locked',
    })
    const r = await m.resumeSession(s.id)

    expect(r.resumed).toBe(false)
    expect(r.lockedElsewhere).toBe(true)
  })

  it('forking to continue leaves the original alone and points at the copy', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    const before = m.listSessions().find((x) => x.id === s.id)!.externalId
    // Bring down only the process (the same state as a host restart)
    await m.disposeAll()

    const r = await m.forkConversation(s.id)

    expect(r.resumed).toBe(true)
    expect(a.forkedFrom).toBe(before)
    // This session now points at the copy — going back for the original would lock again.
    expect(m.listSessions().find((x) => x.id === s.id)!.externalId).toBe('forked-1')
  })

  it('says so instead of silently ignoring it, when the tool cannot fork', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    // Capability is expressed by **whether the method exists**, not a flag (the rule in contract.ts).
    delete (a as { forkConversation?: unknown }).forkConversation

    const r = await m.forkConversation(s.id)

    expect(r.resumed).toBe(false)
    expect(r.reason).toMatch(/cannot fork/)
  })

  it('does not conclude deletion when the list cannot be fetched (the tool may just be briefly unavailable)', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    // Bring down only the process (the same state as a host restart)
    await m.disposeAll()

    a.failList = true
    const r = await m.resumeSession(s.id)

    // Blocking a perfectly fine session just because it could not be confirmed would cut off the conversation
    // over nothing more than the tool being briefly slow.
    expect(r.resumed).toBe(true)
  })

  it('does not treat it as deleted when the resumed original is still alive', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })) as { id: string }
    // Bring down only the process (the same state as a host restart)
    await m.disposeAll()

    // Resume issues a new id so external_id is not ext-1, but the original still exists.
    a.present = ['ext-1']
    expect((await m.resumeSession(s.id)).resumed).toBe(true)
  })
})

/**
 * The tool refuses when there are two writers for one conversation
 * (codex: "thread … already has an active writer"). The raw message explains nothing to the
 * user, so we intercept it first and report **who is holding it**.
 */
describe('the same conversation is not opened by two at once', () => {
  class ResumeAdapter extends FakeAdapter {
    async listExternalSessions() {
      return [{ externalId: 'ext-1', title: 'Work from yesterday', updatedAt: 1 }]
    }
    async readExternalHistory() {
      return [{ role: 'user' as const, text: 'Work from yesterday' }]
    }
  }
  const setup = () => {
    const a = new ResumeAdapter()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    return { a, m, call: createRpcHandler(m, adapters) }
  }

  it('says who is holding an already-open conversation when it is loaded again', async () => {
    const { m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })

    await expect(
      call('agents.createSession', {
        projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
      }),
    ).rejects.toThrow(/already open in the ".*" session/)
    // No half-created session is left behind.
    expect(m.listSessions()).toHaveLength(1)
  })

  it('can be reopened once the session holding it goes to sleep', async () => {
    const { m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })

    await m.disposeAll() // Once the process is cleaned up, nothing holds it.

    const second = await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })
    expect(second).toBeTruthy()
  })
})

/**
 * A person can start in Centralu, move to working with the tool's terminal, and come back.
 * Whatever was said in between piles up only in the tool while our screen stays frozen — since
 * the model remembers everything, **only the screen falling out of sync** makes this more
 * confusing. Catch up on wake-up.
 */
describe('catching up on a conversation continued outside', () => {
  class SyncAdapter extends FakeAdapter {
    /** The conversation the tool holds (this grows when continued from the terminal). */
    toolHistory: HistoryMessage[] = []
    async listExternalSessions() {
      return [{ externalId: 'ext-1', title: 'Conversation', updatedAt: 1 }]
    }
    async readExternalHistory() {
      return this.toolHistory
    }
  }
  const setup = () => {
    const a = new SyncAdapter()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    return { a, m, call: createRpcHandler(m, adapters) }
  }
  const texts = async (call: ReturnType<typeof createRpcHandler>, id: string) =>
    ((await call('messages.load', { sessionId: id, limit: 200 })) as { payload: { text?: string } }[])
      .map((r) => r.payload.text)
      .filter(Boolean)

  it('appends only the part that grew outside, without duplicating', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    a.toolHistory = [
      { role: 'user', text: 'First question' },
      { role: 'assistant', text: 'First answer' },
    ]
    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })) as { id: string }
    expect(await texts(call, s.id)).toEqual(['First question', 'First answer'])

    // Bring down only the process (the same state as a host restart)
    await m.disposeAll()

    // Work continued in the terminal in the meantime.
    a.toolHistory.push({ role: 'user', text: 'something said in the terminal' }, { role: 'assistant', text: 'a terminal answer' })

    await m.resumeSession(s.id)

    expect(await texts(call, s.id)).toEqual(['First question', 'First answer', 'something said in the terminal', 'a terminal answer'])
    expect(events.some((e) => e.type === 'history_synced')).toBe(true)
  })

  it('appends nothing when nothing happened outside', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    a.toolHistory = [{ role: 'user', text: 'First question' }]
    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })) as { id: string }

    // Bring down only the process (the same state as a host restart)
    await m.disposeAll()
    await m.resumeSession(s.id)

    expect(await texts(call, s.id)).toEqual(['First question'])
  })

  /*
   * #303: Codex's record names where it compacted (`contextCompaction` in thread/read), and a live compaction leaves
   * a marker. The record's compaction point is stored as that same marker — once, whether it was seen live or not.
   */
  const rows = async (call: ReturnType<typeof createRpcHandler>, id: string) =>
    ((await call('messages.load', { sessionId: id, limit: 200 })) as { kind: string; payload: { text?: string; type?: string } }[])
      .map((r) => (r.kind === 'marker' ? `[${r.payload.type}]` : r.payload.text))
  const compaction = { role: 'system', event: { type: 'compaction', sessionId: '', failed: false } } as const

  it('stores a compaction in the tool\'s record as the marker a live compaction leaves (import)', async () => {
    const { a, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    a.toolHistory = [{ role: 'user', text: 'First question' }, { role: 'assistant', text: 'First answer' }, compaction, { role: 'user', text: 'after' }]
    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })) as { id: string }
    expect(await rows(call, s.id)).toEqual(['First question', 'First answer', '[compaction]', 'after'])
    const stored = ((await call('messages.load', { sessionId: s.id, limit: 200 })) as StoredMessage[]).find((r) => r.kind === 'marker')!
    expect(stored).toMatchObject({ role: 'system', payload: { type: 'compaction', sessionId: s.id, failed: false } })
  })

  it('a compaction seen live is not stored again when catching up, and one that ran outside is', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    a.toolHistory = [{ role: 'user', text: 'First question' }, { role: 'assistant', text: 'First answer' }]
    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })) as { id: string }
    // A /compact while the app watched: the adapter's marker is stored live
    a.last!.emitEvent({ type: 'compaction', sessionId: s.id, failed: false })
    await m.disposeAll()
    // The tool's record has that compaction too, then work continued in the terminal, compacting once more there
    a.toolHistory.push(compaction, { role: 'user', text: 'said in the terminal' }, compaction, { role: 'assistant', text: 'a terminal answer' })
    await m.resumeSession(s.id)
    expect(await rows(call, s.id)).toEqual([
      'First question', 'First answer', '[compaction]', 'said in the terminal', '[compaction]', 'a terminal answer',
    ])
  })

  /*
   * #843: the tool's record holds a turn's tool calls too, read by the adapter's live normalizer. They are stored as
   * the rows the same events leave live, and once: a call that ran while the app watched is already ours.
   */
  const toolCall = (callId: string, command: string): HistoryEvent => ({ type: 'tool_call', sessionId: '', callId, summary: { tool: 'Bash', title: command, paths: [] }, input: { command } })
  const toolResult = (callId: string, output: string): HistoryEvent => ({ type: 'tool_result', sessionId: '', callId, ok: true, summary: output, output })
  const recorded = (e: HistoryEvent) => ({ role: 'system', event: e }) as const
  const shapes = (rows: StoredMessage[]) =>
    rows.map((r) => (r.kind === 'text' ? r.payload : { kind: r.kind, payload: { ...(r.payload as object), sessionId: undefined } }))

  it("stores the tool calls in the tool's record as the rows live ones leave (import)", async () => {
    const { a, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    a.toolHistory = [
      { role: 'user', text: 'List the files' },
      recorded(toolCall('tu1', 'ls')),
      recorded(toolResult('tu1', 'a.txt')),
      { role: 'assistant', text: 'One file' },
    ]
    const imported = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })) as { id: string }
    const stored = (await call('messages.load', { sessionId: imported.id, limit: 200 })) as StoredMessage[]
    expect(stored.filter((r) => r.kind !== 'text').map((r) => r.payload)).toEqual([
      expect.objectContaining({ type: 'tool_call', sessionId: imported.id, callId: 'tu1' }),
      expect.objectContaining({ type: 'tool_result', sessionId: imported.id, callId: 'tu1' }),
    ])
    // The same call made while the app watched leaves the same rows
    const watched = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    for (const e of [toolCall('tu1', 'ls'), toolResult('tu1', 'a.txt')]) a.last!.emitEvent({ ...e, sessionId: watched.id })
    const live = (await call('messages.load', { sessionId: watched.id, limit: 200 })) as StoredMessage[]
    expect(shapes(stored.filter((r) => r.kind !== 'text'))).toEqual(shapes(live.filter((r) => r.kind !== 'text')))
  })

  it('a tool call seen live is not stored again when catching up, and one made outside is', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    a.toolHistory = [{ role: 'user', text: 'List the files' }]
    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })) as { id: string }
    // While the app watched: the model said something and ran a command, then the process went away
    a.last!.emitEvent({ type: 'message_delta', sessionId: s.id, role: 'assistant', text: 'Let me look' })
    a.last!.emitEvent({ ...toolCall('tu1', 'ls'), sessionId: s.id })
    a.last!.emitEvent({ ...toolResult('tu1', 'a.txt'), sessionId: s.id })
    await m.disposeAll()
    // The tool's record has that call too, then work went on in the terminal with a call of its own
    a.toolHistory.push(
      { role: 'assistant', text: 'Let me look' },
      recorded(toolCall('tu1', 'ls')),
      recorded(toolResult('tu1', 'a.txt')),
      { role: 'user', text: 'said in the terminal' },
      recorded(toolCall('tu2', 'pwd')),
      recorded(toolResult('tu2', '/work')),
      { role: 'assistant', text: 'a terminal answer' },
    )
    await m.resumeSession(s.id)
    const stored = (await call('messages.load', { sessionId: s.id, limit: 200 })) as StoredMessage[]
    expect(stored.map((r) => (r.kind === 'text' ? (r.payload as { text: string }).text : `${r.kind}:${(r.payload as { callId: string }).callId}`))).toEqual([
      'List the files', 'Let me look', 'tool_call:tu1', 'tool_result:tu1',
      'said in the terminal', 'tool_call:tu2', 'tool_result:tu2', 'a terminal answer',
    ])
  })

  /*
   * The stretch of events after our last message need not match the record's order, nor start with one we hold
   * (#843 review): every event our record holds there is skipped, wherever it stands, and only the others are stored.
   */
  const label = (r: StoredMessage) =>
    r.kind === 'text' ? (r.payload as { text: string }).text : r.kind === 'marker' ? `[${(r.payload as { type: string }).type}]` : `${r.kind}:${(r.payload as { callId: string }).callId}`
  const catchUp = async (live: NormalizedEvent[], outside: HistoryMessage[]) => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    a.toolHistory = [{ role: 'user', text: 'List the files' }]
    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })) as { id: string }
    a.last!.emitEvent({ type: 'message_delta', sessionId: s.id, role: 'assistant', text: 'Let me look' })
    for (const e of live) a.last!.emitEvent({ ...e, sessionId: s.id } as NormalizedEvent)
    await m.disposeAll()
    a.toolHistory.push({ role: 'assistant', text: 'Let me look' }, ...outside)
    await m.resumeSession(s.id)
    return ((await call('messages.load', { sessionId: s.id, limit: 200 })) as StoredMessage[]).map(label)
  }

  it('parallel calls the host saw start, listed by the record each with its result, are stored once', async () => {
    // Live, both calls started before the host went away; the thread lists each call with its result
    const rows = await catchUp(
      [toolCall('tc1', 'a'), toolCall('tc2', 'b')],
      [recorded(toolCall('tc1', 'a')), recorded(toolResult('tc1', 'A')), recorded(toolCall('tc2', 'b')), recorded(toolResult('tc2', 'B')), { role: 'assistant', text: 'done' }],
    )
    expect(rows).toEqual(['List the files', 'Let me look', 'tool_call:tc1', 'tool_call:tc2', 'tool_result:tc1', 'tool_result:tc2', 'done'])
  })

  it('parallel calls that finished in another order live than the record lists them are stored once', async () => {
    const rows = await catchUp(
      [toolCall('tc1', 'a'), toolCall('tc2', 'b'), toolResult('tc2', 'B'), toolResult('tc1', 'A')],
      [recorded(toolCall('tc1', 'a')), recorded(toolResult('tc1', 'A')), recorded(toolCall('tc2', 'b')), recorded(toolResult('tc2', 'B')), { role: 'assistant', text: 'done' }],
    )
    expect(rows).toEqual(['List the files', 'Let me look', 'tool_call:tc1', 'tool_call:tc2', 'tool_result:tc2', 'tool_result:tc1', 'done'])
  })

  it('an event our record lacks, first in the stretch, is stored, and the ones after it we hold are not', async () => {
    const rows = await catchUp(
      [toolCall('tc2', 'b'), toolResult('tc2', 'B')],
      [recorded(toolCall('tc0', 'z')), recorded(toolResult('tc0', 'Z')), recorded(toolCall('tc2', 'b')), recorded(toolResult('tc2', 'B'))],
    )
    expect(rows).toEqual(['List the files', 'Let me look', 'tool_call:tc2', 'tool_result:tc2', 'tool_call:tc0', 'tool_result:tc0'])
  })

  it("a background agent's launch, whose result the record has right after it and live never sent, is not stored twice", async () => {
    const agent: HistoryEvent = { type: 'tool_call', sessionId: '', callId: 'tu9', summary: { tool: 'Agent', title: 'Review', paths: [] } }
    const rows = await catchUp(
      [agent, toolCall('tu10', 'ls'), toolResult('tu10', 'a.txt')],
      [recorded(agent), recorded(toolResult('tu9', 'launched')), recorded(toolCall('tu10', 'ls')), recorded(toolResult('tu10', 'a.txt'))],
    )
    expect(rows).toEqual(['List the files', 'Let me look', 'tool_call:tu9', 'tool_call:tu10', 'tool_result:tu10', 'tool_result:tu9'])
  })

  it('rows an older host stored (a compaction, the interrupted command not kept) get no second compaction marker', async () => {
    const rows = await catchUp(
      [{ type: 'compaction', sessionId: '', failed: false }],
      [recorded(toolCall('tc1', 'sleep 100')), compaction, { role: 'assistant', text: 'after' }],
    )
    expect(rows).toEqual(['List the files', 'Let me look', '[compaction]', 'tool_call:tc1', 'after'])
  })

  /*
   * #1618 review, seen with real Claude Code: an update cut a turn, Centralu continued it with its note through its own
   * channel (`deliverMail`: a notice line, no row of the note's words), the continued turn made calls, and the host
   * stopped. At the next wake the record has, after our last words, the CLI's "No response requested." where it resumed
   * the cut turn, then the note, then the calls we hold. Anchored on the words, the note was stored as the person's
   * message and every call after it a second time.
   */
  const continuedTurn = async (note: HistoryMessage) => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    a.toolHistory = [{ role: 'user', text: 'Make ten Bash calls', sent: true }]
    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })) as { id: string }
    const live: NormalizedEvent[] = [
      toolCall('tc1', 'sleep 6'), toolResult('tc1', ''),
      // What `deliverMail` leaves where the note went in
      { type: 'notice', sessionId: '', level: 'info', from: 'Centralu', label: 'update', text: 'Centralu was updated during this turn' },
      toolCall('tc2', 'sleep 6'), toolResult('tc2', ''), toolCall('tc3', 'sleep 6'),
    ]
    for (const e of live) a.last!.emitEvent({ ...e, sessionId: s.id })
    await m.disposeAll()
    a.toolHistory.push(
      recorded(toolCall('tc1', 'sleep 6')), recorded(toolResult('tc1', '')),
      { role: 'assistant', text: 'No response requested.' },
      note,
      recorded(toolCall('tc2', 'sleep 6')), recorded(toolResult('tc2', '')), recorded(toolCall('tc3', 'sleep 6')),
    )
    await m.resumeSession(s.id)
    return ((await call('messages.load', { sessionId: s.id, limit: 200 })) as StoredMessage[]).map(label)
  }
  const note = '[Centralu] Centralu on this machine was updated while your turn was running. Continue where you stopped.'
  const held = ['Make ten Bash calls', 'tool_call:tc1', 'tool_result:tc1', '[notice]', 'tool_call:tc2', 'tool_result:tc2', 'tool_call:tc3']

  it("does not store Centralu's own note, known by the id it wrote it under, as the person's message, nor what followed it twice", async () => {
    expect(await continuedTurn({ role: 'user', text: note, sent: true })).toEqual(held)
  })

  it("never stores Centralu's own Continue note as the person's message, also where the tool keeps no id of Centralu's, and no call twice (#1626 review)", async () => {
    // Codex keeps no id of ours, and a reader that finds none gives the note unmarked: it is Centralu's own exact text
    expect(await continuedTurn({ role: 'user', text: UPDATE_CONTINUE_TEXT })).toEqual([...held, 'No response requested.'])
  })

  it('anchors on the last input Centralu wrote when its record holds no words at all (only mail went in)', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1' })) as { id: string }
    a.last!.emitEvent({ type: 'notice', sessionId: s.id, level: 'info', from: 'Centralu', label: 'mail', text: 'Mail went in' })
    a.last!.emitEvent({ ...toolCall('tc1', 'ls'), sessionId: s.id })
    await m.disposeAll()
    a.toolHistory = [{ role: 'user', text: '[Centralu] mail', sent: true }, recorded(toolCall('tc1', 'ls')), { role: 'user', text: 'typed in a terminal' }]
    await m.resumeSession(s.id)
    const stored = ((await call('messages.load', { sessionId: s.id, limit: 200 })) as StoredMessage[]).map(label)
    expect(stored).toEqual(['[notice]', 'tool_call:tc1', 'typed in a terminal'])
  })

  it('does not append when the last message we know cannot be found (better than piling up a duplicate)', async () => {
    const { a, m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    a.toolHistory = [{ role: 'user', text: 'First question' }]
    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })) as { id: string }

    // Bring down only the process (the same state as a host restart)
    await m.disposeAll()
    // The tool's whole history changed (e.g. the earlier part was lost to compaction).
    a.toolHistory = [{ role: 'user', text: 'a completely different conversation' }]
    await m.resumeSession(s.id)

    expect(await texts(call, s.id)).toEqual(['First question'])
  })
})

/**
 * Catch-up for a session whose cwd differs from the project path (M4 P-6).
 *
 * The wake-up catch-up looked for history by **the project path**. The list lookup in the same
 * function was already asking by the session's actual cwd (`cwdFor`), but the line that reads
 * history alone used a different key. Measured against the installed SDK (0.3.263): asking by
 * the project path gets a worktree session 2 hits (found via the SDK extra described at
 * `CwdFiledAdapter` in manager.test-helpers.ts), and a session born in a folder that is not a
 * worktree of that repository gets **0 hits**. In M4, the cwd of a
 * session that creates a user-folder app is exactly that kind of folder — whatever was continued
 * in the terminal never reaches the screen.
 */
describe('catches up a session even when its cwd differs from the project path (M4 P-6)', () => {
  it("a session born in a folder outside the project catches up from that folder's history", async () => {
    const a = new CwdFiledAdapter()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    const call = createRpcHandler(m, adapters)
    const projectDir = mkdtempSync(join(tmpdir(), 'cc-p6-project-'))
    const appDir = mkdtempSync(join(tmpdir(), 'cc-p6-app-'))
    try {
      const p = (await call('projects.add', { path: projectDir })) as { id: string }
      const s = (await call('agents.createSession', { projectId: p.id, cwd: appDir, tool: 'claude' })) as { id: string }
      await m.disposeAll() // put to sleep (the same state as a host restart)

      // The conversation continued in the terminal in the meantime — the record piled up under the folder the
      // session was born in.
      a.toolHistory = [
        { role: 'user', text: 'something said in the terminal' },
        { role: 'assistant', text: 'a terminal answer' },
      ]
      await m.resumeSession(s.id)

      const texts = ((await call('messages.load', { sessionId: s.id, limit: 200 })) as { payload: { text?: string } }[])
        .map((r) => r.payload.text)
        .filter(Boolean)
      expect(texts).toEqual(['something said in the terminal', 'a terminal answer'])
      expect(events.some((e) => e.type === 'history_synced' && e.sessionId === s.id)).toBe(true)
      // Where it found it is exactly where it asked — it never once asked the project path.
      expect(a.readFrom).toEqual([appDir])
    } finally {
      rmSync(projectDir, { recursive: true, force: true })
      rmSync(appDir, { recursive: true, force: true })
    }
  })
})

/**
 * Claude gives the external id via system/init, **asynchronously**.
 * So refreshing right after creating a session and before saying anything finds it still absent
 * (dogfooding: "Could not load the session identifier").
 */
/**
 * When the tool **hangs** while starting, that fact has to come back as the reason (the real
 * resume incident).
 *
 * Waiting with no cap means the outer RPC gives up at 30s with "RPC timed out," while the
 * manager's in-progress (resuming) promise stays unresolved, so Retry **rejoined that same stuck
 * promise** — the screen shows a Retry button, but nothing actually retries. Now it fails at 25s
 * with a named stage, and the instant it fails resuming resolves, so Retry becomes a real retry.
 */
describe('when resuming hangs', () => {
  it('a hung spawn fails with a named stage, and Retry starts fresh', async () => {
    const s = await rpc('agents.createSession', { projectId: (await addProject()).id, cwd: tmpdir(), tool: 'claude' }) as { id: string }
    // Bring down only the process (the same state as a host restart) — this used to be produced by
    // archive/restore.
    await mgr.disposeAll()

    vi.useFakeTimers()
    try {
      adapter.hangCreate = true
      const attempt = mgr.resumeSession(s.id)
      await vi.advanceTimersByTimeAsync(150_100)
      const r = await attempt
      expect(r.resumed).toBe(false)
      expect(r.reason).toMatch(/Starting claude did not finish within 150s/)

      // Retry does not join the stuck promise — it starts fresh, and this time the spawn succeeds normally.
      adapter.hangCreate = false
      const retry = mgr.resumeSession(s.id)
      await vi.advanceTimersByTimeAsync(1)
      expect((await retry).resumed).toBe(true)

      // If the hung spawn arrives late, the manager reaps it — otherwise a process holding a thread leaks.
      adapter.resolveLate!()
      await vi.advanceTimersByTimeAsync(1)
      await Promise.resolve()
      expect(adapter.lateHandle!.disposed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('when the resume identifier does not exist yet', () => {
  class LateIdAdapter extends FakeAdapter {
    override async createSession(opts: CreateSessionOpts, emit: EventSink) {
      const h = await super.createSession(opts, emit)
      h.externalId = null // has not arrived yet
      return h
    }
  }
  const setup = () => {
    const a = new LateIdAdapter()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    return { a, m, call: createRpcHandler(m, adapters) }
  }

  it('just starts fresh when nothing has been said yet (there is nothing to lose)', async () => {
    const { m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as {
      id: string
    }

    const r = (await call('agents.restartSession', { sessionId: s.id })) as { resumed: boolean }
    expect(r.resumed).toBe(true)
    expect(m.isLive(s.id)).toBe(true)
  })

  it('states the reason when there is a record but no identifier', async () => {
    const { m, call } = setup()
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as {
      id: string
    }
    await call('agents.send', { sessionId: s.id, text: 'leftover words' })

    const r = (await m.restartSession(s.id)) as { resumed: boolean; reason?: string }
    expect(r.resumed).toBe(false)
    expect(r.reason).toMatch(/Lost this session's resume id/)
  })
})

/**
 * A session that was only loaded and never given a message never gets its external_id filled in
 * (because Claude delivers that value via system/init, asynchronously). But by definition such a
 * session has **the original it was resumed from** — that is what it should continue from.
 * Measured: there were sessions with ext=null . from=c1a50932 . 95 messages.
 */
describe('resumes from the original it was imported from when there is no identifier', () => {
  class NoIdAdapter extends FakeAdapter {
    resumedWith: string | undefined
    override async createSession(opts: CreateSessionOpts, emit: EventSink) {
      this.resumedWith = opts.resumeExternalId
      const h = await super.createSession(opts, emit)
      h.externalId = null // has not arrived yet (arrives once a message is sent)
      return h
    }
    async listExternalSessions() {
      return [{ externalId: 'ext-origin', title: 'Original', updatedAt: 1 }]
    }
    async readExternalHistory() {
      return [{ role: 'user' as const, text: 'loaded conversation' }]
    }
  }

  it('continues via importedFrom even without an external_id', async () => {
    const a = new NoIdAdapter()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    const call = createRpcHandler(m, adapters)
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }

    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude',
      resumeExternalId: 'ext-origin', importHistory: true,
    })) as { id: string }

    // The state where the loaded history exists but the identifier is empty (the state actually measured).
    expect(m.listSessions().find((x) => x.id === s.id)!.externalId).toBeNull()
    expect((await call('messages.load', { sessionId: s.id, limit: 10 })) as unknown[]).not.toHaveLength(0)

    // Bring down only the process (the same state as a host restart)
    await m.disposeAll()
    a.resumedWith = undefined

    const r = await m.resumeSession(s.id)

    expect(r.resumed).toBe(true)
    expect(a.resumedWith).toBe('ext-origin') // Resumed from the original.
  })
})

/**
 * When a message arrives at a sleeping session **twice at once** (a common combination: the
 * person + the orchestrator), both saw "no process" and each revived it separately — two
 * processes started, and the one that started first got pushed out of the handle map and
 * orphaned forever, with no dispose ever called (TOCTOU).
 */
describe('resuming happens once even with simultaneous messages', () => {
  class SlowAdapter extends FakeAdapter {
    creations = 0
    override async createSession(opts: CreateSessionOpts, emit: EventSink) {
      this.creations++
      // A real adapter takes time for the process to start — the race happens in that window.
      await new Promise((r) => setTimeout(r, 20))
      return super.createSession(opts, emit)
    }
  }

  it('two sends wait on the same resume — only one process starts', async () => {
    const a = new SlowAdapter()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    const call = createRpcHandler(m, adapters)
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    const s = (await call('agents.createSession', { projectId: p.id, cwd: tmpdir(), tool: 'claude' })) as { id: string }
    // Bring down only the process (the same state as a host restart)
    await m.disposeAll()
    a.creations = 0

    await Promise.all([
      call('agents.send', { sessionId: s.id, text: 'words from the person' }),
      call('agents.send', { sessionId: s.id, text: 'words from the orchestrator' }),
    ])

    expect(a.creations).toBe(1)
    expect(a.handleOf(s.id)!.sent).toEqual(expect.arrayContaining(['words from the person', 'words from the orchestrator']))
  })
})

/**
 * Catching up on a conversation continued outside (in the terminal) — from **history that
 * accumulated as streaming**. Because a stored row is a delta chunk, comparing the last row
 * against the complete message would never match, so catch-up always found 0 hits (a silent
 * failure).
 */
describe('catches up even from history accumulated as deltas', () => {
  class SyncAdapter2 extends FakeAdapter {
    toolHistory: { role: 'user' | 'assistant'; text: string }[] = []
    async listExternalSessions() {
      return [{ externalId: 'ext-1', title: 'Conversation', updatedAt: 1 }]
    }
    async readExternalHistory() {
      return this.toolHistory
    }
  }

  it('reassembles the last response from its chunks to match, and appends only what follows', async () => {
    const a = new SyncAdapter2()
    const adapters = new Map<ToolName, AgentAdapter>([['claude', a]])
    const m = new SessionManager(store, adapters, (e) => events.push(e))
    const call = createRpcHandler(m, adapters)
    const p = (await call('projects.add', { path: tmpdir() })) as { id: string }
    a.toolHistory = [{ role: 'user', text: 'Question' }]
    const s = (await call('agents.createSession', {
      projectId: p.id, cwd: tmpdir(), tool: 'claude', resumeExternalId: 'ext-1', importHistory: true,
    })) as { id: string }

    // The response streams in as chunks — storage merges it into one row (#66).
    const h = a.handleOf(s.id)!
    h.emitDelta('the first half ')
    h.emitDelta('and second half of the answer')
    // In the tool's history, the same response remains as **one complete message**.
    a.toolHistory.push({ role: 'assistant', text: 'the first half and second half of the answer' })

    // Bring down only the process (the same state as a host restart)
    await m.disposeAll()
    // Work continued in the terminal in the meantime.
    a.toolHistory.push({ role: 'user', text: 'something said in the terminal' }, { role: 'assistant', text: 'a terminal answer' })

    await m.resumeSession(s.id)

    const texts = ((await call('messages.load', { sessionId: s.id, limit: 200 })) as { payload: { text?: string } }[])
      .map((r) => r.payload.text)
      .filter(Boolean)
    // Only the tail is appended, without duplication — neither 0 hits (not found) nor a full duplicate.
    // The two streaming chunks are already one row in storage (#66)
    expect(texts).toEqual(['Question', 'the first half and second half of the answer', 'something said in the terminal', 'a terminal answer'])
    expect(events.some((e) => e.type === 'history_synced' && e.added === 2)).toBe(true)
  })
})

/**
 * Remembers the directory a session was created in (issue #28).
 *
 * The tool files a conversation under the working directory it was started in, and looks for it
 * there and nowhere else. Deriving that directory again on every start is therefore a promise
 * we cannot keep: rename the data folder, move a project, and a live session is suddenly
 * pointed at a place its history was never written to. That happened — the orchestrator's cwd
 * followed a data-directory rename, the tool answered "not found", and the app reported a
 * deletion while an 821KB transcript sat untouched under the old path.
 */
describe('resuming returns to where it was created', () => {
  it('launches in the directory the session started in, even if the project path changed', async () => {
    const startedIn = mkdtempSync(join(tmpdir(), 'cc-cwd-'))
    const p = (await rpc('projects.add', { path: tmpdir() })) as { id: string; path: string }
    // The session starts somewhere other than the project's path — which is what a rename
    // leaves behind: the derived answer and the real one stop agreeing.
    const s = (await rpc('agents.createSession', { projectId: p.id, cwd: startedIn, tool: 'claude' })) as SessionInfo

    // Restart the host — checks whether it reads the stored fact, not something left in memory.
    const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
    const restarted = new SessionManager(store, adapters, () => {})
    adapter.lastCwd = null

    await createRpcHandler(restarted, adapters)('agents.resumeSession', { sessionId: s.id })

    expect(adapter.lastCwd).toBe(startedIn)
    // Falling back to the project path would have the tool search a place with no record, and the answer
    // would be "not found."
    expect(adapter.lastCwd).not.toBe(p.path)
    rmSync(startedIn, { recursive: true, force: true })
  })

  /*
   * Rows created before v14 have no stored path — the migration deliberately leaves the
   * orchestrator NULL rather than touching the user's home. The first time we need the path we
   * derive it once and write it down, so the next rename cannot move it either.
   */
  it('an old session is decided once the first time it is needed, and is a fact from then on', async () => {
    const p = (await rpc('projects.add', { path: tmpdir() })) as { id: string; path: string }
    // Exactly how every pre-v14 row was written: upsertSession does not carry a cwd, so the
    // column is NULL — the same state the migration leaves the orchestrator in.
    store.sessions.upsertSession({
      id: 'old', projectId: p.id, kind: 'worker', tool: 'claude', externalId: 'ext-1', name: 'Old session',
      autoNamed: false, state: 'idle', lastReadSeq: 0, lastSeq: 0,
      createdAt: 1, waitingSince: null, live: false, model: null, effort: null, verbosity: null, serviceTier: null,
      permissionPreset: 'normal', importedFrom: null, worktree: null, parentSessionId: null, scopeSessionIds: null, roleAppend: null, appId: null, ...sessionLiveDefaults(),
    })
    expect(store.sessions.sessionCwd('old')).toBeNull()

    const adapters = new Map<ToolName, AgentAdapter>([['claude', adapter]])
    await new SessionManager(store, adapters, () => {}).resumeSession('old')

    expect(store.sessions.sessionCwd('old')).toBe(p.path)
  })
})
