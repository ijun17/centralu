import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HistoryMessage, CentraluTools } from '../adapters/contract.js'
import type { PermissionPreset } from '@cc/protocol'
import { CrossAdapter, crossWorld, type CrossWorld } from './cross-project.test-helpers.js'

/**
 * Requests to a busy session (#677): when B asks A for work while A runs a turn that is not B's, the request goes to A as
 * mail (docs/plans/mailbox.md §10.6.2), unless B passes `ifBusy` "fork" or "fork_read": a fork is a sub-session from a copy
 * of A's conversation, linked to B, under A in the sidebar, in a worktree of its own when the work may edit files.
 */

describe('requests to a busy session (#677)', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    await w.dispose()
  })

  const claude = () => w.adapters.get('claude')!
  const handleOf = (id: string) => claude().handles.get(id)!
  const session = async (preset: PermissionPreset = 'normal') =>
    (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: preset })).id
  const info = (id: string) => w.mgr.listSessions().find((s) => s.id === id)!
  /** B with a child A it started, which the person is now using for a turn of their own */
  const busyChild = async (preset: PermissionPreset = 'normal') => {
    w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
    const b = await session(preset)
    const started = await w.mgr.startAgent(b, { task: 'first job', wait: false })
    if (!started.ok) throw new Error(started.error)
    const a = started.sessionId
    // A has a conversation of its own to copy
    handleOf(a).externalId = 'ext-a'
    handleOf(a).answer('first job done')
    await w.mgr.agentSession(b, { sessionId: a, action: 'wait' })
    await w.mgr.inputs.send(a, "the person's own work")
    return { a, b }
  }

  describe('a fork', () => {
    /** The fake CLI copies a conversation the way Claude's forkSession and Codex's thread/fork do: a new id, the same history */
    const forks: { from: string; cwd: string; to: string }[] = []
    const history = new Map<string, HistoryMessage[]>()
    beforeEach(() => {
      forks.length = 0
      const fake = claude() as CrossAdapter & {
        forkConversation?: (id: string, cwd: string) => Promise<string>
        readExternalHistory?: (id: string) => Promise<HistoryMessage[]>
      }
      history.set('ext-a', [{ role: 'user', text: 'first job' }, { role: 'assistant', text: 'first job done' }])
      fake.forkConversation = async (id, cwd) => {
        const to = `fork-of-${id}-${forks.length}`
        forks.push({ from: id, cwd, to })
        history.set(to, [...(history.get(id) ?? [])])
        return to
      }
      fake.readExternalHistory = async (id) => history.get(id) ?? []
    })

    const git = (cwd: string) => {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd })
      writeFileSync(join(cwd, 'README.md'), 'x')
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.'], { cwd })
      execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init'], { cwd })
    }

    it('starts from a copy of the busy session\'s conversation, in a worktree of its own, linked to the requester', async () => {
      git(w.caller.path)
      const { a, b } = await busyChild()
      const forking = w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'review the schema', ifBusy: 'fork' })
      await w.until(() => w.mgr.listSessions().some((s) => s.forkedFrom === a))
      const fork = w.mgr.listSessions().find((s) => s.forkedFrom === a)!
      // The copy is of A's conversation, taken from the folder A runs in; the original is left running
      expect(forks).toEqual([{ from: 'ext-a', cwd: w.caller.path, to: 'fork-of-ext-a-0' }])
      expect(handleOf(fork.id).opts.resumeExternalId).toBe('fork-of-ext-a-0')
      expect(w.store.messages.loadMessages(fork.id, 50).map((m) => (m.payload as { text?: string }).text)).toEqual(
        expect.arrayContaining(['first job', 'first job done']),
      )
      expect(info(a).state).toBe('working')
      // Its own folder: two agents never write one
      expect(fork.worktree).toBeTruthy()
      expect(handleOf(fork.id).opts.cwd).not.toBe(w.caller.path)
      expect(fork).toMatchObject({ askedBy: b, forkedFrom: a, permissionPreset: 'normal' })
      await w.until(() => handleOf(fork.id).sent.length === 1)
      expect(handleOf(fork.id).sent[0]).toContain('review the schema')
      // B owns the fork's turn: its answer comes back to B
      handleOf(fork.id).answer('schema reviewed')
      expect(await forking).toMatchObject({ ok: true, state: 'done', sessionId: fork.id, via: 'fork', forkedFrom: a, answer: 'schema reviewed' })
    })

    it('fork_read shares the busy session\'s folder under at most safe, and its turn reports to the requester', async () => {
      const { a, b } = await busyChild()
      const orch = await w.mgr.assistant()
      w.mgr.setProjectTrusted(w.caller.id, true)
      const tools = (w.mgr as unknown as { centraluToolsFor(id: string): CentraluTools }).centraluToolsFor(orch.id)
      const r = await tools.sendToSession(a, 'read the logs', false, 'fork_read')
      expect(r).toMatchObject({ ok: true, busy: { state: 'forked', forkedFrom: a } })
      const forkId = r.busy?.state === 'forked' ? r.busy.sessionId : ''
      expect(info(forkId)).toMatchObject({ forkedFrom: a, permissionPreset: 'safe', worktree: null })
      expect(handleOf(forkId).opts.cwd).toBe(w.caller.path)
      // Its question goes to the Assistant, which gave it the turn (#676)
      handleOf(forkId).event({ type: 'question_request', sessionId: forkId, requestId: 'q-f', questions: [{ question: 'Which log?', header: '', options: [], multiSelect: false }] })
      await w.until(() => w.store.messages.loadMessages(orch.id, 20).some((m) => JSON.stringify(m.payload).includes('asking a question')))
      expect(await tools.readSession(forkId)).toMatchObject({ cards: [{ requestId: 'q-f', kind: 'question' }] })
      handleOf(forkId).event({ type: 'question_resolved', sessionId: forkId, requestId: 'q-f' })
      // The Assistant is told when the fork's turn ends, as for any work it does not wait on
      handleOf(forkId).answer('logs read')
      await w.until(() => w.store.messages.loadMessages(orch.id, 20).some((m) => JSON.stringify(m.payload).includes('The session ended its turn')))
      void b
    })

    it('is refused by a CLI that cannot fork', async () => {
      const { a, b } = await busyChild()
      delete (claude() as { forkConversation?: unknown }).forkConversation
      expect(await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'x', ifBusy: 'fork' })).toMatchObject({ ok: false, error: expect.stringContaining('cannot fork') })
      expect(w.mgr.listSessions().filter((s) => s.forkedFrom)).toEqual([])
    })

    it('follows start_agent\'s gates: an untrusted project, or the per-project ceiling, refuses it', async () => {
      const { a, b } = await busyChild()
      w.mgr.setProjectTrusted(w.caller.id, false)
      expect(await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'x', ifBusy: 'fork_read' })).toMatchObject({ ok: false, error: expect.stringContaining('not trusted') })
      w.mgr.setProjectTrusted(w.caller.id, true)
      w.mgr.prefs.setUiPreferences({ agentCeiling: 1 })
      // B's earlier child is at rest; one running child fills a ceiling of one
      const runner = await w.mgr.startAgent(b, { task: 'keep busy', wait: false })
      expect(runner).toMatchObject({ ok: true })
      expect(await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'x', ifBusy: 'fork_read' })).toMatchObject({ ok: false, error: expect.stringContaining('already working') })
      expect(w.mgr.listSessions().filter((s) => s.forkedFrom)).toEqual([])
    })

    it('under auto, forks in an untrusted project and logs that crossing once (#2159)', async () => {
      const { a, b } = await busyChild('auto')
      await w.mgr.setProjectTrusted(w.caller.id, false)
      const log = vi.spyOn(console, 'error').mockImplementation(() => {})
      const forking = w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'read it', ifBusy: 'fork_read' })
      await w.until(() => w.mgr.listSessions().some((s) => s.forkedFrom === a))
      const fork = w.mgr.listSessions().find((s) => s.forkedFrom === a)!
      await w.until(() => handleOf(fork.id).sent.length === 1)
      handleOf(fork.id).answer('read')
      expect(await forking).toMatchObject({ ok: true, via: 'fork', forkedFrom: a })
      const crossed = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('forking a session'))
      expect(crossed).toEqual([`[permissions] auto session ${b}: forking a session (untrusted project "${w.caller.name}") allowed`])
    })

    /*
     * A fork starts an agent, so it keeps to the agent depth (#867) under every preset, auto included: the requester B is
     * itself a child here, and A is B's child the person is using.
     */
    it('follows the agent depth: a requester at it is refused fork and fork_read under auto, and allowed once it is raised', async () => {
      w.store.permissions.setProjectConsent(w.caller.id, w.caller.id, 'agents')
      w.mgr.prefs.setUiPreferences({ agentDepth: 2 })
      const top = await session('auto')
      const middle = await w.mgr.startAgent(top, { task: 'middle job', wait: false })
      if (!middle.ok) throw new Error(middle.error)
      const b = middle.sessionId
      const inner = await w.mgr.startAgent(b, { task: 'first job', wait: false })
      if (!inner.ok) throw new Error(inner.error)
      const a = inner.sessionId
      handleOf(a).externalId = 'ext-a'
      handleOf(a).answer('first job done')
      await w.mgr.agentSession(b, { sessionId: a, action: 'wait' })
      await w.mgr.inputs.send(a, "the person's own work")

      w.mgr.prefs.setUiPreferences({ agentDepth: 1 })
      const setting = 'How deep agents may start agents'
      for (const ifBusy of ['fork', 'fork_read'] as const) {
        expect(await w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'x', ifBusy })).toMatchObject({
          ok: false,
          error: expect.stringContaining(`No fork of "${info(a).name}": this session is 1 level below a session the person started, and "${setting}"`),
        })
      }
      expect(w.mgr.listSessions().filter((s) => s.forkedFrom)).toEqual([])

      w.mgr.prefs.setUiPreferences({ agentDepth: 2 })
      const forking = w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'read it', ifBusy: 'fork_read' })
      await w.until(() => w.mgr.listSessions().some((s) => s.forkedFrom === a))
      const fork = w.mgr.listSessions().find((s) => s.forkedFrom === a)!
      await w.until(() => handleOf(fork.id).sent.length === 1)
      handleOf(fork.id).answer('read')
      expect(await forking).toMatchObject({ ok: true, via: 'fork', forkedFrom: a })
      // The fork is two levels down, and keeps that when B is deleted
      w.mgr.prefs.setUiPreferences({ agentDepth: 3 })
      await w.mgr.trash.trashSession(b)
      expect(await w.mgr.startAgent(fork.id, { task: 'deeper', wait: false })).toMatchObject({ ok: true })
      w.mgr.prefs.setUiPreferences({ agentDepth: 2 })
      expect(await w.mgr.startAgent(fork.id, { task: 'deeper still', wait: false })).toMatchObject({ ok: false, error: expect.stringContaining('2 levels below') })
    })

    it("withdraws a fork's card when the project loses trust, and makes no fork", async () => {
      const { a, b } = await busyChild('safe')
      // A safe requester with no remembered consent gets the card
      w.mgr.consents.revokeProjectConsent(w.caller.id, w.caller.id, 'agents')
      const forking = w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'x', ifBusy: 'fork_read' })
      await w.until(() => info(b).pendingApproval?.detail.kind === 'agent_start')
      void w.mgr.setProjectTrusted(w.caller.id, false)
      expect(info(b).pendingApproval).toBeFalsy()
      expect(await forking).toMatchObject({ ok: false, error: expect.stringContaining('not trusted') })
      expect(forks).toEqual([])
      expect(w.mgr.listSessions().filter((s) => s.forkedFrom)).toEqual([])
    })

    it("refuses an approval of a fork's card that comes after the project's trust is gone", async () => {
      const { a, b } = await busyChild('safe')
      w.mgr.consents.revokeProjectConsent(w.caller.id, w.caller.id, 'agents')
      const forking = w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'x', ifBusy: 'fork_read' })
      await w.until(() => info(b).pendingApproval?.detail.kind === 'agent_start')
      // Taken away at the store, so only the read after the answer can see it
      w.store.projects.setProjectTrusted(w.caller.id, false)
      w.mgr.inputs.respondApproval(b, info(b).pendingApproval!.requestId, 'allow')
      expect(await forking).toMatchObject({ ok: false, error: expect.stringContaining('not trusted') })
      expect(forks).toEqual([])
      expect(w.mgr.listSessions().filter((s) => s.forkedFrom)).toEqual([])
    })

    /** The fake CLI's copy waits until the test lets it finish, so something can change while the fork is being made */
    const slowCopy = () => {
      const fake = claude() as CrossAdapter & { forkConversation?: (id: string, cwd: string) => Promise<string> }
      const copy = fake.forkConversation!
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      const state = { started: false, release: () => release() }
      fake.forkConversation = async (id, cwd) => {
        state.started = true
        await gate
        return copy(id, cwd)
      }
      return state
    }
    const taskReached = (words: string) => [...claude().handles.values()].filter((h) => h.sent.some((t) => t.includes(words)))

    it('starts a fork at the requester\'s preset as it is when the fork is made, lowered while the copy was taken', async () => {
      git(w.caller.path)
      const { a, b } = await busyChild()
      const copy = slowCopy()
      const forking = w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'review it', ifBusy: 'fork' })
      await w.until(() => copy.started)
      // Asked for at normal, the lower of the two presets then; the requester is safe by the time the fork starts
      await w.mgr.updateSettings(b, { permissionPreset: 'safe' })
      copy.release()
      await w.until(() => taskReached('review it').length === 1)
      const fork = w.mgr.listSessions().find((s) => s.forkedFrom === a)!
      expect(fork.permissionPreset).toBe('safe')
      expect(handleOf(fork.id).opts.permissionPreset).toBe('safe')
      handleOf(fork.id).answer('reviewed')
      expect(await forking).toMatchObject({ ok: true, answer: 'reviewed' })
    })

    it('gives no task to a fork whose requester was lowered below it while its session was being made', async () => {
      git(w.caller.path)
      const { a, b } = await busyChild()
      const make = w.mgr.createSession.bind(w.mgr)
      let release!: () => void
      const gate = new Promise<void>((r) => (release = r))
      let making = false
      vi.spyOn(w.mgr, 'createSession').mockImplementation(async (...args) => {
        making = true
        await gate
        return make(...args)
      })
      const forking = w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'review it', ifBusy: 'fork' })
      await w.until(() => making)
      // The session is being made at normal; the requester is now safe
      await w.mgr.updateSettings(b, { permissionPreset: 'safe' })
      release()
      expect(await forking).toMatchObject({ ok: false, error: expect.stringContaining('lowered to safe') })
      expect(await forking).toMatchObject({ ok: false, error: expect.stringContaining('archived') })
      expect(w.mgr.listSessions().filter((s) => s.forkedFrom)).toEqual([])
      expect(taskReached('review it')).toEqual([])
    })

    it("gives no task to a fork whose project lost trust while it was being made", async () => {
      const { a, b } = await busyChild()
      const copy = slowCopy()
      const forking = w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'read it', ifBusy: 'fork_read' })
      await w.until(() => copy.started)
      w.store.projects.setProjectTrusted(w.caller.id, false)
      copy.release()
      expect(await forking).toMatchObject({ ok: false, error: expect.stringContaining('not trusted') })
      expect(w.mgr.listSessions().filter((s) => s.forkedFrom)).toEqual([])
      expect(taskReached('read it')).toEqual([])
    })

    it('two forks at once take one place under a ceiling of one', async () => {
      const { a, b } = await busyChild()
      w.mgr.prefs.setUiPreferences({ agentCeiling: 1 })
      const calls = [
        w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'one', ifBusy: 'fork_read' }),
        w.mgr.agentSession(b, { sessionId: a, action: 'send', text: 'two', ifBusy: 'fork_read' }),
      ]
      // One call is refused at once; the other's fork takes its task and waits for its answer
      let settled = 0
      for (const c of calls) void c.then(() => settled++)
      await w.until(() => settled === 1 && w.mgr.listSessions().some((s) => s.forkedFrom === a && (claude().handles.get(s.id)?.sent.length ?? 0) > 0))
      const made = w.mgr.listSessions().filter((s) => s.forkedFrom)
      expect(made).toHaveLength(1)
      handleOf(made[0]!.id).answer('done')
      const results = await Promise.all(calls)
      expect(results.filter((r) => !r.ok && r.error.includes('already working'))).toHaveLength(1)
      expect(results.filter((r) => r.ok)).toHaveLength(1)
    })
  })
})
