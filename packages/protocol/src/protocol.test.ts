/**
 * Golden tests (M1 plan T1-1). The fixtures here are a fixed list of "messages this version must
 * be able to parse." If changing the schema breaks this file, that is a backward-compatibility
 * break. Adding a field must never break this file (docs/protocol.md §4).
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  applyBackgroundTasks,
  ATTACHMENT_MAX_BASE64,
  type BackgroundTask,
  liveBackgroundTasks,
  NormalizedEvent,
  PROTOCOL_VERSION,
  parseClientFrame,
  parseEventLenient,
  parseServerFrame,
  RpcMethods,
  isProjectId,
  ToolDescriptor,
  ToolName,
  ToolStatus,
  withoutToolRecord,
} from './index.js'

const GOLDEN_EVENTS_V1: unknown[] = [
  { type: 'message_delta', sessionId: 's1', role: 'assistant', text: 'hi' },
  // Which message the chunk belongs to (#212) — optional, so the frame above still parses
  { type: 'message_delta', sessionId: 's1', role: 'assistant', text: 'hi', messageId: 'm1' },
  { type: 'tool_call', sessionId: 's1', callId: 'c1', summary: { tool: 'Bash', title: 'npm test', readOnly: false, paths: [] } },
  { type: 'tool_result', sessionId: 's1', callId: 'c1', ok: true, summary: 'exit 0' },
  // The whole record of a tool call (#221) — optional, so the two frames above still parse
  { type: 'tool_call', sessionId: 's1', callId: 'c2', summary: { tool: 'Write', title: 'Write: a.ts', readOnly: false, paths: ['a.ts'] }, input: { file_path: 'a.ts', content: 'export {}' } },
  { type: 'tool_result', sessionId: 's1', callId: 'c2', ok: true, summary: 'wrote', output: 'wrote a.ts' },
  // A native subagent's step, under the call that launched it (#222)
  {
    type: 'subagent_event',
    sessionId: 's1',
    parentCallId: 'toolu_agent',
    step: { type: 'tool_call', sessionId: 's1', callId: 'toolu_sub', summary: { tool: 'Bash', title: 'ls', readOnly: false, paths: [] }, input: { command: 'ls' } },
  },
  {
    type: 'subagent_event',
    sessionId: 's1',
    parentCallId: 'toolu_agent',
    stepSeq: 2,
    step: { type: 'tool_result', sessionId: 's1', callId: 'toolu_sub', ok: true, summary: 'a.ts', output: 'a.ts\nb.ts' },
  },
  { type: 'subagent_event', sessionId: 's1', parentCallId: 'toolu_agent', step: { type: 'message_delta', sessionId: 's1', role: 'assistant', text: 'Done.' } },
  { type: 'approval_request', sessionId: 's1', requestId: 'r1', detail: { kind: 'command', command: 'npm run build', cwd: '/p' } },
  { type: 'approval_request', sessionId: 's1', requestId: 'r2', detail: { kind: 'file_edit', path: 'a.ts', diffPreview: '+x', multi: false } },
  { type: 'approval_request', sessionId: 's1', requestId: 'r3', detail: { kind: 'other', raw: '{}' } },
  // A capability question's card (M4 D-4) — raised by the host
  {
    type: 'approval_request',
    sessionId: 's1',
    requestId: 'cap-1',
    detail: { kind: 'capability', app: { appId: 'notes', projectId: 'p1', name: 'Notes' }, capability: 'agent:claude', text: 'run an agent (Claude Code) in a new session' },
  },
  { type: 'approval_resolved', sessionId: 's1', requestId: 'r1', decision: 'allow' },
  {
    type: 'question_request',
    sessionId: 's1',
    requestId: 'q1',
    questions: [
      {
        question: 'What should we have for lunch?',
        header: 'Lunch',
        options: [
          { label: 'Kimbap', description: 'Fast' },
          { label: 'Ramen', description: 'Warm' },
        ],
        multiSelect: false,
      },
    ],
  },
  { type: 'question_resolved', sessionId: 's1', requestId: 'q1' },
  { type: 'turn_complete', sessionId: 's1' },
  // A turn that answered against a schema (M4 D-1)
  { type: 'turn_complete', sessionId: 's1', output: { summary: 'short' } },
  { type: 'state_change', sessionId: 's1', state: 'waiting_input' },
  { type: 'usage_update', sessionId: 's1', tokens: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01 } },
  { type: 'context_update', sessionId: 's1', used: 1000, window: 200000, exactness: 'exact' },
  { type: 'limit_reached', sessionId: 's1', resumeAt: '2026-08-15T14:30:00Z', usedPercent: 21, windowMins: 10080 },
  // A v1 frame from before auto existed — must be read as an automatic name (adding a field must never break an old frame)
  { type: 'session_title', sessionId: 's1', title: 'auth refactor' },
  // A name a person set (issue #5). auto=false means an automatic name never overwrites it again
  { type: 'session_title', sessionId: 's1', title: 'Guard MCP', auto: false },
  { type: 'files_touched', sessionId: 's1', paths: ['src/a.ts'] },
  { type: 'user_message', sessionId: 's1', seq: 12, text: 'text the orchestrator inserted' },
  // The origin of a message that arrived via instruction (FR-11)
  { type: 'user_message', sessionId: 's1', seq: 13, text: 'clean up the release notes', from: { sessionId: 'orc-1', name: 'coordinator session' } },
  // A message sent by an inline conversation app screen (M4 B-1, B-4) — a person sent it, but an app wrote it
  { type: 'user_message', sessionId: 's1', seq: 15, text: 'Show details for row 3', fromApp: { appId: 'slider', projectId: 'p1', name: 'Slider' } },
  // An inline conversation app screen (M4 B-1) — open (input), result, cancelled, rejected, closed
  { type: 'app_view', sessionId: 's1', seq: 16, callId: 'toolu_1', appId: 'slider', projectId: 'p1', tool: 'show', phase: 'open', instanceId: 'i-1', toolInput: { q: 'x' } },
  { type: 'app_view', sessionId: 's1', callId: 'toolu_1', appId: 'slider', projectId: 'p1', tool: 'show', phase: 'result', toolResult: { content: [{ type: 'text', text: 'ok' }], structuredContent: { n: 1 } }, kept: true },
  { type: 'app_view', sessionId: 's1', callId: 'toolu_2', appId: 'slider', projectId: null, tool: 'show', phase: 'cancelled', reason: 'the caller cancelled this call' },
  { type: 'app_view', sessionId: 's1', seq: 17, callId: 'toolu_3', appId: 'slider', projectId: 'p1', tool: 'spoof', phase: 'rejected', reason: 'This app does not serve ui://other/main' },
  { type: 'app_view', sessionId: 's1', callId: 'toolu_1', appId: 'slider', projectId: 'p1', tool: 'show', phase: 'closed', reason: 'This app was removed' },
  // Reasoning (measured in #58): codex has summary text, claude only a token estimate — so both are optional
  { type: 'reasoning_delta', sessionId: 's1', seq: 14, text: '**Reviewing path constraints**' },
  { type: 'reasoning_delta', sessionId: 's1', estTokens: 150 },
  // Measured in #58 (codex turn/plan/updated): a snapshot — the real shape with all three states present
  {
    type: 'plan_update',
    sessionId: 's1',
    steps: [
      { text: 'Set up the command execution plan', status: 'completed' },
      { text: 'Run the requested shell command', status: 'inProgress' },
      { text: 'Count its output lines and report', status: 'pending' },
    ],
  },
  // Measured in #58 (codex item/commandExecution/outputDelta): an output chunk from a running command
  { type: 'tool_output_delta', sessionId: 's1', callId: 'exec-5de387b1', text: 'tick 2\n' },
  // An image an agent produced (#40) — display-only, so no seq
  { type: 'message_image', sessionId: 's1', mime: 'image/png', data: 'aWJs', path: '/tmp/shot.png' },
  // An image that failed to render is still an event — a failure should be visible
  { type: 'message_image', sessionId: 's1', mime: '', data: '', path: '/tmp/big.png', note: 'Image is too large (12MB)' },
  { type: 'activity', sessionId: 's1', activity: 'compacting' },
  // While codex's /review (a dedicated RPC) is running (measured — an enteredReviewMode item)
  { type: 'activity', sessionId: 's1', activity: 'reviewing' },
  { type: 'compaction', sessionId: 's1' },
  { type: 'compaction', sessionId: 's1', failed: true, reason: 'Not enough messages to compact.' },
  { type: 'compaction', sessionId: 's1', before: 25485, after: 3686 },
  { type: 'settings_changed', sessionId: 's1', model: 'gpt-5.3-codex', effort: 'high', verbosity: null },
  // The tool switched by itself (#304) — the host records it without a restart and the screen shows it without a toast
  { type: 'settings_changed', sessionId: 's1', model: 'claude-sonnet-4-6', effort: null, verbosity: null, by: 'tool' },
  // Claude Code's /clear (#304), measured: conversation_reset {trigger: 'clear'}
  { type: 'conversation_reset', sessionId: 's1', seq: 21, trigger: 'clear' },
  { type: 'conversation_reset', sessionId: 's1' },
  // Text the tool wants read (#304) — the measured Claude hook block and Codex configuration warning
  {
    type: 'notice',
    sessionId: 's1',
    seq: 22,
    level: 'warning',
    text: 'UserPromptSubmit operation blocked by hook:\n[node block-hook.mjs]: Prompts containing BLOCKME are not allowed here.',
  },
  { type: 'notice', sessionId: 's1', level: 'warning', text: 'Codex is ignoring 2 unrecognized configuration settings.', oncePerSession: true },
  // The same notice made readable (#342): who speaks, what kind, who acts, a plain explanation and its list
  {
    type: 'notice',
    sessionId: 's1',
    level: 'warning',
    text: 'Codex is ignoring 1 unrecognized configuration setting.\n  user (~/.codex/config.toml): `a.b` is ignored.',
    oncePerSession: true,
    from: 'Codex',
    label: 'config warning',
    audience: 'you',
    summary: 'Codex ignored 1 setting in `~/.codex/config.toml`',
    items: ['a.b'],
    hint: 'Codex already runs without it; removing it from the file only silences this notice.',
  },
  // A marker for a session born from a handoff (#102) — note is never carried in a broadcast, so the shape without it is the golden one
  { type: 'handoff', sessionId: 's1', from: 'Mea' },
  { type: 'history_synced', sessionId: 's1', added: 2 },
  { type: 'session_deleted', sessionId: 's1' },
  // An announcement for a session the host created on its own (#69) — session is a SessionInfo, but the
  // event schema carries it as unknown (so events never depends on commands). The receiving side parses it.
  { type: 'session_created', sessionId: 's-new', session: { id: 's-new', projectId: 'p1', name: 'Worktrees' } },
  { type: 'worktree_merged', sessionId: 's1' },
  // An external app's call finished (M4 A-4) — an app is unique per (project, id), so both are carried. null means a user-folder app
  { type: 'external_app_state_changed', appId: 'notes', projectId: 'p1' },
  { type: 'external_app_state_changed', appId: 'timer', projectId: null },
  // A change caused by a screen — that screen never hears it again (M4 B-5). An unknown caller kind must not fail validation either
  { type: 'external_app_state_changed', appId: 'notes', projectId: 'p1', cause: { kind: 'view', instanceId: 'i-1' } },
  { type: 'external_app_state_changed', appId: 'notes', projectId: 'p1', cause: { kind: 'broker', via: 'x' } },
  // An external app's run history panel changed (M4 D-6) — heard by the run history panel, not a screen
  { type: 'external_app_runs_changed', appId: 'notes', projectId: 'p1' },
  { type: 'external_app_runs_changed', appId: 'timer', projectId: null },
  // The external app list changed (M4 A-8) — carries nothing. The receiving side refetches apps.list
  { type: 'external_apps_changed' },
  // A file in the themes folder changed (#312) — the screen refetches the list
  { type: 'themes_changed' },
  { type: 'external_app_questions_changed' },
  { type: 'project_consents_changed' },
  // A linked machine's link changed state, and what the UI holds about it has to be read again (#82)
  {
    type: 'machine_status',
    machine: { id: 'ubuntu', name: 'Ubuntu server', sshTarget: 'ubuntu', status: 'unreachable', error: 'ssh could not reach ubuntu' },
  },
  { type: 'machine_resync', machineId: 'ubuntu' },
  { type: 'worktree_pr', sessionId: 's1', pr: { number: 7, state: 'merged', url: 'https://github.com/x/y/pull/7' } },
  // A goal announcement (2026-09-07) — both the union-of-both-tools shape and the cleared state (null) are golden
  {
    type: 'goal',
    sessionId: 's1',
    goal: { objective: 'All tests green', status: 'active', iterations: 2, reason: '1 failing', tokenBudget: null, tokensUsed: 300 },
  },
  { type: 'goal', sessionId: 's1', goal: null },
  // A session's background work (#290): the live set, and the tasks that just ended with their status
  {
    type: 'background_tasks',
    sessionId: 's1',
    live: [{ id: 'a1', kind: 'agent', description: 'probe sleeper', parentCallId: 'toolu_a', stopsWithTurn: true, stoppable: true }],
    ended: [{ id: 'b1', kind: 'shell', description: 'sleep 191', status: 'stopped', summary: 'sleep 191' }],
  },
  { type: 'background_tasks', sessionId: 's1', live: [], clearEnded: true },
  // The CLI version a session's process runs (#297), and the installed ones (app-wide, defaults filled in)
  { type: 'agent_version', sessionId: 's1', version: '2.1.289' },
  { type: 'agent_versions', status: {} },
  { type: 'agent_versions', status: { installed: { claude: '2.1.290', codex: null }, autoApply: true, checkedAt: 1791182683464 } },
  { type: 'error', sessionId: 's1', error: { code: 'adapter_crashed', message: 'process exited', retryable: true } },
  /*
   * An event that does not belong to a session (issue #43). It must parse **even without**
   * sessionId — the fact that this app as a whole is out of date is not owned by any conversation.
   *
   * A field with a default must still be readable when omitted. If an old host sends only half
   * of status and a new UI rejects it, checking the version would fail purely because of a
   * version difference.
   */
  // A project event, so there is no sessionId (#34) — the same rule as update_status
  { type: 'fs_changed', projectId: 'p1', dirs: ['', 'src'] },
  { type: 'update_status', status: { current: '0.1.0-beta.2' } },
  {
    type: 'update_status',
    status: {
      current: '0.1.0-beta.2', latest: '0.1.0-beta.3', newer: true, auto: true,
      phase: 'restart_required', error: null, checkedAt: 1755000000000,
    },
  },
]

describe('golden: every v1 event type', () => {
  it.each(GOLDEN_EVENTS_V1.map((e) => [(e as { type: string }).type, e] as const))(
    'parses %s',
    (_type, raw) => {
      const parsed = NormalizedEvent.safeParse(raw)
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
    },
  )

  it('every event type has a fixture (forces a new type to add a golden fixture too)', () => {
    const covered = new Set(GOLDEN_EVENTS_V1.map((e) => (e as { type: string }).type))
    const declared = NormalizedEvent.options.map((o) => o.shape.type.value as string)
    expect([...new Set(declared)].sort()).toEqual([...covered].sort())
  })
})

describe('forward compatibility (docs/protocol.md §4)', () => {
  it('ignores an unknown event type (does not throw)', () => {
    expect(parseEventLenient({ type: 'future_event_from_v2', sessionId: 's1' })).toBeNull()
  })

  it('parses a known event even with an unknown field attached', () => {
    const r = parseEventLenient({ type: 'turn_complete', sessionId: 's1', futureField: 123 })
    expect(r?.type).toBe('turn_complete')
  })

  it('reads a notice level a newer host invented as info, keeping the text (#304)', () => {
    const r = parseEventLenient({ type: 'notice', sessionId: 's1', level: 'suggestion', text: 'Try /compact' })
    expect(r).toMatchObject({ type: 'notice', level: 'info', text: 'Try /compact' })
  })

  it("keeps a readable notice's parts through parsing — the screen draws from what survives it (#342)", () => {
    const raw = GOLDEN_EVENTS_V1.find((e) => (e as { type: string; from?: string }).type === 'notice' && 'from' in (e as object))
    expect(parseEventLenient(raw)).toEqual(raw)
  })

  it('reads a notice audience a newer host invented as absent, keeping the rest (#342)', () => {
    const r = parseEventLenient({ type: 'notice', sessionId: 's1', level: 'warning', text: 'x', from: 'Codex', audience: 'admin' })
    expect(r).toMatchObject({ type: 'notice', text: 'x', from: 'Codex' })
    expect(r && 'audience' in r ? r.audience : undefined).toBeUndefined()
  })

  it('rejects an event missing a required field', () => {
    expect(parseEventLenient({ type: 'message_delta', sessionId: 's1' })).toBeNull()
  })
  /*
   * Events this protocol carried once and no longer does (docs/protocol.md §3.2). A host from before their removal can
   * still send one to a newer window, which drops it the way it drops a type it has never heard of, and goes on.
   */
  it.each([
    // The compiled-in apps' "document changed" (#81), removed with them (#372)
    { type: 'app_state_changed', appId: 'control' },
  ])('drops a retired event an older host may still send: $type', (raw) => {
    expect(parseEventLenient(raw)).toBeNull()
    expect(parseServerFrame({ kind: 'event', seq: 7, event: raw }).success).toBe(false)
  })
})

describe('a tool call leaves the host as its card (#221)', () => {
  it('withoutToolRecord drops a call\'s input and a result\'s output, and nothing else', () => {
    const call = GOLDEN_EVENTS_V1.find((e) => (e as { callId?: string }).callId === 'c2' && (e as { type: string }).type === 'tool_call')
    const result = GOLDEN_EVENTS_V1.find((e) => (e as { callId?: string }).callId === 'c2' && (e as { type: string }).type === 'tool_result')
    expect(withoutToolRecord(NormalizedEvent.parse(call))).toEqual({
      type: 'tool_call', sessionId: 's1', callId: 'c2', summary: { tool: 'Write', title: 'Write: a.ts', readOnly: false, paths: ['a.ts'] },
    })
    expect(withoutToolRecord(NormalizedEvent.parse(result))).toEqual({ type: 'tool_result', sessionId: 's1', callId: 'c2', ok: true, summary: 'wrote' })
    // A turn's structured answer is also called `output`, and it is the answer — it stays
    const answered = NormalizedEvent.parse({ type: 'turn_complete', sessionId: 's1', output: { summary: 'short' } })
    expect(withoutToolRecord(answered)).toEqual(answered)
  })

  it('a subagent\'s tool call and result leave the host as their cards too (#222)', () => {
    const steps = GOLDEN_EVENTS_V1.filter((e) => (e as { type: string }).type === 'subagent_event').map((e) => NormalizedEvent.parse(e))
    expect(steps.map(withoutToolRecord)).toEqual([
      {
        type: 'subagent_event',
        sessionId: 's1',
        parentCallId: 'toolu_agent',
        step: { type: 'tool_call', sessionId: 's1', callId: 'toolu_sub', summary: { tool: 'Bash', title: 'ls', readOnly: false, paths: [] } },
      },
      {
        type: 'subagent_event',
        sessionId: 's1',
        parentCallId: 'toolu_agent',
        stepSeq: 2,
        step: { type: 'tool_result', sessionId: 's1', callId: 'toolu_sub', ok: true, summary: 'a.ts' },
      },
      // Its text is what it said, and leaves as it is
      steps[2],
    ])
  })

  it('a subagent step is ignored by a receiver that does not know the kind, and never parses as the parent\'s tool call', () => {
    const e = NormalizedEvent.parse(GOLDEN_EVENTS_V1.find((x) => (x as { type: string }).type === 'subagent_event'))
    expect(e.type).toBe('subagent_event')
    expect('callId' in e).toBe(false)
  })
})

describe('envelope', () => {
  it('hello / rpc client frames', () => {
    expect(parseClientFrame({ kind: 'hello', token: 't', protocolVersion: PROTOCOL_VERSION }).success).toBe(true)
    expect(parseClientFrame({ kind: 'rpc', id: '1', method: 'agents.send', params: {} }).success).toBe(true)
    expect(parseClientFrame({ kind: 'nope' }).success).toBe(false)
  })

  it('hello_ok / event / res server frames', () => {
    expect(parseServerFrame({ kind: 'hello_ok', protocolVersion: 1, resyncRequired: false, currentSeq: 0 }).success).toBe(true)
    expect(parseServerFrame({ kind: 'event', seq: 1, event: GOLDEN_EVENTS_V1[0] }).success).toBe(true)
    expect(parseServerFrame({ kind: 'res', id: '1', ok: true, result: {} }).success).toBe(true)
    expect(
      parseServerFrame({ kind: 'res', id: '1', ok: false, error: { code: 'internal', message: 'x', retryable: false } })
        .success,
    ).toBe(true)
  })

  it('seq is required on an event push (the basis for reconnect recovery)', () => {
    expect(parseServerFrame({ kind: 'event', event: GOLDEN_EVENTS_V1[0] }).success).toBe(false)
  })
})

/**
 * A tool's presentation used to be a `Record<ToolName, …>` compiled into this package, so the
 * compiler guaranteed every tool had a label and a mark. It is data on the wire now — sent by
 * whichever adapter the host happens to have — and the schema is the only thing left standing
 * between a half-filled descriptor and a screen that draws it.
 */
describe('tool presentation metadata', () => {
  const descriptor = {
    name: 'claude',
    label: 'Claude Code',
    mark: 'C',
    install: 'npm i -g @anthropic-ai/claude-code',
    login: 'claude auth login',
  }

  it('accepts a tool this build has never heard of', () => {
    // The point of opening ToolName: a third adapter must not need an edit here to exist.
    expect(ToolName.safeParse('some-new-agent').success).toBe(true)
  })

  it('refuses a nameless tool', () => {
    // '' is what a missing id degrades into, and it would key a React list and a session row.
    expect(ToolName.safeParse('').success).toBe(false)
  })

  it('refuses a descriptor with no mark', () => {
    // The session chip shows one glyph and nothing else — there is no second place for the
    // name to appear, so a descriptor without a mark draws an empty square in the sidebar.
    const { mark: _mark, ...noMark } = descriptor
    expect(ToolDescriptor.safeParse(descriptor).success).toBe(true)
    expect(ToolDescriptor.safeParse(noMark).success).toBe(false)
  })

  it('refuses a status that is only a detect result', () => {
    // ToolStatus carries both halves so no screen has to join them. A raw detect result —
    // installed/loggedIn/detail with no descriptor — is exactly the shape that join used to
    // take, and it must not pass for the joined one.
    const detected = { name: 'claude', installed: true, loggedIn: true, detail: 'v2.0.0' }
    expect(ToolStatus.safeParse({ ...descriptor, ...detected }).success).toBe(true)
    expect(ToolStatus.safeParse(detected).success).toBe(false)
  })
})

/**
 * A session id is an identifier, not a path (#94).
 *
 * Two commands turn it straight into one: `attachments.save` makes the directory it names, and
 * `agents.deleteSession` removes that directory recursively *without first looking the session
 * up*. Measured before this schema existed, `{ sessionId: '../../Documents' }` answered
 * `{ ok: true }` and the directory two levels above the data folder was gone. The refusal has to
 * live here because this is the one place every caller of every command passes through.
 */
describe('SessionId', () => {
  const del = RpcMethods['agents.deleteSession'].params
  const save = RpcMethods['attachments.save'].params

  it('refuses an id that is a path', () => {
    expect(del.safeParse({ sessionId: '../../Documents' }).success).toBe(false)
    expect(del.safeParse({ sessionId: 'a/b' }).success).toBe(false)
    expect(del.safeParse({ sessionId: '..' }).success).toBe(false)
    // A leading dot is refused outright, which is what makes `..` unspellable rather than
    // merely caught — there is no second rule to keep in step with this one.
    expect(del.safeParse({ sessionId: '.hidden' }).success).toBe(false)
    expect(del.safeParse({ sessionId: '' }).success).toBe(false)
  })

  it('refuses a project id that is a path (#132)', () => {
    // The project id is a path segment too: `<worktree root>/<project id>/<session id>` and the handoff notes folder.
    const create = RpcMethods['agents.createSession'].params
    const ok = { cwd: '/tmp/repo', tool: 'claude', worktree: true }
    expect(create.safeParse({ ...ok, projectId: '../escaped' }).success).toBe(false)
    expect(create.safeParse({ ...ok, projectId: '..' }).success).toBe(false)
    expect(RpcMethods['git.status'].params.safeParse({ projectId: 'a/b' }).success).toBe(false)
    expect(RpcMethods['apps.remove'].params.safeParse({ appId: 'notes', projectId: '../x' }).success).toBe(false)
    expect(RpcMethods['apps.remove'].params.safeParse({ appId: 'notes', projectId: null }).success).toBe(true)
    // Project ids are minted by randomUUID(), like session ids; fixtures use short readable ones
    expect(create.safeParse({ ...ok, projectId: randomUUID() }).success).toBe(true)
    expect(create.safeParse({ ...ok, projectId: 'p1' }).success).toBe(true)
    expect(isProjectId('../escaped')).toBe(false)
    expect(isProjectId(randomUUID())).toBe(true)
  })

  it('accepts the ids we actually mint', () => {
    // Guard against a regex so tight it refuses the app's own traffic: host ids are UUIDs, and
    // tests and fixtures use short readable ones.
    expect(del.safeParse({ sessionId: randomUUID() }).success).toBe(true)
    expect(del.safeParse({ sessionId: 's1' }).success).toBe(true)
    expect(del.safeParse({ sessionId: 'ho-s1' }).success).toBe(true)
  })

  it('refuses an attachment bigger than the cap', () => {
    const ok = { sessionId: 's1', name: 'a.png', mime: 'image/png' }
    expect(save.safeParse({ ...ok, dataBase64: 'AAAA' }).success).toBe(true)
    expect(save.safeParse({ ...ok, dataBase64: 'A'.repeat(ATTACHMENT_MAX_BASE64 + 1) }).success).toBe(false)
  })
})

describe("a session's background tasks (#290)", () => {
  const task = (id: string, extra: Partial<BackgroundTask> = {}): BackgroundTask => ({ id, kind: 'agent', description: id, status: 'running', ...extra })

  it('the live set replaces every running entry, and a task that left without an ending disappears', () => {
    const before = applyBackgroundTasks([], { live: [task('a'), task('b')] })
    expect(before.map((t) => t.id)).toEqual(['a', 'b'])
    expect(applyBackgroundTasks(before, { live: [task('b')] }).map((t) => [t.id, t.status])).toEqual([['b', 'running']])
  })

  it('an ended task stays listed with its status until cleared, and the newest ones are kept', () => {
    let list = applyBackgroundTasks([], { live: [task('a'), task('b')] })
    list = applyBackgroundTasks(list, { live: [task('b')], ended: [task('a', { status: 'stopped' })] })
    list = applyBackgroundTasks(list, { live: [] })
    expect(list.map((t) => [t.id, t.status])).toEqual([['a', 'stopped']])
    // A later ending for the same task replaces it rather than listing it twice
    list = applyBackgroundTasks(list, { live: [], ended: [task('a', { status: 'failed' })] })
    expect(list.map((t) => [t.id, t.status])).toEqual([['a', 'failed']])
    for (let i = 0; i < 12; i++) list = applyBackgroundTasks(list, { live: [], ended: [task('e' + i, { status: 'completed' })] })
    expect(list).toHaveLength(10)
    expect(list.at(-1)?.id).toBe('e11')
    expect(applyBackgroundTasks(list, { live: [task('z')], clearEnded: true }).map((t) => t.id)).toEqual(['z'])
  })

  it('a task back in the live set is running again, not listed as ended too', () => {
    const ended = applyBackgroundTasks([], { live: [], ended: [task('a', { status: 'stopped' })] })
    expect(applyBackgroundTasks(ended, { live: [task('a')] }).map((t) => [t.id, t.status])).toEqual([['a', 'running']])
  })

  it('only running tasks that are activity count — ambient and ended ones do not', () => {
    const list = [task('a'), task('w', { ambient: true }), task('x', { status: 'stopped' })]
    expect(liveBackgroundTasks(list).map((t) => t.id)).toEqual(['a'])
  })

  it('an unknown kind from a newer host reads as other instead of failing the event', () => {
    const e = NormalizedEvent.parse({ type: 'background_tasks', sessionId: 's1', live: [{ id: 'm', kind: 'monitor', description: 'watch' }] })
    expect(e.type === 'background_tasks' && e.live[0]).toMatchObject({ kind: 'other', status: 'running' })
  })
})
