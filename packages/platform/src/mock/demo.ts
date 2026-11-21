/* eslint-disable agent/agent-adapter-checks -- The seeded demo depicts named CLIs, including their sessions and usage fixtures. */
import type { CacheStats } from '@cc/protocol/client'
import type { MockPlatform } from './index.js'

/**
 * A seeded scene to look at by hand (`?demo`): projects, sessions, conversations, git and usage filled in, and an answer
 * when spoken to. Built only through the ports, conversation through `emit`, so it says what e2e and the host say.
 */

/** `?demo=<name>` */
const DEMO_SCENES = ['focus', 'grid'] as const
export type DemoScene = (typeof DEMO_SCENES)[number]

export function isDemoScene(v: string): v is DemoScene {
  return (DEMO_SCENES as readonly string[]).includes(v)
}

/** Also writes the workspace snapshot (the grid's panels): it has to be in the mock before the app reads it */
export async function seedDemo(mock: MockPlatform, scene: DemoScene = 'focus'): Promise<void> {
  installResponder(mock)

  mock.assistantTool = 'claude'

  const centralu = await mock.projects.add('/Users/you/code/centralu')
  const site = await mock.projects.add('/Users/you/code/landing-site')
  // A worktree session needs a trusted project, as on the host (#407, #999)
  await mock.projects.setTrusted(centralu.id, true)

  // The donut needs a weekly window, and shows only for tools `detected` as installed and logged in
  mock.usageState = {
    supported: true,
    usage: {
      plan: 'max',
      windows: [
        { id: 'session', label: '5 hours', percent: 38, resetsAt: null, scope: null },
        { id: 'weekly_all', label: 'Weekly', percent: 61, resetsAt: null, scope: null },
        { id: 'weekly_scoped', label: 'Weekly', percent: 82, resetsAt: null, scope: 'opus' },
      ],
      daily: [],
    },
  }

  mock.gitState = {
    ...mock.gitState,
    files: [
      { path: 'packages/ui/src/features/session/SessionView.tsx', staged: false, status: 'M' },
      { path: 'packages/ui/src/features/session/Composer.tsx', staged: false, status: 'A' },
      { path: 'docs/old-notes.md', staged: false, status: 'D' },
    ],
    diffs: {
      'packages/ui/src/features/session/SessionView.tsx': [
        'diff --git a/SessionView.tsx b/SessionView.tsx',
        '@@ -12,7 +12,7 @@',
        '-  const composerUp = nearComposer',
        '+  const composerUp = nearComposer || overComposer',
        '   return <section>…</section>',
      ].join('\n'),
    },
    commits: [
      {
        sha: 'a1b2c3d4e5f6',
        shortSha: 'a1b2c3d',
        subject: 'Fold the grid composer',
        author: 'you',
        when: Date.now() - 2 * 3600_000,
        parents: [],
      },
      {
        sha: 'e4f5a6b7c8d9',
        shortSha: 'e4f5a6b',
        subject: 'Never send an error code the wire does not know',
        author: 'you',
        when: Date.now() - 26 * 3600_000,
        parents: [],
      },
    ],
    branches: [],
    dirty: [],
    ignored: [],
    pushed: false,
  }

  await mock.projects.setCommands(centralu.id, [
    { command: 'pnpm dev', label: 'Dev server' },
    { command: 'pnpm exec vitest run', label: 'Unit' },
  ])

  // States scattered on purpose: working, waiting for approval, for a question, and asleep, all on screen at once
  const working = await session(mock, centralu.id, 'claude', 'Finish the collapsed composer')
  // A real transcript, long enough to show scroll restoration, virtualization, stacked cards and long markdown
  talk(mock, working.id, [
    ['user', "When the composer rises in the grid, don't let it cover the rainbow ring."],
    ['assistant', "The ring is the panel's border, so it has to sit above the card. Let me check the stacking order first."],
  ])
  tool(mock, working.id, 'demo-a', 'Grep', 'z-index in packages/ui', [
    'packages/ui/src/styles/index.css:118:  z-index: 1;',
    'packages/ui/src/features/session/SessionView.tsx:357:  z-20',
    'packages/ui/src/features/grid/GridView.tsx:238:  z-10',
  ].join('\n'))
  talk(mock, working.id, [
    ['assistant', "The ring is `z-index: 1`, and the collapsed card is `z-20`. The card sits on top, so it clips the ring's bottom edge."],
    ['user', 'So should I raise the ring? Or could you lower the card instead?'],
    [
      'assistant',
      "Lowering the card would let the conversation cover it — when it rises, the card has to sit above the text, so z-20 is the right value there. It's the ring that needs to go up.",
    ],
  ])
  tool(mock, working.id, 'demo-b', 'Edit', 'packages/ui/src/styles/index.css', '1 line changed')
  talk(mock, working.id, [
    ['user', "If it's fixed, measure it and show me. Not just by eye."],
    ['assistant', "I scanned the pixels down the panel's bottom edge to check whether the ring's color breaks anywhere."],
  ])
  tool(
    mock,
    working.id,
    'demo-c',
    'Bash',
    'pnpm exec playwright test -g "rainbow ring"',
    [
      'Running 3 tests using 3 workers',
      '',
      '  ✓  1 e2e/panel.spec.ts:196:1 › the collapsed composer does not cover the ring during a response (612ms)',
      '  ✓  2 e2e/panel.spec.ts:231:1 › the raised composer does not cover the ring either (588ms)',
      '  ✓  3 e2e/control-grid.spec.ts:204:1 › the ring turns off once the response ends (497ms)',
      '',
      '  3 passed (1.4s)',
    ].join('\n'),
  )
  talk(mock, working.id, [
    ['assistant', 'All three pass. I also confirmed the first one fails with the ring removed — so the test really is watching that line.'],
    ['user', 'Good. And can you fetch the resource list one more time?'],
  ])
  // One chunk with no line breaks: checks the collapsed card's height cap by hand
  tool(
    mock,
    working.id,
    'demo-d',
    'mcp__resource__list',
    'resourceList (sprite)',
    JSON.stringify({
      status: { code: 0, message: '' },
      resourceList: Array.from({ length: 12 }, (_, i) => ({
        ruid: `e0665a7978ed49539afab9544eec53${String(i).padStart(2, '0')}`,
        resourceType: 'sprite',
        name: `msa_532_534150${i}_icon_icon_c09af380e8`,
        category: 'sprite',
        subcategory: 'skill',
      })),
    }),
  )
  talk(mock, working.id, [
    ['assistant', '12 came back. The collapsed card stops at three lines; expand it to see the rest.'],
    ['user', 'Now only the bottom corner curve is left, right?'],
  ])
  mock.emit({
    type: 'tool_call',
    sessionId: working.id,
    callId: 'demo-1',
    summary: { tool: 'Read', title: 'packages/ui/src/styles/index.css', paths: [] },
  })
  mock.emit({ type: 'tool_result', sessionId: working.id, callId: 'demo-1', ok: true, summary: 'z-index: 1' })
  mock.emit({
    type: 'message_delta',
    sessionId: working.id,
    role: 'assistant',
    text: "Since it's `z-index: 1`, the collapsed card (z-20) was covering the bottom edge. I'll raise the ring above it.",
  })
  mock.emit({ type: 'context_update', sessionId: working.id, used: 74_000, window: 200_000, exactness: 'exact', compactAt: 120_000 })
  mock.emit({ type: 'state_change', sessionId: working.id, state: 'working' })
  // After the screen attaches: a plan lives only in the reducer, from events, as the host keeps none in SessionInfo
  setTimeout(
    () =>
      mock.emit({
        type: 'plan_update',
        sessionId: working.id,
        steps: [
          { text: "Raise the ring's layer", status: 'completed' },
          { text: "Match the bottom corner's curve to the panel's", status: 'inProgress' },
          { text: 'Check for gaps mid-transition while it rises', status: 'pending' },
        ],
      }),
    400,
  )

  const approving = await session(mock, centralu.id, 'codex', 'Clean up leftover processes')
  talk(mock, approving.id, [['user', 'Run a script that picks out only the orphaned processes and stops them.']])

  const asking = await session(mock, site.id, 'claude', 'Pick the hero copy')
  talk(mock, asking.id, [['user', 'Give me some candidate lines for the landing hero.']])
  mock.emit({
    type: 'question_request',
    sessionId: asking.id,
    requestId: 'demo-question',
    questions: [
      {
        question: 'Which one should we ship?',
        header: 'Hero',
        multiSelect: false,
        options: [
          { label: 'Stop watching. Start steering.', description: 'The one that asks for something' },
          { label: 'Many agents, one window.', description: 'The one that states the feature' },
        ],
      },
    ],
  })

  /*
   * The approval after the question: "next waiting" takes the newest wait, and a same-millisecond tie sorts by session
   * id, the approval's first; raised before, a tick between them put the question on top.
   */
  mock.emit({
    type: 'approval_request',
    sessionId: approving.id,
    requestId: 'demo-approval',
    detail: { kind: 'command', command: 'kill -TERM 40321', cwd: '/Users/you/code/centralu' },
  })

  const done = await session(mock, site.id, 'codex', 'Optimize images')
  talk(mock, done.id, [
    ['user', 'Shrink the size of the images under public/.'],
    ['assistant', 'Converted 7 to webp. 4.2MB total → 890KB.'],
  ])
  mock.emit({ type: 'turn_complete', sessionId: done.id })

  mock.cacheStats = demoCache(
    [
      { sessionId: working.id, name: 'Finish the collapsed composer', write: 1_120_000, causes: { expired: 2, model_change: 1 } },
      { sessionId: asking.id, name: 'Pick the hero copy', write: 540_000, causes: { compaction: 1, expired: 1 } },
    ],
    [
      { sessionId: approving.id, name: 'Clean up leftover processes', input: 260_000 },
      { sessionId: done.id, name: 'Optimize images', input: 150_000 },
    ],
  )

  if (scene === 'grid') {
    const extra = await session(mock, centralu.id, 'claude', 'Put together the release notes')
    // At rest: the mock keeps the host's rules (#428), so "working" would put a second panel mid-response
    talk(mock, extra.id, [['user', "Write release notes from this week's commits."]])
    const panels = [working.id, approving.id, asking.id, extra.id]
    await mock.agents.setGridView(panels.map((sessionId) => ({ kind: 'session' as const, sessionId })))
    // The mock's ids grow from the seed in the same order, so a layout changed by hand survives a reload
    const saved = (await mock.workspace.load()) ?? {}
    await mock.workspace.save({ ...saved, view: 'grid', focusedSessionId: working.id })
  } else {
    const saved = (await mock.workspace.load()) ?? {}
    await mock.workspace.save({ ...saved, view: 'focus', focusedSessionId: working.id })
  }
}

/** Codex reports reads only; counted since before both windows, so they show under their own names */
function demoCache(
  claude: { sessionId: string; name: string; write: number; causes: Record<string, number> }[],
  codex: { sessionId: string; name: string; input: number }[],
): Record<string, CacheStats> {
  const now = Date.now()
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)
  const countingSince = new Date(now - 26 * 3600_000).toISOString()
  const window = (id: string, label: string, since: number, scale: number) => ({ id, label, since: new Date(since).toISOString(), scale })
  const windows = [window('5h', 'last 5 h', now - 5 * 3600_000, 1), window('today', 'today', midnight.getTime(), 2.6)]
  const n = (x: number, scale: number) => Math.round(x * scale)
  return {
    claude: {
      writes: true,
      countingSince,
      windows: windows.map(({ scale, ...w }) => ({
        ...w,
        requests: n(412, scale),
        inputTokens: n(18_400, scale),
        cacheReadTokens: n(31_200_000, scale),
        cacheCreationTokens: n(1_940_000, scale),
        // Rounded per cause first, so the causes add up to the count however the window scales
        rebuilds: n(3, scale) + 3 * n(1, scale),
        rebuildCauses: { expired: n(3, scale), model_change: n(1, scale), compaction: n(1, scale), unknown: n(1, scale) },
        expiredIdleMs: { min: 64 * 60_000, max: 3 * 3600_000 },
        // Price ratios: reads 0.1, writes 1.25 to 2; writes are ~43% of the cost
        rebuildTokens: n(1_020_000, scale),
        cacheReadCost: n(3_120_000, scale),
        cacheWriteCost: n(2_380_000, scale),
        sessions: claude.map((s) => ({
          sessionId: s.sessionId,
          name: s.name,
          requests: n(140, scale),
          inputTokens: n(6_000, scale),
          cacheReadTokens: n(9_800_000, scale),
          cacheCreationTokens: n(s.write, scale),
          rebuilds: Object.values(s.causes).reduce((sum, k) => sum + n(k, scale), 0),
          rebuildTokens: n(Math.round(s.write * 0.6), scale),
          rebuildCauses: Object.fromEntries(Object.entries(s.causes).map(([c, k]) => [c, n(k, scale)])),
        })),
      })),
    },
    codex: {
      writes: false,
      countingSince,
      windows: windows.map(({ scale, ...w }) => ({
        ...w,
        requests: n(96, scale),
        inputTokens: n(410_000, scale),
        cacheReadTokens: n(3_900_000, scale),
        cacheCreationTokens: 0,
        rebuilds: 2 * n(1, scale),
        rebuildCauses: { thread_restart: n(1, scale), probably_expired: n(1, scale) },
        expiredIdleMs: { min: 9 * 60_000, max: 9 * 60_000 },
        sessions: codex.map((s) => ({
          sessionId: s.sessionId,
          name: s.name,
          requests: n(40, scale),
          inputTokens: n(s.input, scale),
          cacheReadTokens: n(1_600_000, scale),
          cacheCreationTokens: 0,
          rebuilds: 0,
        })),
      })),
    },
  }
}

async function session(mock: MockPlatform, projectId: string, tool: 'claude' | 'codex', name: string) {
  const info = await mock.agents.createSession({ projectId, cwd: '', tool, permissionPreset: 'normal' })
  await mock.agents.rename(info.id, name)
  return info
}

function tool(
  mock: MockPlatform,
  sessionId: string,
  callId: string,
  name: string,
  title: string,
  result: string,
): void {
  mock.emit({ type: 'tool_call', sessionId, callId, summary: { tool: name, title, paths: [] } })
  mock.emit({ type: 'tool_result', sessionId, callId, ok: true, summary: result })
}

/** As events: the path they take from the host */
function talk(mock: MockPlatform, sessionId: string, lines: ['user' | 'assistant', string][]): void {
  for (const [role, text] of lines) {
    if (role === 'user') mock.emit({ type: 'user_message', sessionId, seq: 0, text })
    else mock.emit({ type: 'message_delta', sessionId, role: 'assistant', text })
  }
}

/**
 * The mock's `send` only flips the state to working (e2e feeds the answer itself); here a short script answers: think,
 * one tool call, a few chunks, done.
 */
function installResponder(mock: MockPlatform): void {
  const original = mock.agents.send.bind(mock.agents)
  mock.agents.send = async (sessionId, text, attachments) => {
    await original(sessionId, text, attachments)
    const steps: [number, () => void][] = [
      [300, () => mock.emit({ type: 'activity', sessionId, activity: null })],
      [
        600,
        () =>
          mock.emit({
            type: 'tool_call',
            sessionId,
            callId: `demo-${Date.now()}`,
            summary: { tool: 'Grep', title: text.slice(0, 40) || 'search', paths: [] },
          }),
      ],
      [
        1100,
        () =>
          mock.emit({
            type: 'message_delta',
            sessionId,
            role: 'assistant',
            text: `"${text.slice(0, 60)}" — this is a demo mock, so nothing actually happens here. `,
          }),
      ],
      [
        1500,
        () =>
          mock.emit({
            type: 'message_delta',
            sessionId,
            role: 'assistant',
            text: 'But everything the screen does is real: the streaming, the tool card, right down to the flourish when it finishes.',
          }),
      ],
      [1900, () => mock.emit({ type: 'turn_complete', sessionId })],
    ]
    for (const [at, run] of steps) setTimeout(run, at)
  }
  // An answer does not end the turn, as on the host (#999): the demo's agent ends it after a line
  const answer = mock.agents.respondApproval.bind(mock.agents)
  mock.agents.respondApproval = async (sessionId, requestId, decision, scope, matcher) => {
    const asked = mock.sessions.get(sessionId)?.pendingApproval?.requestId === requestId
    await answer(sessionId, requestId, decision, scope, matcher)
    if (!asked || requestId.startsWith('cap-')) return
    const line = decision === 'deny' ? 'Understood — I left that alone.' : 'Done — that went through.'
    setTimeout(() => mock.emit({ type: 'message_delta', sessionId, role: 'assistant', text: line }), 400)
    setTimeout(() => mock.emit({ type: 'turn_complete', sessionId }), 800)
  }
}
