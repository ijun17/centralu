import type { NormalizedEvent } from '@cc/protocol'
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
    { command: 'pnpm dev', label: '데브 서버' },
    { command: 'pnpm exec vitest run', label: '유닛' },
  ])

  /*
   * The sessions. Their states are deliberately scattered — working (rainbow ring), waiting
   * for approval, waiting for a question, and asleep all need to be on screen together for
   * the sidebar, inbox and grid to show what they actually do.
   */
  const working = await session(mock, centralu.id, 'claude', '접힌 입력창 마무리')
  /*
   * The conversation is long **enough to scroll** (requested by the person, 2026-09-12).
   *
   * There are several things a two-line scene cannot show by hand: scroll restoration when
   * paging up, virtualization, the density of stacked collapsed tool cards, how markdown
   * renders inside a long answer. So a whole real dogfooding transcript is moved in wholesale
   * — closer to what this app actually receives than padding it out with made-up chatter.
   */
  talk(mock, working.id, [
    ['user', '그리드에서 입력창이 떠오를 때 무지개 링을 덮지 않게 해줘.'],
    ['assistant', '링은 칸의 테두리라 카드보다 위에 서야 합니다. 층 순서를 먼저 재보겠습니다.'],
  ])
  tool(mock, working.id, 'demo-a', 'Grep', 'z-index in packages/ui', [
    'packages/ui/src/styles/index.css:118:  z-index: 1;',
    'packages/ui/src/features/session/SessionView.tsx:357:  z-20',
    'packages/ui/src/features/grid/GridView.tsx:238:  z-10',
  ].join('\n'))
  talk(mock, working.id, [
    ['assistant', '링이 `z-index: 1`, 접힌 카드가 `z-20`입니다. 카드가 위에 서 있으니 아랫변이 카드에 잘립니다.'],
    ['user', '그럼 링을 올리면 되나? 카드를 내리면 안 되고?'],
    [
      'assistant',
      '카드를 내리면 대화가 카드를 덮습니다 — 카드는 떠오를 때 글 위로 올라와야 하니 z-20은 그 자리의 값입니다. 올려야 하는 쪽은 링입니다.',
    ],
  ])
  tool(mock, working.id, 'demo-b', 'Edit', 'packages/ui/src/styles/index.css', '1 line changed')
  talk(mock, working.id, [
    ['user', '고쳤으면 재서 보여줘. 눈으로 말고.'],
    ['assistant', '칸 아랫변의 픽셀을 세로로 훑어서 링 색이 끊기는 줄이 있는지 봤습니다.'],
  ])
  tool(
    mock,
    working.id,
    'demo-c',
    'Bash',
    'pnpm exec playwright test -g "무지개 링"',
    [
      'Running 3 tests using 3 workers',
      '',
      '  ✓  1 e2e/panel.spec.ts:196:1 › 접힌 입력창은 응답 중 링을 덮지 않는다 (612ms)',
      '  ✓  2 e2e/panel.spec.ts:231:1 › 떠오른 입력창도 링을 덮지 않는다 (588ms)',
      '  ✓  3 e2e/control-loop.spec.ts:1204:1 › 응답이 끝나면 링이 꺼진다 (497ms)',
      '',
      '  3 passed (1.4s)',
    ].join('\n'),
  )
  talk(mock, working.id, [
    ['assistant', '세 개 다 통과합니다. 링을 빼고 돌리면 첫 번째가 떨어지는 것도 확인했습니다 — 테스트가 진짜로 그 줄을 보고 있습니다.'],
    ['user', '좋아. 그리고 리소스 목록 한 번 더 불러와 줄래?'],
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
    ['assistant', '12개가 왔습니다. 접힌 카드는 세 줄에서 멈추고, 나머지는 펼쳐서 봅니다.'],
    ['user', '이제 아래 모서리 곡선만 남았지?'],
  ])
  mock.emit({
    type: 'tool_call',
    sessionId: working.id,
    callId: 'demo-1',
    summary: { tool: 'Read', title: 'packages/ui/src/styles/index.css', readOnly: true, paths: [] },
  })
  mock.emit({ type: 'tool_result', sessionId: working.id, callId: 'demo-1', ok: true, summary: 'z-index: 1' })
  mock.emit({
    type: 'message_delta',
    sessionId: working.id,
    role: 'assistant',
    text: '`z-index: 1`이라 접힌 카드(z-20)가 아랫변을 덮고 있었습니다. 링을 위로 올리겠습니다.',
  })
  mock.emit({ type: 'context_update', sessionId: working.id, used: 74_000, window: 200_000, exactness: 'exact' })
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
          { text: '링의 층을 올린다', status: 'completed' },
          { text: '아래 모서리를 칸과 같은 곡선으로', status: 'inProgress' },
          { text: '떠오르는 동안 중간 자리들이 있는지 잰다', status: 'pending' },
        ],
      }),
    400,
  )

  const approving = await session(mock, centralu.id, 'codex', '남은 프로세스 정리')
  talk(mock, approving.id, [['user', '고아 프로세스만 골라서 멈추는 스크립트를 돌려줘.']])
  mock.emit({
    type: 'approval_request',
    sessionId: approving.id,
    requestId: 'demo-approval',
    detail: { kind: 'command', command: 'kill -TERM 40321', cwd: '/Users/you/code/centralu' },
  })

  const asking = await session(mock, site.id, 'claude', '히어로 카피 고르기')
  talk(mock, asking.id, [['user', '랜딩 히어로 문구 후보 좀 줘.']])
  mock.emit({
    type: 'question_request',
    sessionId: asking.id,
    requestId: 'demo-question',
    questions: [
      {
        question: '어느 쪽 문장으로 갈까요?',
        header: '히어로',
        multiSelect: false,
        options: [
          { label: '지켜보지 말고 조종하세요', description: '행동을 부르는 쪽' },
          { label: '에이전트 여럿, 화면 하나', description: '기능을 말하는 쪽' },
        ],
      },
    ],
  } as NormalizedEvent)

  const done = await session(mock, site.id, 'codex', '이미지 최적화')
  talk(mock, done.id, [
    ['user', 'public/ 밑 이미지들 용량 줄여줘.'],
    ['assistant', '7개를 webp로 바꿨습니다. 합계 4.2MB → 890KB.'],
  ])
  mock.emit({ type: 'turn_complete', sessionId: done.id })

  if (scene === 'grid') {
    // The grid scene's purpose is the screen with several panels — collapsing, the ring, and reading space all show up here
    const extra = await session(mock, centralu.id, 'claude', '릴리스 노트 정리')
    talk(mock, extra.id, [['user', '이번 주 커밋으로 릴리스 노트 써줘.']])
    mock.emit({ type: 'state_change', sessionId: extra.id, state: 'working' })
    const panels = [working.id, approving.id, asking.id, extra.id]
    await mock.agents.setGridView(panels)
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
    summary: { tool: 'Grep', title: 'isRetryable( across src', readOnly: true, paths: [] },
  })
  mock.emit({ type: 'tool_result', sessionId: working.id, callId: 'shot-1', ok: true, summary: '3 files' })
  mock.emit({
    type: 'message_delta',
    sessionId: working.id,
    role: 'assistant',
    text: 'Three callers. Two are in the billing path and one is in a script that has not run since March.',
  })
  mock.emit({ type: 'context_update', sessionId: working.id, used: 74_000, window: 200_000, exactness: 'exact' })
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
  } as NormalizedEvent)

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
  await mock.agents.setGridView([working.id, approving.id, asking.id, done.id])
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
  mock.emit({ type: 'tool_call', sessionId, callId, summary: { tool: name, title, readOnly: true, paths: [] } })
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
            summary: { tool: 'Grep', title: text.slice(0, 40) || 'search', readOnly: true, paths: [] },
          }),
      ],
      [
        1100,
        () =>
          mock.emit({
            type: 'message_delta',
            sessionId,
            role: 'assistant',
            text: `“${text.slice(0, 60)}” — 데모 목이라 진짜로 하지는 않습니다. `,
          }),
      ],
      [
        1500,
        () =>
          mock.emit({
            type: 'message_delta',
            sessionId,
            role: 'assistant',
            text: '대신 화면이 도는 것은 전부 진짜입니다: 스트리밍·툴 카드·끝났을 때의 바람까지.',
          }),
      ],
      [1900, () => mock.emit({ type: 'turn_complete', sessionId })],
    ]
    for (const [at, run] of steps) setTimeout(run, at)
  }
}
