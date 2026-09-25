import { describe, expect, it, vi } from 'vitest'
import type { NormalizedEvent } from '@cc/protocol'

/**
 * 서브에이전트의 메시지는 부모의 스트림으로 섞여 온다 (#98).
 *
 * 순서와 모양은 실측 그대로다 (scripts/probe-subagent-stream.mts, CLI 2.1.282,
 * 2026-09-25). 백그라운드 에이전트를 띄운 부모가 글을 스트리밍하는 동안:
 *
 *   stream_event text_delta ×27  parent=null
 *   assistant parent=toolu_…   [thinking]            ← 서브에이전트
 *   stream_event text_delta ×17  parent=null
 *   assistant parent=toolu_…   [tool_use Bash]       ← 서브에이전트
 *   stream_event text_delta ×32  parent=null
 *   assistant parent=null      [text 946자]          ← 부모의 본문
 *   result
 *   user      parent=toolu_…   [tool_result]        ← 부모가 쉬는 동안 계속된다
 *   assistant parent=toolu_…   [text "I am done."]   ← forwardSubagentText 없이도 온다
 *   system/task_notification {tool_use_id, status, summary, usage}
 *
 * 도그푸딩의 증상이 이 순서에서 그대로 나온다: 부모의 문단이 낱말 한가운데서
 * 남의 도구 호출에 잘리고(`남았` / Bash / `는지`), 서브에이전트의 보고서 전문이
 * 부모의 답변으로 한 번, 부모의 요약으로 또 한 번 — "답이 두 번 보인다".
 *
 * SDK를 가짜로 바꿔 끼우고 **어댑터의 루프를 통째로** 지난다 — 본문이 델타로 이미
 * 나갔는지 세는 표식(textStreamed)이 루프에 있고, 그 표식도 이 순서에 걸린다.
 */
const script = vi.hoisted(() => ({ messages: [] as unknown[], release: () => {} }))

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    async *[Symbol.asyncIterator]() {
      for (const m of script.messages) yield m
      // 스트림이 끝나면 어댑터는 CLI가 죽었다고 판단한다 — 테스트가 닫을 때까지 붙든다
      await new Promise<void>((r) => (script.release = r))
    },
    interrupt: async () => {},
    supportedCommands: async () => [],
    getContextUsage: async () => undefined,
  }),
}))

const { ClaudeAdapter } = await import('./index.js')

const AGENT = 'toolu_015K5NBc2gup8ch4DVP7XQCD'
const SUB_1 = 'toolu_01GUgRASrjyeyDCL13txAFdC'
const SUB_2 = 'toolu_01BbrkvPiSVUQag9pc8X8DZC'
const SUB_EDIT = 'toolu_01EditBySubagent00000000'

const delta = (text: string) => ({
  type: 'stream_event',
  parent_tool_use_id: null,
  event: { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text } },
})
const parentText = (text: string) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { role: 'assistant', content: [{ type: 'text', text }], usage: { input_tokens: 12, output_tokens: 34 } },
})
/** 서브에이전트의 assistant 메시지 — 사용량은 부모의 것과 구별되게 튀는 값으로 둔다 */
const sub = (content: unknown[]) => ({
  type: 'assistant',
  parent_tool_use_id: AGENT,
  message: { role: 'assistant', content, usage: { input_tokens: 99_999, output_tokens: 77_777 } },
})
const subResult = (id: string, text: string) => ({
  type: 'user',
  parent_tool_use_id: AGENT,
  subagent_type: 'general-purpose',
  task_description: 'Research the build',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: text }] },
})
const result = { type: 'result', subtype: 'success', modelUsage: {} }

const REPORT =
  'I checked all 13 items against official docs and source code. Several of the assumptions do not hold, ' +
  'most importantly on the boundaries test.'

const FIRST = '별도 작업이라 범위에서 뺐고, 결과 보고에 어디에 이름이 남았'
const SECOND = '는지 적게 했습니다.'
const LATER = '조사가 돌아왔습니다.'

/** 실측 순서: 부모가 백그라운드 에이전트를 띄우고, 그 에이전트가 부모의 스트림 사이사이에 일한다 */
const backgroundRun = [
  { type: 'system', subtype: 'init', session_id: 'ext-1' },
  {
    type: 'assistant',
    parent_tool_use_id: null,
    message: {
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: AGENT,
          name: 'Agent',
          input: { description: 'Research the build', subagent_type: 'general-purpose', prompt: '…', run_in_background: true },
        },
      ],
    },
  },
  {
    type: 'system',
    subtype: 'task_started',
    task_id: 'a19ec1fdf94e35cfc',
    tool_use_id: AGENT,
    description: 'Research the build',
    subagent_type: 'general-purpose',
    is_backgrounded: true,
    spawn_depth: 1,
    task_type: 'local_agent',
  },
  {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: AGENT,
          content: [
            {
              type: 'text',
              text: 'Async agent launched successfully. (This tool result is internal metadata — never quote or paste any part of it, including the agentId below, into a user-facing reply.)\nagentId: a19ec1fdf94e35cfc',
            },
          ],
        },
      ],
    },
    tool_use_result: {
      isAsync: true,
      status: 'async_launched',
      agentId: 'a19ec1fdf94e35cfc',
      description: 'Research the build',
      prompt: '…',
      outputFile: '/private/tmp/claude-501/x/tasks/a19ec1fdf94e35cfc.output',
    },
  },
  delta(FIRST),
  sub([{ type: 'thinking', thinking: '' }]),
  sub([{ type: 'tool_use', id: SUB_1, name: 'Bash', input: { command: "sed -n '56,200p' tooling/boundaries.test.ts" } }]),
  {
    type: 'system',
    subtype: 'task_progress',
    task_id: 'a19ec1fdf94e35cfc',
    tool_use_id: AGENT,
    description: 'Running sed',
    usage: { total_tokens: 12138, tool_uses: 1, duration_ms: 2473 },
    last_tool_name: 'Bash',
  },
  delta(SECOND),
  parentText(FIRST + SECOND),
  result,
  // 부모의 턴은 끝났다 — 서브에이전트는 계속 일한다
  subResult(SUB_1, "describe('ui 레이어 경계', () => {"),
  sub([{ type: 'tool_use', id: SUB_2, name: 'Grep', input: { pattern: 'boundaries' } }]),
  subResult(SUB_2, 'tooling/boundaries.test.ts'),
  sub([{ type: 'tool_use', id: SUB_EDIT, name: 'Edit', input: { file_path: '/repo/tooling/boundaries.test.ts', old_string: 'a', new_string: 'b' } }]),
  subResult(SUB_EDIT, 'ok'),
  sub([{ type: 'text', text: REPORT }]),
  { type: 'system', subtype: 'task_updated', task_id: 'a19ec1fdf94e35cfc', patch: { status: 'completed', end_time: 1 } },
  {
    type: 'system',
    subtype: 'task_notification',
    task_id: 'a19ec1fdf94e35cfc',
    tool_use_id: AGENT,
    status: 'completed',
    output_file: '/private/tmp/claude-501/x/tasks/a19ec1fdf94e35cfc.output',
    summary: REPORT,
    usage: { total_tokens: 13620, tool_uses: 3, duration_ms: 134_000 },
  },
  // 통지를 받은 부모가 새 턴을 연다 (실측: system/init이 다시 온다)
  { type: 'system', subtype: 'init', session_id: 'ext-1' },
  delta(LATER),
  parentText(LATER),
  result,
]

async function run(messages: unknown[]): Promise<NormalizedEvent[]> {
  script.messages = messages
  const events: NormalizedEvent[] = []
  const adapter = new ClaudeAdapter()
  const handle = await adapter.createSession({ sessionId: 's1', cwd: '/repo', permissionPreset: 'auto' }, (e) => events.push(e))
  await new Promise((r) => setTimeout(r, 20))
  await handle.dispose()
  script.release()
  return events
}

const texts = (events: NormalizedEvent[]) =>
  events.flatMap((e) => (e.type === 'message_delta' ? [e.text] : [])).join('')

describe('서브에이전트의 메시지는 부모의 대화가 아니다 (#98)', () => {
  it('부모의 글은 부모의 것뿐이다 — 서브에이전트의 보고서가 부모 답변으로 새지 않는다', async () => {
    const events = await run(backgroundRun)
    expect(texts(events)).toBe(FIRST + SECOND + LATER)
  })

  it('부모의 도구 호출은 부모의 것뿐이다 — 서브에이전트의 호출·결과는 대화에 줄을 만들지 않는다', async () => {
    const events = await run(backgroundRun)
    expect(events.filter((e) => e.type === 'tool_call').map((e) => (e as { callId: string }).callId)).toEqual([AGENT])
    expect(
      events.filter((e) => e.type === 'tool_result' && [SUB_1, SUB_2, SUB_EDIT].includes(e.callId)),
    ).toEqual([])
  })

  it('부모의 글 한 덩어리는 남의 사건에 잘리지 않는다 — `남았` / Bash / `는지`가 다시 나지 않는다', async () => {
    const events = await run(backgroundRun)
    const first = events.findIndex((e) => e.type === 'message_delta' && e.text === FIRST)
    const second = events.findIndex((e) => e.type === 'message_delta' && e.text === SECOND)
    expect(first).toBeGreaterThanOrEqual(0)
    expect(second).toBeGreaterThan(first)
    // 두 조각 사이에 대화에 줄을 만드는 사건이 하나도 없어야 한다
    const between = events.slice(first + 1, second).map((e) => e.type)
    expect(between.filter((t) => t === 'tool_call' || t === 'tool_result' || t === 'message_delta')).toEqual([])
  })

  it('서브에이전트의 사용량이 부모의 사용량을 덮지 않는다', async () => {
    const events = await run(backgroundRun)
    const usage = events.filter((e) => e.type === 'usage_update').map((e) => e.tokens.inputTokens)
    expect(usage).not.toContain(99_999)
  })
})

describe('서브에이전트의 일은 그것을 띄운 Agent 카드에 붙는다 (#98)', () => {
  it('걸음마다 그 카드의 실행 중 출력으로 간다 — 누가 했는지가 callId로 남는다', async () => {
    const events = await run(backgroundRun)
    const live = events
      .filter((e) => e.type === 'tool_output_delta' && e.callId === AGENT)
      .map((e) => (e as { text: string }).text)
      .join('')
    expect(live).toContain("sed -n '56,200p' tooling/boundaries.test.ts")
    expect(live).toContain('Grep: boundaries')
    expect(live).toContain('Edit: /repo/tooling/boundaries.test.ts')
  })

  it('서브에이전트가 고친 파일은 여전히 이 세션이 만진 파일이다 (충돌 감지·하이라이트)', async () => {
    const events = await run(backgroundRun)
    expect(events).toContainEqual({ type: 'files_touched', sessionId: 's1', paths: ['/repo/tooling/boundaries.test.ts'] })
  })

  it('백그라운드 에이전트의 카드는 끝났을 때 한 번 닫힌다 — 보고서 머리와 걸음 수를 들고', async () => {
    const events = await run(backgroundRun)
    const results = events.filter((e) => e.type === 'tool_result' && e.callId === AGENT)
    expect(results).toHaveLength(1)
    const [done] = results as Extract<NormalizedEvent, { type: 'tool_result' }>[]
    expect(done?.ok).toBe(true)
    expect(done?.summary).toContain('3 tool uses')
    expect(done?.summary).toContain('I checked all 13 items')
    // 모델에게만 하는 말("never quote…")은 사람의 카드에 오르지 않는다
    expect(done?.summary).not.toContain('Async agent launched')
    // 닫히는 자리는 통지가 온 뒤다 — 띄운 순간이 아니다
    const notified = events.findIndex((e) => e.type === 'tool_output_delta' && e.text.includes('Edit:'))
    expect(events.indexOf(done!)).toBeGreaterThan(notified)
  })

  /*
   * 카드를 닫는 tool_result는 저장 쪽에서 글 덩어리의 경계다(manager persistMessage) —
   * 부모가 쓰는 도중에 내면 부모의 문단이 행 둘로 갈린다. 에이전트 셋을 나란히 띄운
   * 도그푸딩 세션에서는 한 에이전트가 끝나는 순간 부모가 다른 에이전트의 소식을 적고 있었다.
   */
  it('부모가 쓰는 도중에 에이전트가 끝나도 그 글을 자르지 않는다 — 카드는 덩어리가 닫힌 뒤에 닫힌다', async () => {
    const notification = backgroundRun.find((m) => (m as { subtype?: string }).subtype === 'task_notification')
    const events = await run([
      ...backgroundRun.slice(0, 4), // init · Agent 호출 · task_started · 띄운 결과
      delta('로컬 조사도 돌아왔습니다. Codex'),
      notification,
      delta(' 세션에서 앱 도구를 부르면 조용히 거절됩니다.'),
      parentText('로컬 조사도 돌아왔습니다. Codex 세션에서 앱 도구를 부르면 조용히 거절됩니다.'),
      result,
    ])
    const kinds = events.map((e) => (e.type === 'tool_result' ? `result:${e.callId}` : e.type))
    const lastDelta = kinds.lastIndexOf('message_delta')
    const closed = kinds.indexOf(`result:${AGENT}`)
    expect(closed).toBeGreaterThan(lastDelta)
    expect(events.filter((e) => e.type === 'tool_result')).toHaveLength(1)
  })

  it('돌아오지 않은 채 세션이 닫히면 카드를 열어 두지 않는다 — 에이전트는 프로세스와 함께 사라졌다', async () => {
    // 띄우고, 한 걸음 걷고, 통지 없이 끝난다
    const events = await run(backgroundRun.slice(0, 7))
    const results = events.filter((e) => e.type === 'tool_result' && e.callId === AGENT)
    expect(results).toEqual([
      { type: 'tool_result', sessionId: 's1', callId: AGENT, ok: false, summary: 'The session closed before this agent reported back' },
    ])
  })

  it('카드의 제목은 에이전트에게 맡긴 일이다 — "Agent"만으로는 무엇을 하는 카드인지 모른다', async () => {
    const events = await run(backgroundRun)
    const call = events.find((e) => e.type === 'tool_call')
    expect(call).toMatchObject({ callId: AGENT, summary: { tool: 'Agent', title: 'Research the build' } })
  })
})

describe('부모 본문의 중복 방지 표식은 부모의 것이다 (#98)', () => {
  /*
   * 델타로 이미 나간 본문은 assistant 메시지에서 다시 내지 않는다 (textStreamed).
   * 그 표식은 assistant 메시지가 올 때마다 내려간다 — 서브에이전트의 assistant가
   * 부모의 마지막 델타와 부모의 본문 사이에 끼면, 표식이 부모의 본문 앞에서
   * 먼저 내려가 부모의 글 전체가 한 번 더 붙는다.
   */
  it('서브에이전트 메시지가 부모의 마지막 델타와 본문 사이에 끼어도 부모의 글은 한 번이다', async () => {
    const events = await run([
      { type: 'system', subtype: 'init', session_id: 'ext-1' },
      delta('부모의 '),
      delta('문단'),
      sub([{ type: 'tool_use', id: SUB_1, name: 'Bash', input: { command: 'ls' } }]),
      parentText('부모의 문단'),
      result,
    ])
    expect(texts(events)).toBe('부모의 문단')
  })
})

describe('포그라운드 에이전트의 결과 (#98)', () => {
  /*
   * 포그라운드는 Agent 호출의 tool_result가 곧 완료다. 그 본문은 모델에게 하는 말
   * ("[Subagent hand-back] The text below…")로 시작하고, SDK는 사람에게 보일 것은
   * tool_use_result에서 그리라고 한다 (sdk.d.ts SDKUserMessage.tool_use_result).
   */
  it('카드에는 보고서와 걸음 수가 오른다 — 모델에게 하는 머리말이 아니라', async () => {
    const events = await run([
      { type: 'system', subtype: 'init', session_id: 'ext-1' },
      {
        type: 'assistant',
        parent_tool_use_id: null,
        message: { role: 'assistant', content: [{ type: 'tool_use', id: AGENT, name: 'Agent', input: { description: 'probe fg', prompt: '…' } }] },
      },
      sub([{ type: 'tool_use', id: SUB_1, name: 'Bash', input: { command: 'echo sub-one' } }]),
      subResult(SUB_1, 'sub-one'),
      {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: AGENT,
              content: [{ type: 'text', text: "[Subagent hand-back] The text below is the final report of a subagent this session started.\n\nI'm done." }],
            },
          ],
        },
        tool_use_result: {
          status: 'completed',
          agentId: 'a567ed393c31c63e1',
          agentType: 'general-purpose',
          prompt: '…',
          content: [{ type: 'text', text: "I'm done." }],
          totalToolUseCount: 1,
          totalDurationMs: 4096,
          totalTokens: 14521,
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: null, cache_read_input_tokens: null, server_tool_use: null, service_tier: null, cache_creation: null },
        },
      },
      result,
    ])
    const results = events.filter((e) => e.type === 'tool_result') as Extract<NormalizedEvent, { type: 'tool_result' }>[]
    expect(results.map((r) => r.callId)).toEqual([AGENT])
    expect(results[0]?.summary).toContain('1 tool use')
    expect(results[0]?.summary).toContain("I'm done.")
    expect(results[0]?.summary).not.toContain('[Subagent hand-back]')
  })
})
