/* eslint-disable agent/agent-adapter-checks -- The seeded demo depicts named CLIs, including their sessions and usage fixtures. */
import type { CacheStats } from '@cc/protocol/client'
import type { MockPlatform } from './index.js'

/**
 * A screen meant to be looked at by hand (requested by the person, 2026-09-10).
 *
 * The mock (MockPlatform) exists so that e2e can drive it **programmatically**, so opening it
 * as a person just gives an empty shell: it takes picking a folder on the intro screen,
 * creating a session and typing before even one line stands, and an answer never actually
 * arrives (the mock's `send` only flips the state to working). While fixing the UI, a reload
 * on every save meant redoing that setup every time.
 *
 * So instead, **we lay down a scene.** The moment it opens, projects, sessions, conversations,
 * git and usage are already filled in, and saying something gets an answer flowing. The same
 * scene grows back from the seed even after a reload.
 *
 * One rule: **build it only through the public doors (the ports).** Reaching directly into
 * internal data structures would split the mock's contract from the scene, and then what is
 * seen here would say something different from e2e and from the real thing. Conversation
 * content goes in through `emit` — the exact path events take from the real thing.
 */

/** The scenes that exist right now. `?demo=<name>` */
export const DEMO_SCENES = ['focus', 'grid', 'empty', 'shot'] as const
export type DemoScene = (typeof DEMO_SCENES)[number]

export function isDemoScene(v: string): v is DemoScene {
  return (DEMO_SCENES as readonly string[]).includes(v)
}

/**
 * Lays down a scene, and makes it answer when spoken to.
 *
 * What it returns are **the things to lay onto the workspace snapshot** (which panels the
 * grid should show, and so on). Since these have to be in the mock before the app reads the
 * snapshot, they are decided here rather than by the caller.
 */
export async function seedDemo(mock: MockPlatform, scene: DemoScene = 'focus'): Promise<void> {
  installResponder(mock)
  if (scene === 'empty') return
  if (scene === 'shot') return seedShot(mock)

  // Skips the intro screen — the point of the scene is the screen after it
  mock.orchestratorTool = 'claude'

  const centralu = await mock.projects.add('/Users/you/code/centralu')
  const site = await mock.projects.add('/Users/you/code/landing-site')
  /*
   * The project the scene works in has been trusted, as one a person works in would be: a worktree session needs a
   * trusted project, as on the host (#407, #999). The landing site stays as newly added.
   */
  await mock.projects.setTrusted(centralu.id, true)

  /*
   * Usage — the donut needs a weekly window to show up. Leaves both tools logged in
   * (`detected` is what decides that — the dashboard only shows a donut for installed and
   * logged-in tools).
   */
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

  // Git — so the sidebar's change count and the evidence panel's changes/history tabs do not stand empty
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

  /*
   * The sessions. Their states are deliberately scattered — working (rainbow ring), waiting
   * for approval, waiting for a question, and asleep all need to be on screen together for
   * the sidebar, inbox and grid to show what they actually do.
   */
  const working = await session(mock, centralu.id, 'claude', 'Finish the collapsed composer')
  /*
   * The conversation is long **enough to scroll** (requested by the person, 2026-09-12).
   *
   * There are several things a two-line scene cannot show by hand: scroll restoration when
   * paging up, virtualization, the density of stacked collapsed tool cards, how markdown
   * renders inside a long answer. So a whole real dogfooding transcript is moved in wholesale
   * — closer to what this app actually receives than padding it out with made-up chatter.
   */
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
  /*
   * One chunk with no line breaks — the place to check by hand whether the collapsed card's
   * **height cap** is doing its job. Without the cap, this single line covers the whole
   * screen (pointed out by the person, 2026-09-12).
   */
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
  /*
   * The plan checklist is sent **after the screen has attached**.
   *
   * A plan does not stay in the session list — the real thing (the host) does not write it
   * into SessionInfo either; it is a fact that lives only while a turn runs, so the UI's
   * reducer holds it from events. So firing it before anything is drawn means nobody is
   * listening. The mock does not keep it around just for itself, since that would show a
   * screen the real thing does not have.
   */
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
  mock.emit({
    type: 'approval_request',
    sessionId: approving.id,
    requestId: 'demo-approval',
    detail: { kind: 'command', command: 'kill -TERM 40321', cwd: '/Users/you/code/centralu' },
  })

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
    // The grid scene's purpose is the screen with several panels — collapsing, the ring, and reading space all show up here
    const extra = await session(mock, centralu.id, 'claude', 'Put together the release notes')
    /*
     * Left at rest, as the scene has always shown it: the mock's list used to ignore a state_change, so the
     * "working" said here never reached the screen. Now that the mock keeps the host's rules (#428), saying it would
     * put a second panel mid-response.
     */
    talk(mock, extra.id, [['user', "Write release notes from this week's commits."]])
    const panels = [working.id, approving.id, asking.id, extra.id]
    await mock.agents.setGridView(panels.map((sessionId) => ({ kind: 'session' as const, sessionId })))
    /*
     * If the scene's name is `grid`, opens it in grid view. The way of looking belongs to the
     * workspace snapshot, so it is written here — since the mock's ids grow in the same order
     * from the seed and **stay the same across a reload**, a layout the person changed by hand
     * also survives into the next load.
     */
    const saved = (await mock.workspace.load()) ?? {}
    await mock.workspace.save({ ...saved, view: 'grid', focusedSessionId: working.id })
  } else {
    const saved = (await mock.workspace.load()) ?? {}
    await mock.workspace.save({ ...saved, view: 'focus', focusedSessionId: working.id })
  }
}

/**
 * The prompt cache the gauge's dropdown shows: a Claude that mostly hits and rebuilt a few times, a Codex that reports
 * reads only. Counted since well before both windows, so they show under their own names.
 */
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
        // What the rebuilds wrote, and the cache cost weighted by the price ratios (reads 0.1, writes 1.25 to 2): writes are ~43% of it
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

/**
 * The one shot to put in the README (`?demo=shot`).
 *
 * Kept separate from the `focus` scene for two reasons. One is **language** — putting a
 * screen with Korean conversation into an English README makes the reader look at the letters
 * before the product. The other is **focus**. `focus` is a scene built for fixing the UI by
 * hand, so it leaves a working session open, but the scene the README has to sell is "there is
 * one thing waiting for approval, and it is clear which one." So this one starts with **the
 * approval-waiting session open**.
 *
 * The conversations are entirely made up. Moving in a real dogfooding transcript would bring
 * along people's names and someone else's repository along with it (requested by the person,
 * 2026-09-17).
 */
async function seedShot(mock: MockPlatform): Promise<void> {
  mock.orchestratorTool = 'claude'

  const api = await mock.projects.add('/Users/you/code/payments-api')
  const site = await mock.projects.add('/Users/you/code/marketing-site')

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
      { path: 'src/billing/retry.ts', staged: false, status: 'M' },
      { path: 'src/billing/retry.test.ts', staged: false, status: 'A' },
      { path: 'docs/legacy-retries.md', staged: false, status: 'D' },
    ],
    diffs: {
      'src/billing/retry.ts': [
        'diff --git a/src/billing/retry.ts b/src/billing/retry.ts',
        '@@ -8,7 +8,7 @@',
        "-const RETRYABLE = [408, 402, 429, 500, 502, 503]",
        "+const RETRYABLE = [408, 429, 500, 502, 503]",
        '   return RETRYABLE.includes(status)',
      ].join('\n'),
    },
    commits: [
      {
        sha: 'a1b2c3d4e5f6',
        shortSha: 'a1b2c3d',
        subject: 'A declined card is not a temporary failure',
        author: 'you',
        when: Date.now() - 2 * 3600_000,
        parents: [],
      },
      {
        sha: 'e4f5a6b7c8d9',
        shortSha: 'e4f5a6b',
        subject: 'Name the window the retry budget belongs to',
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

  await mock.projects.setCommands(api.id, [
    { command: 'pnpm dev', label: 'Dev server' },
    { command: 'pnpm exec vitest run', label: 'Unit' },
  ])

  // A working session — the sidebar needs one thing spinning for "working right now" to be visible
  const working = await session(mock, api.id, 'claude', 'Cap the charge retries')
  talk(mock, working.id, [
    ['user', 'Declined charges retry forever. Put a ceiling on it.'],
    ['assistant', 'The policy has no ceiling, so the loop only ends when the card succeeds. Let me find where retryable is decided.'],
  ])
  tool(mock, working.id, 'shot-a', 'Grep', 'RETRYABLE in src/billing', [
    'src/billing/retry.ts:8:const RETRYABLE = [408, 402, 429, 500, 502, 503]',
    'src/billing/charge.ts:44:  while (isRetryable(res.status)) {',
  ].join('\n'))
  talk(mock, working.id, [
    ['assistant', '402 is on the retryable list. A declined card is not a transient failure, so it should never have been.'],
    ['user', 'Take it off, and cap whatever is left at five.'],
  ])
  tool(mock, working.id, 'shot-b', 'Edit', 'src/billing/retry.ts', '2 lines changed')
  talk(mock, working.id, [['user', 'Prove it. Not by reading it back to me.']])
  tool(
    mock,
    working.id,
    'shot-c',
    'Bash',
    'pnpm exec vitest run billing',
    [
      'Running 4 tests',
      '',
      '  \u2713  a declined card is not retried (18ms)',
      '  \u2713  a 429 is retried (12ms)',
      '  \u2713  retries stop at five (9ms)',
      '  \u2713  the budget is per charge, not per process (11ms)',
      '',
      '  4 passed (312ms)',
    ].join('\n'),
  )
  talk(mock, working.id, [
    ['assistant', 'Four pass. With the cap removed the first one fails, so the test is watching the line it claims to.'],
    ['user', 'Good. Now check nothing else calls the old helper.'],
  ])
  mock.emit({
    type: 'tool_call',
    sessionId: working.id,
    callId: 'shot-1',
    summary: { tool: 'Grep', title: 'isRetryable( across src', paths: [] },
  })
  mock.emit({ type: 'tool_result', sessionId: working.id, callId: 'shot-1', ok: true, summary: '3 files' })
  mock.emit({
    type: 'message_delta',
    sessionId: working.id,
    role: 'assistant',
    text: 'Three callers. Two are in the billing path and one is in a script that has not run since March.',
  })
  mock.emit({ type: 'context_update', sessionId: working.id, used: 74_000, window: 200_000, exactness: 'exact', compactAt: 120_000 })
  mock.emit({ type: 'state_change', sessionId: working.id, state: 'working' })

  /*
   * Waiting for approval — this session is left open because it is the scene the README has
   * to sell.
   *
   * The command is chosen to be **dangerous at a glance**. In a single screenshot, "why does a
   * person need to see this" has to come across with no explanation, and `--force` is the spot
   * where any developer would flinch.
   */
  const approving = await session(mock, api.id, 'codex', 'Land the release branch')
  talk(mock, approving.id, [
    ['user', 'Squash my branch onto main and put it up.'],
    ['assistant', 'There are nine commits on `release/retry-cap`. I will squash them and rebase onto main before pushing.'],
  ])
  tool(mock, approving.id, 'shot-d', 'Bash', 'git log --oneline main..release/retry-cap', [
    '9f2c1ab A declined card is not a temporary failure',
    '77ae310 Cap the retries at five',
    'b0d4e92 Name the window the retry budget belongs to',
    'c31f008 Test: a 429 is still retried',
    '5ad7712 Test: the budget is per charge',
    'fe90b41 Drop the note about legacy retries',
  ].join('\n'))
  talk(mock, approving.id, [
    ['assistant', 'Two of the nine only touch the test file. The squashed message should say what changed in billing, not that tests moved around.'],
    ['user', 'Use the first commit message and drop the rest.'],
  ])
  tool(
    mock,
    approving.id,
    'shot-e',
    'Bash',
    'git rebase -i --autosquash main',
    'Successfully rebased and updated refs/heads/release/retry-cap.',
  )
  talk(mock, approving.id, [
    ['assistant', 'Rebased onto main as one commit. main moved while I was working, so the push will not fast-forward.'],
  ])
  mock.emit({
    type: 'approval_request',
    sessionId: approving.id,
    requestId: 'shot-approval',
    detail: { kind: 'command', command: 'git push --force origin main', cwd: '/Users/you/code/payments-api' },
  })

  // Waiting for a question — needs a different kind of waiting alongside approval for the inbox to show what it is counting
  const asking = await session(mock, site.id, 'claude', 'Hero line')
  talk(mock, asking.id, [
    ['user', 'The hero line is doing nothing. Give me two directions.'],
    ['assistant', 'Let me see what the page already claims before I write over it.'],
  ])
  tool(mock, asking.id, 'shot-f', 'Read', 'src/pages/index.astro', 'hero, features, pricing')
  talk(mock, asking.id, [
    ['assistant', 'The section under it already lists the features, so the line above should not list them again.'],
  ])
  mock.emit({
    type: 'question_request',
    sessionId: asking.id,
    requestId: 'shot-question',
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

  // A finished one — "waiting" and "done and quiet" need to look different
  const done = await session(mock, site.id, 'codex', 'Shrink the hero images')
  talk(mock, done.id, [
    ['user', 'The hero images are 4 MB. Convert everything under public/ to webp.'],
    ['assistant', 'Seven files. I will keep the originals next to them so nothing breaks if a browser refuses webp.'],
  ])
  tool(mock, done.id, 'shot-g', 'Bash', 'cwebp -q 82 public/*.png', [
    'public/hero.png       2.1 MB -> 402 KB',
    'public/screenshot.png 1.2 MB -> 231 KB',
    'public/logo-wide.png  418 KB -> 88 KB',
  ].join('\n'))
  talk(mock, done.id, [
    ['assistant', 'Converted 7 files. 4.2 MB down to 890 KB, and the largest one dropped the most.'],
    ['user', 'Did the markup change?'],
    ['assistant', 'One line. The `<picture>` element now lists webp first and falls back to the png.'],
  ])
  mock.emit({ type: 'turn_complete', sessionId: done.id })

  /*
   * Opens in grid view.
   *
   * Opening in focus would read the approval card large, but shrink the other three to a
   * single line in the sidebar. What this app sells is "several things are each in a
   * different state, and it is visible which one is waiting on me", and the screen where that
   * sentence holds true is the one with several panels. The grid is also **the place a tool
   * screen will land** (the person, 2026-09-17) — what is being set up now explains that spot
   * later.
   *
   * The panel order is left mixed by state: working, waiting for approval, waiting for a
   * question, done.
   */
  await mock.agents.setGridView([working.id, approving.id, asking.id, done.id].map((sessionId) => ({ kind: 'session' as const, sessionId })))
  const saved = (await mock.workspace.load()) ?? {}
  await mock.workspace.save({ ...saved, view: 'grid', focusedSessionId: approving.id })
}

/** One session — creates it, and returns the id so the screen can pick it */
async function session(mock: MockPlatform, projectId: string, tool: 'claude' | 'codex', name: string) {
  const info = await mock.agents.createSession({ projectId, cwd: '', tool, permissionPreset: 'normal' })
  await mock.agents.rename(info.id, name)
  return info
}

/** One past tool call — the call and its result are a pair, so they are bundled here */
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

/** A few lines of past conversation — sent in as events (the exact path they come by in the real thing) */
function talk(mock: MockPlatform, sessionId: string, lines: ['user' | 'assistant', string][]): void {
  for (const [role, text] of lines) {
    if (role === 'user') mock.emit({ type: 'user_message', sessionId, seq: 0, text })
    else mock.emit({ type: 'message_delta', sessionId, role: 'assistant', text })
  }
}

/**
 * An answer arrives when someone says something.
 *
 * The mock's `send` only flips the state to working — that is right for e2e (the test feeds in
 * the answer itself). On a screen a person is watching, that would only ever look like "a
 * session running forever," so a **short script** is layered on here: pretend to think → one
 * tool call → a few chunks of an answer → done. The composer collapsing, the rainbow ring, the
 * flourish on finishing, and marking as read all actually move through this one cycle.
 */
function installResponder(mock: MockPlatform): void {
  const original = mock.agents.send.bind(mock.agents)
  mock.agents.send = async (sessionId, text, attachments, intent) => {
    await original(sessionId, text, attachments, intent)
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
  /*
   * An answer lets the agent go on, as the host's does (#999): it no longer ends the turn by itself. The demo's agent
   * finishes the call it asked about with a line and ends its turn, so an approved card does not leave it working forever.
   */
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
