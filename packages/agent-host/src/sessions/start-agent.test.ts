import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PermissionPreset } from '@cc/protocol'
import { AGENT_TOOLS, runOrchestratorTool } from './orchestrator-tools.js'
import { ASK_WAIT_MS } from './ask-project.js'
import { CrossAdapter, crossWorld, type CrossWorld } from './cross-project.test-helpers.js'
import { AGENT_CEILING, agentBranch, presetWithin } from './start-agent.js'

/**
 * start_agent and agent_session (#561): an ordinary session starts another agent in its own project — behind the
 * person's consent, never with more permissions than its own, one level deep, a few at a time — and works only with
 * the children it started.
 */

describe('the preset rule', () => {
  it('a child may have the parent\'s preset or less, never more', () => {
    const order: PermissionPreset[] = ['safe', 'normal', 'auto']
    for (const [i, parent] of order.entries()) {
      for (const [j, child] of order.entries()) expect(presetWithin(child, parent)).toBe(j <= i)
    }
  })
})

describe('the branch named from a job (part 2)', () => {
  it('is a slug of the job under the prefix, with a few characters of the id; an empty slug is "agent"', () => {
    expect(agentBranch('Write the parser!', '1A2b-3c')).toBe('centralu/write-the-parser-1a2b')
    expect(agentBranch('파서를 써 줘', 'abcd')).toBe('centralu/agent-abcd')
    expect(agentBranch('a'.repeat(80), 'abcd')).toBe(`centralu/${'a'.repeat(40)}-abcd`)
    expect(agentBranch('fix: the --flag handling ', 'abcd')).toBe('centralu/fix-the-flag-handling-abcd')
  })
})

describe('starting another agent in the same project', () => {
  let w: CrossWorld
  beforeEach(async () => {
    w = await crossWorld()
  })
  afterEach(async () => {
    vi.useRealTimers()
    await w.dispose()
  })

  const handleOf = (id: string) => w.adapters.get('claude')!.handles.get(id) ?? w.adapters.get('codex')!.handles.get(id)
  const childrenOf = (id: string) => w.mgr.listSessions().filter((s) => s.askedBy === id)
  const session = async (preset: PermissionPreset = 'normal') =>
    (await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: preset })).id
  const agentCard = (id: string) => {
    const p = w.mgr.listSessions().find((s) => s.id === id)?.pendingApproval
    return p?.detail.kind === 'agent_start' ? p : undefined
  }
  const allowProject = () => w.store.setProjectConsent(w.caller.id, w.caller.id, 'agents')
  /** Starts a child that keeps running, and returns its id */
  const startRunning = async (s: string, task = 'write it') => {
    const before = childrenOf(s).length
    const r = await w.mgr.startAgent(s, { task, wait: false })
    expect(r).toMatchObject({ ok: true, state: 'working' })
    await w.until(() => childrenOf(s).length === before + 1)
    return r.ok ? r.sessionId : ''
  }

  it('accepts a third registered CLI through the served schema and rejects unknown tools at call time', async () => {
    const third = new CrossAdapter('fixture-agent')
    w.adapters.set(third.tool, third)
    const s = await session()
    allowProject()
    const args = AGENT_TOOLS[0].schema.parse({ task: 'check', tool: third.tool, wait: false })
    const startAgent = (opts: Parameters<typeof w.mgr.startAgent>[1]) => w.mgr.startAgent(s, opts)
    const result = await runOrchestratorTool({ startAgent } as import('../adapters/contract.js').OrchestratorTools, 'start_agent', args, { sessionId: s, profile: 'reader' })
    expect(result.isError).not.toBe(true)
    expect(childrenOf(s)).toEqual([expect.objectContaining({ tool: third.tool })])
    expect(third.handles.size).toBe(1)

    const bad = AGENT_TOOLS[0].schema.parse({ task: 'check', tool: 'missing-cli' })
    expect(await runOrchestratorTool({ startAgent } as import('../adapters/contract.js').OrchestratorTools, 'start_agent', bad, { sessionId: s, profile: 'reader' })).toMatchObject({
      isError: true, text: 'No agent named "missing-cli" here. Installed tools: claude, codex, fixture-agent.',
    })
    expect(childrenOf(s)).toHaveLength(1)
  })

  it('asks the person first; denied, nothing is started and the model reads a refusal', async () => {
    const s = await session()
    const p = w.mgr.startAgent(s, { task: 'implement the parser', tool: 'codex' })
    await w.until(() => !!agentCard(s))
    expect(agentCard(s)!.detail).toMatchObject({ kind: 'agent_start', project: { id: w.caller.id }, tool: 'Codex', preset: 'normal', text: 'implement the parser' })
    w.mgr.respondApproval(s, agentCard(s)!.requestId, 'deny')
    const r = await p
    expect(!r.ok && r.error).toContain('did not allow')
    expect(childrenOf(s)).toEqual([])
  })

  it('opens a visible child in the same folder on the tool asked for, framed and recorded as sent by the parent, and returns its answer', async () => {
    const s = await session()
    const p = w.mgr.startAgent(s, { task: 'implement the parser', tool: 'codex' })
    await w.until(() => !!agentCard(s))
    w.mgr.respondApproval(s, agentCard(s)!.requestId, 'allow')
    await w.until(() => childrenOf(s).length === 1 && !!handleOf(childrenOf(s)[0]!.id)?.sent.length)
    const c = childrenOf(s)[0]!
    expect([c.projectId, c.tool, c.name]).toEqual([w.caller.id, 'codex', 'implement the parser'])
    const h = handleOf(c.id)!
    expect(h.opts.cwd).toBe(w.caller.path)
    expect(h.sent[0]).toContain("through Centralu's start_agent")
    expect(h.sent[0]).toContain('implement the parser')
    const sent = w.store.loadMessages(c.id, 10).find((m) => m.role === 'user')
    expect((sent?.payload as { from?: { sessionId: string } }).from?.sessionId).toBe(s)
    h.answer('Parser done.')
    expect(await p).toMatchObject({ ok: true, state: 'done', sessionId: c.id, tool: 'codex', answer: 'Parser done.' })
  })

  it('"always for this session" stops asking that session only; "always for this project" every session there, until revoked', async () => {
    const s = await session()
    const first = w.mgr.startAgent(s, { task: 'one', wait: false })
    await w.until(() => !!agentCard(s))
    w.mgr.respondApproval(s, agentCard(s)!.requestId, 'always', 'session')
    expect(await first).toMatchObject({ ok: true })
    expect(await w.mgr.startAgent(s, { task: 'two', wait: false })).toMatchObject({ ok: true })
    expect(agentCard(s)).toBeUndefined()

    const other = await session()
    const third = w.mgr.startAgent(other, { task: 'three', wait: false })
    await w.until(() => !!agentCard(other))
    w.mgr.respondApproval(other, agentCard(other)!.requestId, 'always', 'project')
    expect(await third).toMatchObject({ ok: true })
    expect(w.mgr.projectConsents()).toEqual([expect.objectContaining({ fromProjectId: w.caller.id, toProjectId: w.caller.id, kind: 'agents' })])
    const fresh = await session()
    expect(await w.mgr.startAgent(fresh, { task: 'four', wait: false })).toMatchObject({ ok: true })

    // Four children run now, the ceiling: two of them finish, so the next start reaches the card
    for (const c of [...childrenOf(s), ...childrenOf(other)]) handleOf(c.id)!.answer('done')
    await new Promise((r) => setTimeout(r, 0))
    w.mgr.revokeProjectConsent(w.caller.id, w.caller.id, 'agents')
    const fifth = w.mgr.startAgent(fresh, { task: 'five', wait: false })
    await w.until(() => !!agentCard(fresh))
    w.mgr.respondApproval(fresh, agentCard(fresh)!.requestId, 'deny')
    expect((await fifth).ok).toBe(false)
  })

  it('the child gets the parent\'s preset, whatever it is, and the parent cannot use a child the person later raised above it', async () => {
    allowProject()
    for (const preset of ['safe', 'normal', 'auto'] as const) {
      const s = await session(preset)
      const c = await startRunning(s)
      expect(w.mgr.listSessions().find((x) => x.id === c)?.permissionPreset).toBe(preset)
      expect(handleOf(c)!.opts.permissionPreset).toBe(preset)
    }
    const s = await session('normal')
    const p = w.mgr.startAgent(s, { task: 'first' })
    await w.until(() => !!childrenOf(s)[0] && !!handleOf(childrenOf(s)[0]!.id)?.sent.length)
    const c = childrenOf(s)[0]!.id
    handleOf(c)!.answer('ok')
    await p
    await w.mgr.updateSettings(c, { permissionPreset: 'auto' })
    const r = await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'now delete the build folder' })
    expect(!r.ok && r.error).toContain('more permissions (auto) than this session (normal)')
    expect(handleOf(c)?.sent ?? []).toHaveLength(1)
  })

  it.each([false, true])('wait=%s: includes the adapter\'s network restriction in start_agent\'s answer', async (wait) => {
    allowProject()
    const adapter = w.adapters.get('codex')!
    const create = adapter.createSession.bind(adapter)
    vi.spyOn(adapter, 'createSession').mockImplementation(async (opts, emit) => {
      const h = await create(opts, emit)
      return Object.assign(h, { delegationNotice: () => `this child cannot reach the network under ${opts.permissionPreset}` })
    })
    const s = await session('safe')
    const pending = w.mgr.startAgent(s, { task: 'check the code', tool: 'codex', wait })
    if (wait) {
      await w.until(() => !!childrenOf(s)[0] && !!handleOf(childrenOf(s)[0]!.id)?.sent.length)
      handleOf(childrenOf(s)[0]!.id)!.answer('done')
    }
    expect(await pending).toMatchObject({ ok: true, state: wait ? 'done' : 'working', notice: 'this child cannot reach the network under safe' })
  })

  it('depth one: a child cannot start agents or ask another project', async () => {
    allowProject()
    const s = await session()
    const c = await startRunning(s)
    const r = await w.mgr.startAgent(c, { task: 'and another', wait: false })
    expect(!r.ok && r.error).toContain('cannot start agents')
    w.store.setProjectConsent(w.caller.id, w.target.id, 'delegate')
    const q = await w.mgr.askProject(c, { project: w.target.name, task: 'x' })
    expect(!q.ok && q.error).toContain('cannot ask a project')
    expect(childrenOf(c)).toEqual([])
  })

  it('a session acts only on the children it started', async () => {
    allowProject()
    const s = await session()
    const c = await startRunning(s)
    const other = await session()
    for (const action of ['status', 'wait', 'stop', 'send'] as const) {
      const r = await w.mgr.agentSession(other, { sessionId: c, action, text: 'x' })
      expect(!r.ok && r.error).toContain('is not a session this session started')
    }
    // Nor on a session the person opened, even in the same project
    const r = await w.mgr.agentSession(s, { sessionId: other, action: 'stop' })
    expect(!r.ok && r.error).toContain('is not a session this session started')
    expect(handleOf(c)!.interrupted).toBe(0)
  })

  it(`at most ${AGENT_CEILING} children run at once in a project, counted over all its sessions; a finished one frees a place`, async () => {
    allowProject()
    const a = await session()
    const b = await session()
    const ids: string[] = []
    for (let i = 0; i < AGENT_CEILING; i++) ids.push(await startRunning(i % 2 ? a : b, `task ${i}`))
    const over = await w.mgr.startAgent(a, { task: 'one too many', wait: false })
    expect(!over.ok && over.error).toContain('already working')
    expect(childrenOf(a).length + childrenOf(b).length).toBe(AGENT_CEILING)
    handleOf(ids[0]!)!.answer('done')
    await w.until(() => w.mgr.listSessions().find((x) => x.id === ids[0])?.state === 'waiting_input')
    // The wait settles a few microtasks after the turn's last event
    await new Promise((r) => setTimeout(r, 0))
    expect(await w.mgr.startAgent(a, { task: 'now there is room', wait: false })).toMatchObject({ ok: true })
  })

  it('past the bound it answers "working", tells the parent when the turn ends, and a later wait reads the answer', async () => {
    allowProject()
    const s = await session()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const first = w.mgr.startAgent(s, { task: 'long job' })
    for (let i = 0; i < 50 && !childrenOf(s)[0]; i++) await vi.advanceTimersByTimeAsync(0)
    const c = childrenOf(s)[0]!.id
    await vi.advanceTimersByTimeAsync(ASK_WAIT_MS)
    expect(await first).toMatchObject({ ok: true, state: 'working', sessionId: c, reported: true })
    // A note joins the same turn and keeps the report already promised at the bound.
    const busy = await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'also this' })
    expect(busy).toMatchObject({ ok: true, state: 'working', sessionId: c, reported: true })
    expect(handleOf(c)!.sent.at(-1)).toContain('also this')
    vi.useRealTimers()
    handleOf(c)!.answer('long job done')
    // The parent hears about it through the report path, as another session's message
    await w.until(() => (handleOf(s)?.sent ?? []).some((t) => t.includes(`sourceSessionId: ${c}`)))
    expect(handleOf(s)!.sent.filter((t) => t.includes(`sourceSessionId: ${c}`))).toHaveLength(1)
    expect(await w.mgr.agentSession(s, { sessionId: c, action: 'wait' })).toMatchObject({ ok: true, state: 'done', answer: 'long job done' })
  })

  it.each(['claude', 'codex'] as const)('a mid-turn note to %s is framed, stored and visible as the parent\'s, while an active wait takes the same answer once', async (tool) => {
    allowProject()
    const s = await session()
    const started = await w.mgr.startAgent(s, { task: 'long job', tool, wait: false })
    const c = started.ok ? started.sessionId : ''
    const h = handleOf(c)!
    h.event({ type: 'message_delta', sessionId: c, role: 'assistant', text: 'Working on it.' })
    const waiting = w.mgr.agentSession(s, { sessionId: c, action: 'wait' })
    const result = await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'Use Chromium for e2e.' })
    expect(result).toMatchObject({ ok: true, state: 'working', sessionId: c, reported: false })
    expect(h.sent).toHaveLength(2)
    expect(h.sent[1]).toContain('Another session in this project')
    expect(h.sent[1]).toContain('Use Chromium for e2e.')
    expect(h.interrupted).toBe(0)
    const message = w.store.loadMessages(c, 10).filter((m) => m.role === 'user').at(-1)!
    expect(message.payload).toMatchObject({ text: h.sent[1], from: { sessionId: s } })
    expect(w.events).toContainEqual(expect.objectContaining({ type: 'user_message', sessionId: c, text: h.sent[1], from: expect.objectContaining({ sessionId: s }) }))
    h.answer('Done with Chromium.')
    expect(await waiting).toMatchObject({ ok: true, state: 'done', answer: 'Done with Chromium.' })
    expect(handleOf(s)?.sent ?? []).toEqual([])
  })

  it('mid-turn send preserves the permission gate and requires adapter support, without stopping or losing the wait', async () => {
    allowProject()
    const s = await session('normal')
    const c = await startRunning(s)
    const h = handleOf(c)!
    w.adapters.get('claude')!.capabilities.midTurnInput = false
    expect(await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'note' })).toMatchObject({ ok: false, error: expect.stringContaining('cannot take messages while working') })
    w.adapters.get('claude')!.capabilities.midTurnInput = true
    await w.mgr.updateSettings(c, { permissionPreset: 'auto' })
    expect(await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'note' })).toMatchObject({ ok: false, error: expect.stringContaining('more permissions') })
    expect(h.sent).toHaveLength(1)
    expect(h.interrupted).toBe(0)
    h.answer('done')
    expect(await w.mgr.agentSession(s, { sessionId: c, action: 'wait' })).toMatchObject({ ok: true, state: 'done', answer: 'done' })
  })

  it('a turn the person started remains theirs, even on an adapter that supports mid-turn input', async () => {
    allowProject()
    const s = await session()
    const c = await startRunning(s)
    handleOf(c)!.answer('first done')
    await w.mgr.agentSession(s, { sessionId: c, action: 'wait' })
    await w.mgr.send(c, 'the person\'s task')
    expect(await w.mgr.agentSession(s, { sessionId: c, action: 'send', text: 'note' })).toMatchObject({ ok: false, error: expect.stringContaining('busy with something else') })
    expect(handleOf(c)!.sent).toHaveLength(2)
    expect(handleOf(c)!.interrupted).toBe(0)
  })

  it('a wait in progress takes the answer, with no report on top of it', async () => {
    allowProject()
    const s = await session()
    const c = await startRunning(s)
    const waiting = w.mgr.agentSession(s, { sessionId: c, action: 'wait' })
    await new Promise((r) => setTimeout(r, 10))
    handleOf(c)!.answer('done')
    expect(await waiting).toMatchObject({ ok: true, state: 'done', answer: 'done' })
    await new Promise((r) => setTimeout(r, 20))
    expect((handleOf(s)?.sent ?? []).some((t) => t.includes('sourceSessionId'))).toBe(false)
  })

  it('stop ends the turn the parent gave; Stop on the parent stops a child it waits on, not one left running', async () => {
    allowProject()
    const s = await session()
    const left = await startRunning(s, 'left running')
    const stopped = await w.mgr.agentSession(s, { sessionId: left, action: 'stop' })
    expect(stopped).toMatchObject({ ok: true, state: 'stopped' })
    expect(handleOf(left)!.interrupted).toBe(1)
    expect((await w.mgr.agentSession(s, { sessionId: left, action: 'stop' })).ok).toBe(false)

    const background = await startRunning(s, 'background')
    const waited = w.mgr.startAgent(s, { task: 'waited on' })
    await w.until(() => childrenOf(s).length === 3 && !!handleOf(childrenOf(s).find((x) => x.name === 'waited on')!.id)?.sent.length)
    const waitedId = childrenOf(s).find((x) => x.name === 'waited on')!.id
    w.mgr.interrupt(s)
    const r = await waited
    expect(!r.ok && r.error).toContain('the person stopped the session that asked')
    expect(handleOf(waitedId)!.interrupted).toBe(1)
    expect(handleOf(background)!.interrupted).toBe(0)
  })

  it('the parent deleted, the child keeps its turn and its link', async () => {
    allowProject()
    const s = await session()
    const c = await startRunning(s)
    await w.mgr.trashSession(s)
    expect(handleOf(c)!.interrupted).toBe(0)
    expect(w.mgr.listSessions().find((x) => x.id === c)?.askedBy).toBe(s)
  })

  describe('in a new worktree (part 2)', () => {
    const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd, encoding: 'utf8' }).trim()
    const repo = () => {
      git(w.caller.path, 'init', '-q', '-b', 'main')
      writeFileSync(join(w.caller.path, 'README.md'), 'x')
      git(w.caller.path, 'add', '.')
      git(w.caller.path, 'commit', '-qm', 'init')
    }

    it('prepares installed JS dependencies before the child starts, without a configured setup command', async () => {
      repo()
      writeFileSync(join(w.caller.path, 'package.json'), '{}')
      writeFileSync(join(w.caller.path, 'package-lock.json'), '{}')
      writeFileSync(join(w.caller.path, '.gitignore'), 'node_modules/\n')
      git(w.caller.path, 'add', '.')
      git(w.caller.path, 'commit', '-qm', 'JS project')
      mkdirSync(join(w.caller.path, 'node_modules', 'dep'), { recursive: true })
      writeFileSync(join(w.caller.path, 'node_modules', 'dep', 'index.js'), 'installed dependency')
      const adapter = w.adapters.get('codex')!
      const create = adapter.createSession.bind(adapter)
      vi.spyOn(adapter, 'createSession').mockImplementation(async (opts, emit) => {
        expect(readFileSync(join(opts.cwd, 'node_modules', 'dep', 'index.js'), 'utf8')).toBe('installed dependency')
        return create(opts, emit)
      })
      allowProject()
      const s = await session()
      expect(await w.mgr.startAgent(s, { task: 'test it', tool: 'codex', worktree: true, wait: false })).toMatchObject({ ok: true })
    })

    it('opens the child in a worktree on a branch named from its job, said on the card, linked to its parent', async () => {
      repo()
      const s = await session()
      const p = w.mgr.startAgent(s, { task: 'Write the parser!', worktree: true, wait: false })
      await w.until(() => !!agentCard(s))
      const branch = (agentCard(s)!.detail as { worktree?: { branch: string } }).worktree?.branch
      expect(branch).toMatch(/^centralu\/write-the-parser-[a-z0-9]{4}$/)
      w.mgr.respondApproval(s, agentCard(s)!.requestId, 'allow')
      expect(await p).toMatchObject({ ok: true, state: 'working' })
      const c = childrenOf(s)[0]!
      expect(c.worktree?.branch).toBe(branch)
      expect(c.name).toBe(branch)
      expect(c.askedBy).toBe(s)
      expect(handleOf(c.id)!.opts.cwd).toBe(c.worktree!.path)
      expect(c.worktree!.path.startsWith(w.caller.path)).toBe(false)
      expect(git(c.worktree!.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(branch)
    })

    it('takes the branch asked for, and forks from the parent\'s own branch when the parent works in a worktree', async () => {
      repo()
      allowProject()
      const s = await session()
      const first = await w.mgr.startAgent(s, { task: 'x', branch: 'feat/parser', wait: false })
      expect(first.ok).toBe(true)
      const parentInWorktree = childrenOf(s)[0]!
      writeFileSync(join(parentInWorktree.worktree!.path, 'parser.ts'), 'x')
      git(parentInWorktree.worktree!.path, 'add', '.')
      git(parentInWorktree.worktree!.path, 'commit', '-qm', 'parser')
      // A session the person opened in that worktree's branch starts a child of its own in a new worktree
      const own = await w.mgr.createSession({ projectId: w.caller.id, cwd: w.caller.path, tool: 'claude', permissionPreset: 'normal', worktree: true, worktreeBranch: 'feat/lexer', worktreeBase: 'feat/parser' })
      writeFileSync(join(own.worktree!.path, 'lexer.ts'), 'x')
      git(own.worktree!.path, 'add', '.')
      git(own.worktree!.path, 'commit', '-qm', 'lexer')
      expect(await w.mgr.startAgent(own.id, { task: 'tests for the lexer', branch: 'feat/lexer-tests', wait: false })).toMatchObject({ ok: true })
      const c = childrenOf(own.id)[0]!
      expect(c.worktree?.branch).toBe('feat/lexer-tests')
      expect(existsSync(join(c.worktree!.path, 'lexer.ts'))).toBe(true)
    })

    it('refuses before the card when the project is no git repository, or the branch name is not one', async () => {
      const s = await session()
      const r = await w.mgr.startAgent(s, { task: 'x', worktree: true })
      expect(!r.ok && r.error).toContain('not a git repository')
      repo()
      const bad = await w.mgr.startAgent(s, { task: 'x', branch: 'no..dots' })
      expect(!bad.ok && bad.error).toContain('Not a valid branch name')
      expect(agentCard(s)).toBeUndefined()
      expect(childrenOf(s)).toEqual([])
    })
  })

  it('a session of an untrusted project cannot start agents: no card, nothing started', async () => {
    w.mgr.setProjectTrusted(w.caller.id, false)
    const s = await session()
    const r = await w.mgr.startAgent(s, { task: 'x' })
    expect(!r.ok && r.error).toContain('not trusted')
    expect(agentCard(s)).toBeUndefined()
    expect(childrenOf(s)).toEqual([])
  })
})
