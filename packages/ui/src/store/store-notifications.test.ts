/**
 * Store regression tests: notices, toasts, updates and proposals waiting on the person.
 *
 * Ports go through `MockPlatform` (no ad-hoc mocking, or the contract falls apart). The
 * `pendingEvents` holding pen is module state, so it cannot be cleared between tests — each test
 * uses a different session id instead. Shared fixtures are in store.test-helpers.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'
import { NO_PATH } from '@cc/protocol'
import { countWaiting } from '@cc/core'
// eslint-disable-next-line no-restricted-imports -- the runtime ui knows only ports, but tests are contractually required to use MockPlatform instead of ad-hoc mocking (see the header of platform/src/mock/index.ts)
import { MockPlatform } from '@cc/platform/mock'
import { appliedVersionsText, messagesToChat, useStore } from './store.js'
import { computeInbox } from './selectors.js'
import { holdList, resetStore, sessionInfo } from './store.test-helpers.js'

beforeEach(resetStore)

/**
 * Update status does not belong to a session (issue #43).
 *
 * `dispatchEvent`'s first line is `if (!sessionId) return`, and that is the widest door in this file.
 * Placing an app-wide event after it means whatever the host sends arrives and does nothing —
 * communication looks fine, there is no error, and it is the kind of defect that leaves no clue
 * anywhere to trace the cause. Order is the contract here, so this pins it down.
 */
describe('update status (#43)', () => {
  const status = {
    current: '0.1.0-beta.2', latest: '9999.0.0', newer: true, auto: true, autoApply: false,
    phase: 'idle' as const, error: null, checkedAt: 1,
  }

  it('an event with no session also reaches the store', () => {
    useStore.getState().dispatchEvent({ type: 'update_status', status })
    expect(useStore.getState().update?.latest).toBe('9999.0.0')
  })

  it.each(['check', 'install'] as const)('ignores a late %s response from a host swapped mid-install (#635)', async (action) => {
    const platform = new MockPlatform()
    let resolve!: (value: typeof status) => void
    const gate = new Promise<typeof status>((r) => { resolve = r })
    const spy = action === 'check'
      ? vi.spyOn(platform.updates, 'status').mockReturnValueOnce(gate)
      : vi.spyOn(platform.updates, 'apply').mockReturnValueOnce(gate)
    useStore.setState({ platform, update: { ...status, phase: 'updating' }, hostResyncs: 0 })
    const pending = action === 'check' ? useStore.getState().checkUpdate(true) : useStore.getState().applyUpdate()
    const replacement = { ...status, current: '9999.0.0', newer: false }
    useStore.setState({ update: replacement, hostResyncs: 1 })
    resolve(status)
    await pending
    expect(useStore.getState().update).toEqual(replacement)
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('re-reads update status after reconnect without replaying an install (#635)', async () => {
    const platform = new MockPlatform()
    platform.registryVersion = '9999.0.2'
    const apply = vi.spyOn(platform.updates, 'apply')
    useStore.setState({ platform, update: { ...status, phase: 'updating' }, sessions: {}, chat: {}, connection: 'connected' })
    await useStore.getState().recoverAfterReconnect(true)
    await vi.waitFor(() => expect(useStore.getState().update?.latest).toBe('9999.0.2'))
    expect(useStore.getState().update?.phase).toBe('idle')
    expect(apply).not.toHaveBeenCalled()
    apply.mockRestore()
  })

  /**
   * An agent's "Apply now" (#665): the host asks over the event stream, and the window answers with the checks its
   * button makes; told to go, it runs the button's own `applyUpdateNow`. The mock plays the host's half
   * (`agentApply`), the window's half is the store's.
   */
  describe('an agent applying the installed update (#665)', () => {
    const installed = { ...status, current: '0.0.1', latest: '9999.0.0', phase: 'restart_required' as const }
    function windowOf(platform: MockPlatform) {
      useStore.setState({ platform, update: installed })
      return platform.agents.subscribe((e) => useStore.getState().dispatchEvent(e))
    }

    it('a request reaches the window, which relaunches through applyUpdateNow once', async () => {
      const platform = new MockPlatform()
      platform.relaunchCheck = { ready: true, version: '9999.0.0' }
      const stop = windowOf(platform)
      const applyNow = vi.fn(useStore.getState().applyUpdateNow)
      useStore.setState({ applyUpdateNow: applyNow })
      // What the host had heard when the shell was asked to relaunch: "started" comes first (#665 review)
      const relaunch = platform.relaunch.relaunch
      let heardBefore: unknown[] = []
      platform.relaunch.relaunch = async () => {
        heardBefore = [...platform.applyReports]
        await relaunch()
      }
      expect(await platform.agentApply()).toEqual({ ok: true })
      expect(applyNow).toHaveBeenCalledTimes(1)
      expect(platform.relaunches).toBe(1)
      expect(platform.applyAnswers).toEqual([expect.objectContaining({ ready: true, version: '9999.0.0' })])
      expect(heardBefore).toEqual([expect.objectContaining({ started: true })])
      expect(platform.applyReports).toEqual([expect.objectContaining({ started: true }), expect.not.objectContaining({ error: expect.anything() })])
      stop()
    })

    it("a go for another window's ticket, or replayed, relaunches nothing", async () => {
      const platform = new MockPlatform()
      platform.relaunchCheck = { ready: true, version: '9999.0.0' }
      const stop = windowOf(platform)
      useStore.getState().dispatchEvent({ type: 'update_apply_go', requestId: 'r', ticket: 'someone-else' })
      expect(await platform.agentApply()).toEqual({ ok: true })
      // The same go again, as a reconnect would replay it
      useStore.getState().dispatchEvent({ type: 'update_apply_go', requestId: 'apply-1', ticket: 'ticket-apply-1' })
      await Promise.resolve()
      expect(platform.relaunches).toBe(1)
      stop()
    })

    it('nothing installed: the window says so and nothing relaunches', async () => {
      const platform = new MockPlatform()
      platform.relaunchCheck = { ready: false, reason: 'not replaced' }
      const stop = windowOf(platform)
      useStore.setState({ update: { ...status, phase: 'idle' } })
      expect(await platform.agentApply()).toEqual({ ok: false, error: expect.stringContaining('No update is installed') })
      expect(platform.relaunches).toBe(0)
      stop()
    })

    it("the shell's refusal at the go reaches the host", async () => {
      const platform = new MockPlatform()
      platform.relaunchCheck = { ready: true, version: '9999.0.0' }
      platform.relaunchFails = 'Not relaunched: the keeper is too old.'
      const stop = windowOf(platform)
      expect(await platform.agentApply()).toEqual({ ok: false, error: 'Not relaunched: the keeper is too old.' })
      stop()
    })
  })

  /** Installing must be started by a person — merely finding out does nothing on its own */
  it('merely learning of a new version installs nothing on its own', async () => {
    const platform = new MockPlatform()
    platform.registryVersion = '9999.0.0'
    useStore.setState({ platform })
    await useStore.getState().checkUpdate(true)
    expect(useStore.getState().update?.newer).toBe(true)
    expect(useStore.getState().update?.phase).toBe('idle')
  })
})

/**
 * Composer focus simply calls the existing `wake()` — these are the properties that `wake` must keep.
 *
 * Picking from the sidebar (`focusSession`) and composer focus from a grid panel or restart both go
 * through the same door. A failure is only left in `wakeError`, never raised as a toast (focus is not
 * an action), and if it is already alive, nothing happens.
 */
/** The installed agent CLIs (#297) — app-wide like update status, so the same door applies */
describe('agent CLI versions (#297)', () => {
  it('the installed versions reach the store though they belong to no session', () => {
    useStore.getState().dispatchEvent({ type: 'agent_versions', status: { installed: { claude: '2.1.290' }, autoApply: true, checkedAt: 1 } })
    expect(useStore.getState().agentVersions?.installed.claude).toBe('2.1.290')
  })

  it('coming back to the window asks the host to read the installed versions again', async () => {
    const platform = new MockPlatform()
    platform.setInstalledVersions({ claude: '2.1.291' })
    useStore.setState({ platform, appFocused: false, agentVersions: null })
    useStore.getState().setAppFocused(true)
    await vi.waitFor(() => expect(useStore.getState().agentVersions?.installed.claude).toBe('2.1.291'))
  })

  it('the header action’s line says how many moved and how many were busy', () => {
    expect(appliedVersionsText(2, 0)).toBe('Restarted 2 sessions on the installed version')
    expect(appliedVersionsText(1, 1)).toBe('Restarted 1 session on the installed version; 1 busy keeps its version for now')
    expect(appliedVersionsText(0, 2)).toBe('Nothing restarted: 2 sessions busy keep their version for now')
    expect(appliedVersionsText(0, 0)).toBe('Every session already runs the installed version')
  })
})

/**
 * An MCP server suggestion card (option B) — the host says when a list changed, and clicking approve goes to the host.
 *
 * The screen never guesses the moment from the orchestrator's `tool_call` (#703): that event arrives when the call
 * starts, before the host has saved the proposal, so a read on it returns the old list.
 */
describe('MCP server suggestions', () => {
  it('the card appears when the host saves the proposal after the tool_call arrived (#703)', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('mcp-s1', sessionInfo('mcp-s1'))
    await useStore.getState().attach(mock)

    // The order the host really has: the call starts (the event goes out), and only then is the proposal saved
    mock.emit({
      type: 'tool_call', sessionId: 'mcp-s1', callId: 'c1',
      summary: { tool: 'mcp__centralu__propose_mcp_server', title: 'playwright', paths: [] },
    } as NormalizedEvent)
    await Promise.resolve()
    expect(useStore.getState().mcpProposals).toEqual([])
    mock.saveProposal({ mcp: { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'], why: 'browser' } })

    await vi.waitFor(() => {
      expect(useStore.getState().mcpProposals).toEqual([
        { name: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp'], why: 'browser' },
      ])
    })
  })

  it('a tool_call alone does not read the lists: the host broadcast is the signal', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('mcp-s2', sessionInfo('mcp-s2'))
    await useStore.getState().attach(mock)
    const read = vi.spyOn(mock.agents, 'mcpProposals')

    for (const tool of ['mcp__centralu__propose_mcp_server', 'mcp__centralu__propose_skill', 'centralu_run']) {
      mock.emit({
        type: 'tool_call', sessionId: 'mcp-s2', callId: tool,
        summary: { tool, title: tool, paths: [] },
      } as NormalizedEvent)
    }
    await Promise.resolve()
    expect(read).not.toHaveBeenCalled()
  })

  /*
   * A host that predates `orchestrator_proposals_changed` (an old host still serving during a swap) sends only the
   * tool events. The result comes after the save, so it re-reads: the one place a guess about the tool name stays.
   */
  it('the tool_result of a proposal call re-reads both lists, for a host that does not broadcast', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('mcp-s3', sessionInfo('mcp-s3'))
    await useStore.getState().attach(mock)
    mock.sessions.set('mcp-s3b', sessionInfo('mcp-s3b'))
    const call = (tool: string, callId: string, sessionId = 'mcp-s3') =>
      mock.emit({ type: 'tool_call', sessionId, callId, summary: { tool, title: tool, paths: [] } } as NormalizedEvent)
    const result = (callId: string, sessionId = 'mcp-s3') => mock.emit({ type: 'tool_result', sessionId, callId, ok: true, summary: '' } as NormalizedEvent)
    const read = vi.spyOn(mock.agents, 'mcpProposals')

    // An unrelated call's result reads nothing
    call('Bash', 'other')
    result('other')
    await Promise.resolve()
    expect(read).not.toHaveBeenCalled()

    // Call ids may repeat between sessions (a Codex id is unique per thread): another session's result is not this call's
    call('centralu_run', 'same-id')
    result('same-id', 'mcp-s3b')
    await Promise.resolve()
    expect(read).not.toHaveBeenCalled()
    result('same-id')
    await vi.waitFor(() => expect(read).toHaveBeenCalled())
    read.mockClear()

    // The old host saved without announcing (the lists change silently), then the call returned
    call('centralu_run', 'run-1')
    mock.mcpProposalList.push({ name: 'playwright', command: 'npx', args: [] })
    mock.skillProposalList.push({ name: 'weekly-report', content: 'a summary every Friday' })
    expect(useStore.getState().mcpProposals).toEqual([])
    result('run-1')
    await vi.waitFor(() => {
      expect(useStore.getState().mcpProposals.map((p) => p.name)).toEqual(['playwright'])
      expect(useStore.getState().skillProposals.map((p) => p.name)).toEqual(['weekly-report'])
    })
  })

  it('a reconnect re-reads both lists: a broadcast lost in the gap leaves no stale card, count or badge', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.saveProposal({ mcp: { name: 'playwright', command: 'npx', args: [] } })
    await vi.waitFor(() => expect(useStore.getState().mcpProposals).toHaveLength(1))
    expect(mock.badge).toBe(1)

    // While the socket was down the person answered in another window and the orchestrator proposed a skill: no event arrived
    mock.mcpProposalList.splice(0)
    mock.skillProposalList.push({ name: 'weekly-report', content: 'a summary every Friday' })
    expect(useStore.getState().mcpProposals).toHaveLength(1)

    await useStore.getState().recoverAfterReconnect(true)

    await vi.waitFor(() => {
      expect(useStore.getState().mcpProposals).toEqual([])
      expect(useStore.getState().skillProposals.map((p) => p.name)).toEqual(['weekly-report'])
      expect(computeInbox(useStore.getState()).map((i) => i.proposal)).toEqual([{ kind: 'skill', name: 'weekly-report' }])
    })
    expect(mock.badge).toBe(1)
  })

  it('one broadcast re-reads both lists, whichever tool or command made the change', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.mcpProposalList.push({ name: 'playwright', command: 'npx', args: [] })
    mock.skillProposalList.push({ name: 'weekly-report', content: 'a summary every Friday' })

    mock.emit({ type: 'orchestrator_proposals_changed' })

    await vi.waitFor(() => {
      expect(useStore.getState().mcpProposals.map((p) => p.name)).toEqual(['playwright'])
      expect(useStore.getState().skillProposals.map((p) => p.name)).toEqual(['weekly-report'])
    })
  })

  it('a proposal answered elsewhere (another window) leaves the list without a reload', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.saveProposal({ mcp: { name: 'playwright', command: 'npx', args: [] } })
    await vi.waitFor(() => expect(useStore.getState().mcpProposals).toHaveLength(1))

    // The other window's answer: the host drops the proposal and broadcasts
    mock.mcpProposalList.splice(0)
    mock.emit({ type: 'orchestrator_proposals_changed' })

    await vi.waitFor(() => expect(useStore.getState().mcpProposals).toEqual([]))
  })

  it('clicking approve is passed to the host and empties the list', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.mcpProposalList.push({ name: 'playwright', command: 'npx', args: [] })
    await useStore.getState().refreshMcpProposals()

    await useStore.getState().resolveMcpProposal('playwright', true)

    expect(mock.mcpApproved).toContain('playwright')
    expect(useStore.getState().mcpProposals).toEqual([])
    expect(useStore.getState().toast).toMatch(/Installing playwright/)
  })
})

/** A skill suggestion (#71) — the same rail as an MCP suggestion: the host's broadcast wakes the list, and approval goes to the host */
describe('skill suggestions', () => {
  it('the card appears when the host saves the proposal after the tool_call, and approving leads to a save', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('sk-s1', sessionInfo('sk-s1'))
    await useStore.getState().attach(mock)

    mock.emit({
      type: 'tool_call', sessionId: 'sk-s1', callId: 'c1',
      summary: { tool: 'mcp__centralu__propose_skill', title: 'weekly-report', paths: [] },
    } as NormalizedEvent)
    await Promise.resolve()
    mock.saveProposal({ skill: { name: 'weekly-report', content: 'a summary every Friday', why: 'a recurring request' } })
    await vi.waitFor(() => {
      expect(useStore.getState().skillProposals).toEqual([
        { name: 'weekly-report', content: 'a summary every Friday', why: 'a recurring request' },
      ])
    })

    await useStore.getState().resolveSkillProposal('weekly-report', true)
    expect(mock.skillList).toEqual([{ name: 'weekly-report', content: 'a summary every Friday' }])
    expect(useStore.getState().skillProposals).toEqual([])
    expect(useStore.getState().toast).toMatch(/Skill saved/)
  })
})

/** A pending proposal waits on the person like an approval does (#703): it is counted, listed and jumped to */
describe('pending proposals wait on the person', () => {
  it('count and list with the approvals, and a jump lands on the orchestrator screen', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('pw-s1', sessionInfo('pw-s1'))
    await useStore.getState().attach(mock)
    expect(computeInbox(useStore.getState())).toEqual([])

    mock.saveProposal({ mcp: { name: 'playwright', command: 'npx', args: [] } })
    mock.saveProposal({ skill: { name: 'weekly-report', content: 'a summary every Friday' } })
    await vi.waitFor(() => expect(computeInbox(useStore.getState())).toHaveLength(2))

    const items = computeInbox(useStore.getState())
    expect(items.map((i) => [i.state, i.proposal])).toEqual([
      ['waiting_approval', { kind: 'mcp', name: 'playwright' }],
      ['waiting_approval', { kind: 'skill', name: 'weekly-report' }],
    ])
    expect(countWaiting([...items])).toMatchObject({ approval: 2 })
    // The dock badge counts them too
    expect(mock.badge).toBe(2)

    await useStore.getState().openWaiting(items[0]!.id)
    await vi.waitFor(() => expect(useStore.getState().view).toBe('orchestrator'))
  })

  it('leave the list when answered', async () => {
    const mock = new MockPlatform()
    await useStore.getState().attach(mock)
    mock.saveProposal({ mcp: { name: 'playwright', command: 'npx', args: [] } })
    await vi.waitFor(() => expect(computeInbox(useStore.getState())).toHaveLength(1))

    await useStore.getState().resolveMcpProposal('playwright', false)

    expect(computeInbox(useStore.getState())).toEqual([])
    expect(mock.badge).toBe(0)
  })
})

/*
 * The settings-change toast states what the host actually did (#164). It used to always say "(from
 * next turn)."
 */
describe('the settings-change toast (#164)', () => {
  it.each([
    ['after_turn', 'Effort: high (applies when this turn ends)'],
    ['restarted', 'Effort: high (agent restarted)'],
    ['saved', 'Effort: high (from next turn)'],
  ] as const)('%s → %s', async (applied, toast) => {
    const platform = new MockPlatform()
    const s = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'normal' })
    vi.spyOn(platform.agents, 'updateSettings').mockResolvedValue({ ...s, effort: 'high', applied })
    useStore.setState({ platform, sessions: { [s.id]: { ...s } as never } })

    await useStore.getState().updateSessionSettings(s.id, { effort: 'high' })
    expect(useStore.getState().toast).toBe(toast)
  })
})

/*
 * The "always allow" notification uses the matcher actually sent (#170). The card used to compose its
 * own separate wording, so even a kind with no matcher (`other`) was announced as "Always allow in
 * this session: other" — even though no rule had actually been kept.
 */
describe('the always-allow notification (#170)', () => {
  async function answerAlways(detail: Record<string, unknown>, scope: 'session' | 'project' = 'session') {
    const platform = new MockPlatform()
    const s = await platform.agents.createSession({ projectId: 'p1', cwd: '/tmp/p1', tool: 'claude', permissionPreset: 'safe' })
    const spy = vi.spyOn(platform.agents, 'respondApproval').mockResolvedValue(undefined as never)
    useStore.setState({
      platform,
      sessions: { [s.id]: { ...s, pendingApproval: { requestId: 'r1', detail } } as never },
    })
    await useStore.getState().respondApproval(s.id, 'r1', 'always', scope)
    return { matcher: spy.mock.calls[0]?.[4], toast: useStore.getState().toast }
  }

  it('a file edit sends its path, and the notification states that path', async () => {
    const r = await answerAlways({ kind: 'file_edit', path: '/x/a.ts', diffPreview: '', multi: false }, 'project')
    expect(r.matcher).toBe('/x/a.ts')
    expect(r.toast).toBe('Always allow in this project: /x/a.ts')
  })

  // An edit whose path is unknown has nothing to remember (#428): it used to send "(no path)" and toast it as a rule
  it('a file edit with no path sends no matcher and says it was allowed once', async () => {
    const r = await answerAlways({ kind: 'file_edit', path: NO_PATH, diffPreview: '', multi: false })
    expect(r.matcher).toBeUndefined()
    expect(r.toast).toContain('Allowed once')
  })

  it('a kind with no matcher never claims a rule was kept', async () => {
    const r = await answerAlways({ kind: 'other', raw: 'mcp__x__y {}' })
    expect(r.matcher).toBeUndefined()
    expect(r.toast).not.toContain('Always allow in')
    expect(r.toast).toContain('Allowed once')
  })
})

/**
 * What the agent tools tell the person (#304): a fresh conversation and a notice are one quiet line each, live and
 * after reopening; a model switch the tool made updates the model shown without a toast.
 */
describe('resets, notices and switches the tool made (#304)', () => {
  const HOOK =
    'UserPromptSubmit operation blocked by hook:\n[node block-hook.mjs]: Prompts containing BLOCKME are not allowed here.'

  it('a reset and a notice each stand as one line, and the reset empties the context gauge', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('n-1', sessionInfo('n-1'))
    await useStore.getState().attach(mock)

    mock.emit({ type: 'context_update', sessionId: 'n-1', used: 15967, window: 200000, exactness: 'exact' })
    mock.emit({ type: 'conversation_reset', sessionId: 'n-1', trigger: 'clear' })
    mock.emit({ type: 'notice', sessionId: 'n-1', level: 'warning', text: HOOK })

    const marks = (useStore.getState().chat['n-1'] ?? []).filter((i) => i.kind === 'mark').map((i) => (i as { text: string }).text)
    expect(marks).toEqual(['Conversation cleared — the agent remembers nothing above this line', HOOK])
    expect(useStore.getState().sessions['n-1']?.context).toBeNull()
  })

  it('the same lines come back after reopening — both are stored as markers', () => {
    const items = messagesToChat([
      { sessionId: 'n-2', seq: 3, role: 'system', kind: 'marker', ts: 1, payload: { type: 'conversation_reset', sessionId: 'n-2', trigger: 'clear' } },
      { sessionId: 'n-2', seq: 4, role: 'system', kind: 'marker', ts: 2, payload: { type: 'conversation_reset', sessionId: 'n-2', trigger: 'plan_exit' } },
      { sessionId: 'n-2', seq: 5, role: 'system', kind: 'marker', ts: 3, payload: { type: 'notice', sessionId: 'n-2', level: 'warning', text: HOOK } },
    ])
    expect(items.map((i) => (i as { text: string }).text)).toEqual([
      'Conversation cleared — the agent remembers nothing above this line',
      'The agent started a new conversation here — it remembers nothing above this line',
      HOOK,
    ])
  })

  it('a marker kind this build does not know is left out, not drawn as a compaction', () => {
    const items = messagesToChat([
      { sessionId: 'n-4', seq: 1, role: 'system', kind: 'marker', ts: 1, payload: { type: 'from_a_newer_host', text: 'x' } },
      { sessionId: 'n-4', seq: 2, role: 'system', kind: 'marker', ts: 2, payload: { type: 'compaction', failed: false } },
    ])
    expect(items.map((i) => (i as { text: string }).text)).toEqual(['Earlier messages were compacted here'])
  })

  it('a readable notice (#342) leads with who, what kind and whose it is, live and restored alike', async () => {
    const CONFIG =
      'Codex is ignoring 2 unrecognized configuration settings. Check for typos or deprecated settings.\n' +
      '  user (~/.codex/config.toml): `a.b` is ignored.\n  user (~/.codex/config.toml): `c` is ignored.'
    const notice = {
      type: 'notice' as const,
      sessionId: 'n-5',
      level: 'warning' as const,
      text: CONFIG,
      oncePerSession: true,
      from: 'Codex',
      label: 'config warning',
      audience: 'you' as const,
      summary: 'Codex ignored 2 settings in `~/.codex/config.toml`',
      items: ['a.b', 'c'],
      hint: 'Codex already runs without them; removing them from the file only silences this notice.',
    }
    const expected = {
      text: 'Codex · config warning · for you — Codex ignored 2 settings in `~/.codex/config.toml`',
      notice: {
        head: 'Codex · config warning',
        from: 'Codex',
        audience: 'you',
        summary: 'Codex ignored 2 settings in `~/.codex/config.toml`',
        original: CONFIG,
        items: ['a.b', 'c'],
        hint: 'Codex already runs without them; removing them from the file only silences this notice.',
      },
    }
    const mock = new MockPlatform()
    mock.sessions.set('n-5', sessionInfo('n-5'))
    await useStore.getState().attach(mock)
    mock.emit(notice)
    const live = (useStore.getState().chat['n-5'] ?? []).filter((i) => i.kind === 'mark')
    expect(live).toMatchObject([expected])

    const restored = messagesToChat([{ sessionId: 'n-5', seq: 1, role: 'system', kind: 'marker', ts: 1, payload: notice }])
    expect(restored).toMatchObject([expected])
  })

  it("an unknown readable notice keeps the tool's text as its line, and one from before #342 reads as before", () => {
    const items = messagesToChat([
      {
        sessionId: 'n-6', seq: 1, role: 'system', kind: 'marker', ts: 1,
        payload: { type: 'notice', sessionId: 'n-6', level: 'warning', text: 'Exceeded skills context budget.', from: 'Codex', label: 'warning' },
      },
      {
        sessionId: 'n-6', seq: 2, role: 'system', kind: 'marker', ts: 2,
        payload: { type: 'notice', sessionId: 'n-6', level: 'warning', text: 'Full-history hydration is deprecated.', from: 'Codex', label: 'deprecation', audience: 'centralu' },
      },
      { sessionId: 'n-6', seq: 3, role: 'system', kind: 'marker', ts: 3, payload: { type: 'notice', sessionId: 'n-6', level: 'warning', text: HOOK } },
    ])
    expect(items.map((i) => (i as { text: string }).text)).toEqual([
      'Codex · warning — Exceeded skills context budget.',
      'Codex · deprecation · for Centralu — Full-history hydration is deprecated.',
      HOOK,
    ])
    // No summary: the text is the line itself, so there is nothing to show on demand
    expect(items[0]).toMatchObject({ notice: { head: 'Codex · warning', from: 'Codex' } })
    expect((items[0] as { notice?: { original?: string } }).notice?.original).toBeUndefined()
    expect((items[2] as { notice?: unknown }).notice).toBeUndefined()
  })

  it('a model switch the tool made updates the model shown without a toast; the orchestrator still raises one', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('n-3', sessionInfo('n-3', { model: 'opus' }))
    await useStore.getState().attach(mock)
    useStore.setState({ toast: null })

    mock.emit({ type: 'settings_changed', sessionId: 'n-3', model: 'claude-sonnet-4-6', effort: null, verbosity: null, serviceTier: null, by: 'tool' })
    expect(useStore.getState().sessions['n-3']?.model).toBe('claude-sonnet-4-6')
    expect(useStore.getState().toast).toBeNull()

    mock.emit({ type: 'settings_changed', sessionId: 'n-3', model: 'haiku', effort: null, verbosity: null, serviceTier: null })
    expect(useStore.getState().toast).toMatch(/Orchestrator changed/)
  })

  /*
   * #659: a window other than the caller (or the person's own window when an agent made the change) only learned the new
   * model and permission preset from a re-list. The mock emits what the host emits for `agents.updateSettings`.
   */
  it('a settings change another client made shows the new model and permission preset, without the orchestrator toast (#659)', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('n-4', sessionInfo('n-4', { model: 'fable', permissionPreset: 'normal' }))
    await useStore.getState().attach(mock)
    useStore.setState({ toast: null })

    await mock.agents.updateSettings('n-4', { model: 'opus', permissionPreset: 'auto' })

    expect(useStore.getState().sessions['n-4']).toMatchObject({ model: 'opus', permissionPreset: 'auto' })
    expect(useStore.getState().toast).toBeNull()
  })

  it('a settings change that lands back on the value a pending list was asked with is kept over the list (#642, #659)', async () => {
    const mock = new MockPlatform()
    mock.sessions.set('n-5', sessionInfo('n-5', { model: 'fable', permissionPreset: 'normal' }))
    await useStore.getState().attach(mock)
    mock.setConnectionState('disconnected')
    // The list is read with this row; the settings events below are newer than it
    mock.sessions.get('n-5')!.permissionPreset = 'safe'
    const list = holdList(mock)
    const recovery = useStore.getState().recoverAfterReconnect(true)
    await list.asked
    const set = (model: string, permissionPreset: 'safe' | 'normal' | 'auto') =>
      mock.emit({ type: 'settings_changed', sessionId: 'n-5', model, effort: null, verbosity: null, serviceTier: null, permissionPreset, person: true })
    set('opus', 'auto')
    set('fable', 'normal')
    list.release()
    await recovery
    expect(useStore.getState().sessions['n-5']).toMatchObject({ model: 'fable', permissionPreset: 'normal' })
  })
})
