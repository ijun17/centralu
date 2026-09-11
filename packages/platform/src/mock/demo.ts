import type { NormalizedEvent } from '@cc/protocol'
import type { MockPlatform } from './index.js'

/**
 * 손으로 보는 화면 (사용자 요청 2026-09-10).
 *
 * 목(MockPlatform)은 E2E가 **프로그램으로** 조종하라고 만든 것이라, 사람이 그냥 열면
 * 아무것도 없다: 소개 화면에서 폴더를 고르고 세션을 만들고 타이핑해야 겨우 한 줄이 서고,
 * 답은 영영 오지 않는다(목의 `send`는 상태만 working으로 바꾼다). UI를 고치는 동안
 * 저장할 때마다 리로드되면 그 셋업을 매번 다시 해야 했다.
 *
 * 그래서 **씬을 깐다.** 열자마자 프로젝트·세션·대화·깃·사용량이 채워져 있고, 말을 걸면
 * 답이 흐른다. 리로드해도 씨앗에서 같은 씬이 다시 자란다.
 *
 * 규칙 하나: **공개된 문(포트)으로만 만든다.** 내부 자료구조에 직접 손을 넣으면 목의
 * 계약과 씬이 갈라지고, 그러면 여기서 본 화면이 E2E·실물과 다른 것을 말하게 된다.
 * 대화 내용은 `emit`으로 넣는다 — 실물에서 이벤트가 오는 그 길 그대로다.
 */

/** 지금 있는 씬들. `?demo=<이름>` */
export const DEMO_SCENES = ['focus', 'grid', 'empty'] as const
export type DemoScene = (typeof DEMO_SCENES)[number]

export function isDemoScene(v: string): v is DemoScene {
  return (DEMO_SCENES as readonly string[]).includes(v)
}

/**
 * 씬을 깔고, 말을 걸면 답하게 만든다.
 *
 * 돌려주는 것은 **workspace 스냅샷에 얹을 것들**이다 (그리드에 어느 칸을 세울지 등).
 * 앱이 스냅샷을 읽기 전에 목에 넣어 둬야 해서, 부르는 쪽이 아니라 여기서 정한다.
 */
export async function seedDemo(mock: MockPlatform, scene: DemoScene = 'focus'): Promise<void> {
  installResponder(mock)
  if (scene === 'empty') return

  // 소개 화면을 건너뛴다 — 씬의 목적은 그 다음 화면이다
  mock.orchestratorTool = 'claude'

  const centralu = await mock.projects.add('/Users/you/code/centralu')
  const site = await mock.projects.add('/Users/you/code/landing-site')

  /*
   * 사용량 — 도넛이 뜨려면 주간 창이 있어야 한다. 두 도구 다 로그인된 상태로 둔다
   * (`detected`가 그 판정이다 — 계기판은 설치+로그인만 도넛으로 세운다).
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

  // 깃 — 사이드바의 변경 수, 증거 패널의 변경·기록 탭이 빈 채로 서지 않게
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
   * 세션들. 상태를 일부러 흩뿌린다 — 응답 중(무지개 링)·승인 대기·질문 대기·잠든 것이
   * 한 화면에 같이 있어야 사이드바·인박스·그리드가 실제로 하는 일이 보인다.
   */
  const working = await session(mock, centralu.id, 'claude', '접힌 입력창 마무리')
  /*
   * 대화는 **스크롤이 생길 만큼** 길다 (사용자 요청 2026-09-12).
   *
   * 두 줄짜리 씬으로는 손으로 볼 수 없는 것이 여럿이다: 위로 올라갈 때의 스크롤 복원,
   * 가상화, 접힌 도구 카드가 쌓였을 때의 밀도, 긴 답 안에서 마크다운이 서는 모양.
   * 그래서 실제 도그푸딩 한 자리를 통째로 옮겨 놓는다 — 지어낸 잡담을 늘리는 것보다
   * 이 앱이 실제로 받는 화면에 가깝다.
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
   * 줄바꿈이 없는 한 덩어리 — 접힌 카드의 **높이 상한**이 일하는지 손으로 보는 자리다.
   * 상한이 없으면 이 한 줄이 화면을 통째로 덮는다 (사용자 지적 2026-09-12).
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
   * 계획 체크리스트는 **화면이 붙은 뒤에** 흘린다.
   *
   * 계획은 세션 목록에 남지 않는다 — 실물(host)도 SessionInfo에 안 적고, 도는 동안만
   * 사는 사실이라 UI의 리듀서가 이벤트로 들고 있다. 그래서 그리기 전에 쏘면 아무도 안
   * 듣는다. 목이 여기서만 남겨 주면 그건 실물에 없는 화면을 보여주는 것이므로 안 한다.
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
    // 그리드 씬은 칸이 여럿일 때의 화면이 목적이다 — 접힘·링·읽는 공간이 여기서 보인다
    const extra = await session(mock, centralu.id, 'claude', '릴리스 노트 정리')
    talk(mock, extra.id, [['user', '이번 주 커밋으로 릴리스 노트 써줘.']])
    mock.emit({ type: 'state_change', sessionId: extra.id, state: 'working' })
    const panels = [working.id, approving.id, asking.id, extra.id]
    await mock.agents.setGridView(panels)
    /*
     * 씬의 이름이 `grid`면 그리드로 연다. 보는 방식은 작업공간 스냅샷의 것이라 여기서
     * 적어 둔다 — 목의 id는 씨앗이 같은 순서로 자라 **리로드해도 같으므로**, 사람이
     * 손으로 바꾼 배치도 다음 로드에서 그대로 살아난다.
     */
    const saved = (await mock.workspace.load()) ?? {}
    await mock.workspace.save({ ...saved, view: 'grid', focusedSessionId: working.id })
  } else {
    const saved = (await mock.workspace.load()) ?? {}
    await mock.workspace.save({ ...saved, view: 'focus', focusedSessionId: working.id })
  }
}

/** 세션 하나 — 만들고, 화면이 고를 수 있게 id를 돌려준다 */
async function session(mock: MockPlatform, projectId: string, tool: 'claude' | 'codex', name: string) {
  const info = await mock.agents.createSession({ projectId, cwd: '', tool, permissionPreset: 'normal' })
  await mock.agents.rename(info.id, name)
  return info
}

/** 지난 도구 한 번 — 부름과 결과가 한 쌍이라 여기서 묶는다 */
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

/** 지난 대화 몇 줄 — 이벤트로 넣는다 (실물에서 오는 길 그대로) */
function talk(mock: MockPlatform, sessionId: string, lines: ['user' | 'assistant', string][]): void {
  for (const [role, text] of lines) {
    if (role === 'user') mock.emit({ type: 'user_message', sessionId, seq: 0, text })
    else mock.emit({ type: 'message_delta', sessionId, role: 'assistant', text })
  }
}

/**
 * 말을 걸면 답이 온다.
 *
 * 목의 `send`는 상태만 working으로 바꾼다 — 그게 E2E에는 맞다(테스트가 답을 직접 넣는다).
 * 사람이 보는 화면에서는 그것이 "영원히 도는 세션"으로만 보이므로, 여기서 **짧은 각본**을
 * 얹는다: 생각하는 척 → 도구 하나 → 답 몇 조각 → 끝. 입력창 접힘·무지개 링·끝났을 때의
 * 바람·읽음 처리가 전부 이 한 바퀴에서 실제로 움직인다.
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
