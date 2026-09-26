import type { ApprovalDetail, NormalizedEvent, ToolSummary } from '@cc/protocol'

/**
 * Claude SDK 메시지 → NormalizedEvent 변환 (순수 함수라 계약 테스트가 가능하다).
 * SDK 타입은 여기서 끝난다 — 밖으로 나가는 건 protocol 타입뿐.
 */

const READ_ONLY = new Set(['Read', 'Grep', 'Glob', 'NotebookRead', 'WebFetch', 'WebSearch', 'TodoWrite', 'Task'])
const FILE_EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

type Json = Record<string, unknown>
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback)

export function toolSummary(name: string, input: Json): ToolSummary {
  const paths: string[] = []
  let title = name
  if (name === 'Bash') title = str(input.command, name)
  else if (FILE_EDIT_TOOLS.has(name) || name === 'Read') {
    const p = str(input.file_path ?? input.notebook_path)
    if (p) paths.push(p)
    title = `${name}: ${p || '?'}`
  } else if (name === 'Grep' || name === 'Glob') title = `${name}: ${str(input.pattern)}`
  // 제안 카드(#63)는 이유를 제목으로 쓴다 — UI가 그대로 사람에게 보여주는 유일한 인자다
  else if (name.endsWith('propose_project')) title = str(input.reason, name)
  // 제안 카드가 브랜치 이름을 미리 채우는 유일한 운반로다 (#69) — 제목에 싣는다
  else if (name.endsWith('propose_worktree_session')) title = str(input.branch, name)
  /*
   * 에이전트 카드의 제목은 맡긴 일이다 (#98). 이름만 있던 동안 카드는 전부 "Agent Agent"였고,
   * 에이전트 셋을 나란히 띄우면 어느 카드가 무엇인지 알 길이 없었다 (도그푸딩 세션: 셋 다 같은 줄).
   */
  else if (name === 'Agent' || name === 'Task') title = str(input.description, name)
  return { tool: name, title, readOnly: READ_ONLY.has(name), paths }
}

/**
 * `files_touched`로 알릴 경로 — 파일을 **바꾼** 도구의 것만 (#185).
 *
 * `toolSummary`의 `paths`에는 Read의 경로도 들어 있다(인계 기록이 "무엇을 봤나"로 쓴다). 그것을
 * 그대로 내보내면 에이전트가 읽기만 한 파일에도 트리의 "Edited by agent"가 붙는다.
 */
function editedPaths(s: ToolSummary): string[] {
  return FILE_EDIT_TOOLS.has(s.tool) ? s.paths : []
}

/**
 * 서브에이전트의 걸음 한 줄 — 그 에이전트 카드의 실행 중 출력에 붙는다 (#98).
 *
 * 부모의 카드와 같은 제목 규칙(toolSummary)을 쓰되 도구 이름을 앞에 붙인다: Bash의 제목은
 * 명령 전문이라 이름이 없으면 무엇을 했는지가 아니라 무엇을 쳤는지만 남는다.
 * 여러 줄 명령(heredoc)은 첫 줄만 — 카드의 꼬리는 세 줄이라 명령 하나가 통째로 차지한다.
 */
function stepLine(s: ToolSummary): string {
  const lines = s.title.split('\n')
  const first = lines[0] ?? ''
  const head = first.slice(0, 200) + (lines.length > 1 || first.length > 200 ? ' …' : '')
  return head === s.tool || head.startsWith(`${s.tool}:`) ? head : `${s.tool}: ${head}`
}

/** "34 tool uses · 2m 13s" — 에이전트 카드의 결과 머리 (#98) */
function agentStats(toolUses: unknown, durationMs: unknown, status?: string): string {
  const parts: string[] = []
  if (status && status !== 'completed') parts.push(status)
  if (typeof toolUses === 'number') parts.push(`${toolUses} tool use${toolUses === 1 ? '' : 's'}`)
  if (typeof durationMs === 'number') {
    const s = Math.round(durationMs / 1000)
    parts.push(s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`)
  }
  return parts.join(' · ')
}

/**
 * 에이전트 카드의 결과 본문 — 걸음 수와 보고서 머리.
 *
 * 카드 결과는 어느 도구든 300자에서 자른다(아래 tool_result). 에이전트의 보고서는
 * 수만 자가 예사라(도그푸딩: 15~24KB) 카드에는 머리만 오르고, 전문은 부모가 받아
 * 자기 말로 옮긴다 — 카드가 전문을 그리면 그게 곧 "답이 두 번 보인다"다.
 */
function agentReport(report: string, stats: string): string {
  return (stats ? `${stats}\n\n${report}` : report).slice(0, 300)
}

/**
 * 이 user 메시지가 **백그라운드 에이전트를 띄운 결과**인가 (#98).
 *
 * 실측(probe-subagent-stream.mts): 띄우는 순간 Agent 호출의 tool_result가 바로 오고,
 * 본문은 모델에게 하는 말이다 — "Async agent launched successfully. (This tool result is
 * internal metadata — never quote or paste any part of it … into a user-facing reply.)".
 * 에이전트가 실제로 끝나는 것은 한참 뒤의 system/task_notification이다.
 * 판정은 tool_use_result의 모양(sdk-tools.d.ts AgentOutput)으로 한다: status가
 * 'async_launched'이고 agentId가 있는 것은 에이전트뿐이다 (워크플로는 taskId를 싣는다).
 * 결과 블록이 정확히 하나일 때만 — tool_use_result는 메시지에 하나라 블록이 여럿이면
 * 어느 블록의 것인지 모른다.
 */
function backgroundLaunch(m: Json): string | null {
  const r = (m.tool_use_result ?? {}) as Json
  if (str(r.status) !== 'async_launched' || !str(r.agentId)) return null
  const blocks = (((m.message as Json | undefined)?.content ?? []) as Json[]).filter((b) => str(b.type) === 'tool_result')
  return blocks.length === 1 ? str(blocks[0]?.tool_use_id) || null : null
}

/** 승인 요청을 배너 판정 가능한 3종으로 정규화 (core/approval이 kind만 보고 판단) */
export function approvalDetail(name: string, input: Json, cwd: string): ApprovalDetail {
  if (name === 'Bash') return { kind: 'command', command: str(input.command), cwd }
  if (FILE_EDIT_TOOLS.has(name)) {
    const path = str(input.file_path ?? input.notebook_path, '?')
    const preview =
      str(input.new_string) || str(input.content) || str(input.new_source) || JSON.stringify(input).slice(0, 400)
    return { kind: 'file_edit', path, diffPreview: preview.slice(0, 400), multi: false }
  }
  return { kind: 'other', raw: `${name} ${JSON.stringify(input).slice(0, 300)}` }
}

/**
 * SDK 메시지 하나 → 이벤트 0..N개.
 * `msg`는 의도적으로 unknown — SDK 타입을 이 경계 밖으로 흘리지 않기 위해서다.
 */
export function normalizeMessage(
  msg: unknown,
  sessionId: string,
  opts?: {
    /**
     * 이 assistant 메시지의 본문이 이미 스트리밍 델타로 나갔는가 — 어댑터가 세어서 준다.
     *
     * 본문은 보통 stream_event 델타로만 그리고 assistant 메시지의 text 블록은 버렸는데,
     * **델타 없이 오는 응답이 실재한다**: /usage처럼 CLI가 로컬에서 합성하는 답은
     * 델타 0개, 통짜 assistant 메시지 하나다 (실측 — 델타 0 · 본문 1,046자).
     * 그 경우 여기서 안 내면 명령은 실행됐는데 답이 화면에 영영 안 나타난다.
     * 반대로 스트리밍된 턴에서 또 내면 같은 글이 두 번 붙는다 — 그래서 플래그가 필요하다.
     */
    textStreamed?: boolean
  },
): NormalizedEvent[] {
  const m = msg as Json
  const type = str(m.type)
  const out: NormalizedEvent[] = []

  /*
   * 서브에이전트의 메시지는 부모의 대화가 아니다 (#98).
   *
   * Agent 도구로 띄운 서브에이전트의 assistant·user 메시지는 부모의 스트림으로 섞여 오고,
   * 그것을 띄운 호출의 id를 parent_tool_use_id에 싣는다 (sdk.d.ts SDKAssistantMessage:
   * "parent_tool_use_id is non-null when the message was produced inside a subagent started
   * by that tool_use"). 이 필드를 한 번도 안 봐서, 서브에이전트의 도구 호출은 부모가 글을
   * 쓰는 도중 그 자리에 박혔고(낱말 한가운데 — `남았` / Bash / `는지`), 보고서 전문
   * (15~24KB)은 부모의 답변으로 한 번, 부모의 요약으로 또 한 번 보였다.
   *
   * **글은 오지 않을 것이라 믿지 않는다.** SDK 문서는 forwardSubagentText를 켜야 글이
   * 온다고 하지만, 실측(CLI 2.1.282, 옵션 없음)에서 서브에이전트의 마지막 글이 그대로
   * 왔다. 부모 대화에서는 무엇이든 버리고, 도구 호출만 **그것을 띄운 카드의 실행 중
   * 출력**으로 돌린다 — 누가 했는지는 callId가 말한다. 대화에 줄을 새로 세우지 않으므로
   * 부모의 문단도 더는 잘리지 않는다. 사용량도 버린다: 서브에이전트의 토큰이 부모의
   * 사용량 칸을 덮어쓰고 있었다.
   *
   * 파일은 예외다 — 서브에이전트가 고친 파일도 이 세션의 작업 폴더에서 바뀐 파일이라
   * 충돌 감지·하이라이트(FR-2, FR-5)에는 그대로 알린다.
   */
  const parent = str(m.parent_tool_use_id)
  if (parent && (type === 'assistant' || type === 'user' || type === 'stream_event')) {
    if (type !== 'assistant') return out
    for (const block of ((m.message as Json | undefined)?.content ?? []) as Json[]) {
      if (str(block.type) !== 'tool_use') continue
      const s = toolSummary(str(block.name), (block.input ?? {}) as Json)
      out.push({ type: 'tool_output_delta', sessionId, callId: parent, text: `${stepLine(s)}\n` })
      const edited = editedPaths(s)
      if (edited.length) out.push({ type: 'files_touched', sessionId, paths: edited })
    }
    return out
  }

  /*
   * 지금 무엇을 하는 중인가.
   *
   * 프로브로 실제 순서를 확인했다:
   *   status:'compacting' → (39초) → status:null + compact_result:'success' → compact_boundary
   * 그 39초 동안 화면은 '응답 대기'와 한 글자도 다르지 않았다 — 도그푸딩에서 나온 문제다.
   */
  if (type === 'system' && str(m.subtype) === 'status') {
    out.push({ type: 'activity', sessionId, activity: m.status === 'compacting' ? 'compacting' : null })
    /*
     * 실패는 삼키지 않는다. 압축이 실패하면 컨텍스트는 그대로인데 화면에는
     * 아무 일도 없었던 것처럼 보인다 — 실측에서 실제로 나온 경우다
     * ("Not enough messages to compact.").
     */
    if (str(m.compact_result) === 'failed') {
      out.push({ type: 'compaction', sessionId, failed: true, reason: str(m.compact_error, 'Unknown reason') })
    }
    return out
  }

  /*
   * 골 판정 통지 (2026-09-07 — `/goal`의 Stop 훅, SDKActiveGoalMessage). #58 부류:
   * 이 타입이 없던 동안 골 상태는 조용히 버려졌다. value가 null이면 걷힌 것(달성 포함)이고,
   * 걸려 있는 동안 claude의 상태 어휘는 'active' 하나다 — 바퀴 수와 미달 사유가 내용이다.
   */
  if (type === 'active_goal') {
    const v = (m.value ?? null) as Json | null
    out.push({
      type: 'goal',
      sessionId,
      goal: v
        ? {
            objective: str(v.condition),
            status: 'active',
            ...(typeof v.iterations === 'number' ? { iterations: v.iterations } : {}),
            ...(str(v.last_reason) ? { reason: str(v.last_reason) } : {}),
          }
        : null,
    })
    return out
  }

  /*
   * 로컬 명령의 출력 (SDKLocalCommandOutputMessage — /usage류의 **일반화된 채널**).
   *
   * /usage의 답이 델타 없는 assistant 메시지로 와서 안 보였던 사건(도그푸딩)의 자매다:
   * CLI가 로컬에서 처리하는 명령의 출력이 이 system 메시지로 오는 경우가 있고,
   * 버리면 명령은 실행됐는데 답만 사라진다. 사람에게는 assistant의 말과 같은 자리다.
   */
  if (type === 'system' && str(m.subtype) === 'local_command_output') {
    const content = str(m.content)
    if (content) out.push({ type: 'message_delta', sessionId, role: 'assistant', text: content })
    return out
  }

  /*
   * 압축이 끝난 지점 (FR-14).
   *
   * 이게 없어서 **Claude 세션에는 압축 마커가 한 번도 뜬 적이 없다** — Codex에만 있었다.
   * 마커가 없으면 접힌 자리를 모르니 "그 위로 거슬러 읽기"도 성립하지 않는다.
   */
  if (type === 'system' && str(m.subtype) === 'compact_boundary') {
    const meta = (m.compact_metadata ?? {}) as Json
    out.push({
      type: 'compaction',
      sessionId,
      failed: false,
      before: typeof meta.pre_tokens === 'number' ? meta.pre_tokens : undefined,
      after: typeof meta.post_tokens === 'number' ? meta.post_tokens : undefined,
    })
    return out
  }

  // 스트리밍 델타 (includePartialMessages: true 필요 — M0 확인)
  if (type === 'stream_event') {
    const e = m.event as Json | undefined
    if (str(e?.type) === 'content_block_delta') {
      const d = e?.delta as Json | undefined
      if (str(d?.type) === 'text_delta') {
        out.push({ type: 'message_delta', sessionId, role: 'assistant', text: str(d?.text) })
      }
      /*
       * thinking (#58 실측, 2026-08-26): 본문이 통째로 암호화라 thinking은 항상 ""이고
       * estimated_tokens(증분)만 온다. 그래서 텍스트가 아니라 "생각 중 ~N 토큰"이라는
       * **진행 사실**만 낼 수 있다 — 없는 내용을 있는 척하지 않는다. 어느 날 CLI가
       * 텍스트를 실어 보내기 시작하면 여기 text가 그대로 흐른다.
       */
      if (str(d?.type) === 'thinking_delta') {
        const text = str(d?.thinking)
        const estTokens = typeof d?.estimated_tokens === 'number' ? d.estimated_tokens : undefined
        if (text || estTokens) {
          out.push({ type: 'reasoning_delta', sessionId, ...(text ? { text } : {}), ...(estTokens ? { estTokens } : {}) })
        }
      }
    }
    return out
  }

  if (type === 'assistant') {
    const content = ((m.message as Json | undefined)?.content ?? []) as Json[]
    // 델타 없이 온 본문의 유일한 출구 (위 opts.textStreamed 주석 참고 — /usage가 이 길로 온다)
    if (!opts?.textStreamed) {
      // thinking 블록도 같은 규칙 — 실측으로는 항상 ""이지만, 텍스트가 실려 오는 날 여기로 흐른다
      const thinking = content
        .filter((b) => str(b.type) === 'thinking')
        .map((b) => str(b.thinking))
        .join('')
      if (thinking) out.push({ type: 'reasoning_delta', sessionId, text: thinking })
      const text = content
        .filter((b) => str(b.type) === 'text')
        .map((b) => str(b.text))
        .join('')
      if (text) out.push({ type: 'message_delta', sessionId, role: 'assistant', text })
    }
    for (const block of content) {
      if (str(block.type) === 'tool_use') {
        const name = str(block.name)
        const input = (block.input ?? {}) as Json
        out.push({ type: 'tool_call', sessionId, callId: str(block.id), summary: toolSummary(name, input) })
        const paths = editedPaths(toolSummary(name, input))
        if (paths.length) out.push({ type: 'files_touched', sessionId, paths })
      }
    }
    // 사용량은 assistant 메시지에도 실려 온다
    const usage = (m.message as Json | undefined)?.usage as Json | undefined
    if (usage) {
      out.push({
        type: 'usage_update',
        sessionId,
        tokens: {
          inputTokens: Number(usage.input_tokens ?? 0),
          outputTokens: Number(usage.output_tokens ?? 0),
          cacheReadTokens: Number(usage.cache_read_input_tokens ?? 0),
          cacheCreationTokens: Number(usage.cache_creation_input_tokens ?? 0),
        },
      })
    }
    return out
  }

  if (type === 'user') {
    const content = ((m.message as Json | undefined)?.content ?? []) as Json[]
    /*
     * 백그라운드 에이전트를 띄운 결과는 **결과가 아니다** (#98). 여기서 카드를 닫으면
     * 카드에는 모델에게만 하라는 말("never quote…")이 결과로 오르고, 에이전트가 정말로
     * 일하는 동안 카드는 이미 끝난 것처럼 보인다. 카드를 열어 둔 채 사실만 한 줄 남기고,
     * 끝났을 때 task_notification이 닫는다 (ClaudeStreamNormalizer).
     */
    const launched = backgroundLaunch(m)
    if (launched) return [{ type: 'tool_output_delta', sessionId, callId: launched, text: 'Running in the background\n' }]
    /*
     * 포그라운드 에이전트의 결과는 tool_use_result에서 그린다 — SDK가 그러라고 한다
     * (sdk.d.ts: "For the Agent/Task tool the completed shape is the subagent's final report
     * without the model-directed agentId/usage trailer, plus run totals — render from it
     * instead of parsing the tool_result text."). 본문을 그대로 쓰면 카드에는
     * "[Subagent hand-back] The text below is…"로 시작하는 JSON이 오른다 (실측).
     */
    const agent = (m.tool_use_result ?? {}) as Json
    const agentDone =
      str(agent.status) === 'completed' && str(agent.agentId) && Array.isArray(agent.content) &&
      content.filter((b) => str(b.type) === 'tool_result').length === 1
        ? agentReport(
            (agent.content as Json[]).map((b) => str(b.text)).join('\n'),
            agentStats(agent.totalToolUseCount, agent.totalDurationMs),
          )
        : null
    for (const block of content) {
      if (str(block.type) === 'tool_result') {
        const c = block.content
        out.push({
          type: 'tool_result',
          sessionId,
          callId: str(block.tool_use_id),
          ok: block.is_error !== true,
          summary: agentDone ?? (typeof c === 'string' ? c : JSON.stringify(c ?? '')).slice(0, 300),
        })
        /*
         * 도구 결과에 실려 온 이미지 (#40). 스크린샷을 찍거나 이미지 파일을 Read하면
         * 여기로 온다 — 실측 모양: {type:'image', source:{type:'base64', data, media_type}}.
         * (assistant 본문에는 이미지가 실리지 않는다 — 도구 결과가 유일한 길이다)
         */
        if (Array.isArray(c)) {
          for (const part of c as Json[]) {
            if (str(part.type) !== 'image') continue
            const source = (part.source ?? {}) as Json
            /*
             * base64가 아닌 소스(url 등)는 예전엔 소리 없이 사라졌다 (#58 조사에서 발견).
             * 못 그리는 건 어쩔 수 없지만 못 그린다는 사실은 보여야 한다 — 이미지 실패의
             * 기존 규칙(너무 큼·파일 없음)과 같은 상자를 쓴다.
             */
            if (str(source.type) !== 'base64' || !str(source.data)) {
              out.push({
                type: 'message_image', sessionId, mime: '', data: '',
                note: `이 형식의 이미지는 아직 표시하지 못합니다 (source: ${str(source.type) || '없음'})`,
              })
              continue
            }
            const data = str(source.data)
            const mime = str(source.media_type) || 'image/png'
            // base64 ~11M자 ≈ 원본 8MB. 그 이상은 화면에 뿌리는 대신 왜 안 그리는지 말한다
            if (data.length > 11_000_000) {
              out.push({
                type: 'message_image', sessionId, mime, data: '',
                note: `이미지가 너무 큽니다 (~${Math.round((data.length * 3) / 4 / 1048576)}MB)`,
              })
            } else {
              out.push({ type: 'message_image', sessionId, mime, data })
            }
          }
        }
      }
    }
    return out
  }

  /*
   * 한도 (M0 발견: rate_limit_event.rate_limit_info).
   *
   * **막힌 것만 한도다.** status는 셋이다 (SDK: 'allowed' | 'allowed_warning' | 'rejected').
   * `!== 'allowed'`로 보던 동안 allowed_warning — "가까워졌지만 아직 통과한다" — 가
   * rejected와 같은 취급을 받아, 아무것도 막히지 않은 세션에 한도 배너가 붙었다
   * (도그푸딩: "한도에 도달하지 않았는데 탭에 떴다").
   *
   * 코덱스 어댑터가 같은 실수를 먼저 고치면서 이쪽을 기준으로 인용했는데, 기준이
   * 틀려 있었다. 지금은 코덱스 쪽이 옳다 — 도구가 주는 명시적 신호만 본다.
   * 경고를 버리는 것은 아니다: 남은 여유는 사용량 창(agents.usage)이 퍼센트로 보여준다.
   * 배너는 "지금 못 쓴다"는 말이라, 쓸 수 있는데 붙으면 그 말이 거짓이 된다.
   */
  if (type === 'rate_limit_event') {
    const info = (m.rate_limit_info ?? {}) as Json
    if (str(info.status) === 'rejected') {
      const resetsAt = typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000).toISOString() : undefined
      out.push({
        type: 'limit_reached',
        sessionId,
        resumeAt: resetsAt,
        windowMins: str(info.rateLimitType) === 'five_hour' ? 300 : undefined,
      })
    }
    return out
  }

  if (type === 'result') {
    const modelUsage = (m.modelUsage ?? {}) as Record<string, Json>
    const models = Object.values(modelUsage)
    if (models.length > 0) {
      /*
       * 컨텍스트 사용량은 여기서 계산하지 않는다.
       *
       * modelUsage는 **세션 누적**이다. 캐시 재읽기(cacheReadInputTokens)가 매 턴
       * 더해지므로 이걸 더해 쓰면 창 크기를 금세 넘어선다 —
       * 실제로 "컨텍스트 533%"로 나타났다.
       * 지금 창에 무엇이 들어 있는지는 SDK의 getContextUsage()가 알고 있고,
       * 어댑터가 턴이 끝날 때 그걸 물어서 context_update를 낸다.
       */
      /*
       * **모든 모델을 더한다.** modelUsage는 모델마다 한 칸이고(sdk.d.ts: 본 루프·서브에이전트·압축 같은 내부 호출까지, 토큰과
       * 비용을 셀 때 쓰라는 칸), 턴 하나에 모델이 여럿이다 — 제목을 짓거나 도구 결과를 줄이는 작은 모델이 본 모델보다 먼저 올 수
       * 있다. 첫 칸만 읽던 동안, 앱이 부탁한 에이전트의 실행이 "1.1k tokens"로 적혔다: 기록 줄은 1108/13과 1038/16이었는데
       * CLI 기록에서 본 모델(Opus)은 출력만 200·363에 캐시 입력 24k–80k를 썼다. 적힌 것은 작은 모델의 몫이었다.
       */
      const sum = (field: string) => models.reduce((n, u) => n + Number(u[field] ?? 0), 0)
      out.push({
        type: 'usage_update',
        sessionId,
        tokens: {
          inputTokens: sum('inputTokens'),
          outputTokens: sum('outputTokens'),
          cacheReadTokens: sum('cacheReadInputTokens'),
          cacheCreationTokens: sum('cacheCreationInputTokens'),
          costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : undefined,
        },
      })
    }
    if (str(m.subtype) !== 'success' || m.is_error === true) {
      /*
       * 실패한 결말에는 `result`가 없고 `errors`(글의 목록)가 있다(sdk.d.ts SDKResultError). 둘 다 비었으면 끝난 방식의 이름이라도
       * 싣는다 — 앱이 부탁한 에이전트(M4 D-1)가 구조화 출력을 끝내 못 맞추면(`error_max_structured_output_retries`) 그 이름이
       * 앱이 받는 유일한 이유다.
       */
      const errors = Array.isArray(m.errors) ? m.errors.filter((x): x is string => typeof x === 'string' && x.length > 0) : []
      out.push({
        type: 'error',
        sessionId,
        error: { code: 'internal', message: str(m.result) || errors.join('\n') || `Turn failed: ${str(m.subtype)}`, retryable: true },
      })
    } else {
      // 스키마로 답한 턴의 답 (M4 D-1) — 글로는 오지 않고 여기에만 있다(protocol의 turn_complete 주석)
      out.push(m.structured_output === undefined ? { type: 'turn_complete', sessionId } : { type: 'turn_complete', sessionId, output: m.structured_output })
    }
    return out
  }

  return out
}

/**
 * 부모의 스트림 하나를 따라가며 정규화한다 — 메시지 하나만 봐서는 판단이 안 서는 것들의 기억.
 *
 * 둘 다 예전엔 어댑터 루프에 있었거나 아예 없었다:
 *
 *  1. **본문이 델타로 이미 나갔는가** (textStreamed, normalizeMessage의 opts 참고).
 *     assistant 메시지가 올 때마다 내려가는 표식인데, 서브에이전트의 assistant도
 *     그 "assistant"로 세고 있었다 (#98). 서브에이전트의 메시지가 부모의 마지막 델타와
 *     부모의 본문 사이에 끼면 표식이 부모의 본문 앞에서 먼저 내려가, **부모의 글 전체가
 *     한 번 더 붙었다.** 이제 부모의 메시지만 센다.
 *
 *  2. **띄워 둔 백그라운드 에이전트** (#98). 띄운 순간의 tool_result로는 카드를 닫지
 *     않는다(backgroundLaunch). 끝났다는 소식은 system/task_notification으로 오고
 *     (실측: tool_use_id·status·summary·usage{tool_uses, duration_ms}) 그때 닫는다.
 *     열어 둔 카드만 닫는다 — 통지는 부모가 직접 띄운 백그라운드 Bash에도, 서브에이전트
 *     안의 Bash(owned_by_subagent)에도 오는데(실측), 그 카드들은 이미 제 결과로 닫혀 있다.
 *
 *     **부모가 글을 쓰는 도중이면 닫기를 미룬다.** 에이전트 셋을 나란히 띄우면 하나가
 *     끝나는 순간 부모는 다른 하나의 소식을 받아 적고 있기 예사다(도그푸딩 세션).
 *     tool_result는 저장 쪽에서 글 덩어리의 경계라(manager persistMessage) 그 자리에서
 *     내면 부모의 문단이 행 둘로 갈린다 — 화면은 이어 붙여 그리지만 인수인계 기록과
 *     미리보기는 행을 읽는다. 부모가 내지 않은 사건으로 부모의 글이 잘리지 않게,
 *     그 덩어리가 닫히는 assistant 메시지 뒤로 보낸다.
 */
export class ClaudeStreamNormalizer {
  private textStreamed = false
  private readonly background = new Set<string>()
  /** 부모의 글 덩어리가 닫히기를 기다리는 에이전트 카드 닫기 */
  private deferred: NormalizedEvent[] = []

  constructor(private readonly sessionId: string) {}

  push(msg: unknown): NormalizedEvent[] {
    const m = msg as Json
    const type = str(m.type)
    const subagent = str(m.parent_tool_use_id) !== ''

    if (type === 'system' && str(m.subtype) === 'task_notification') {
      const callId = str(m.tool_use_id)
      if (!this.background.delete(callId)) return []
      const status = str(m.status, 'completed')
      const usage = (m.usage ?? {}) as Json
      const done: NormalizedEvent = {
        type: 'tool_result',
        sessionId: this.sessionId,
        callId,
        ok: status === 'completed',
        summary: agentReport(str(m.summary), agentStats(usage.tool_uses, usage.duration_ms, status)),
      }
      if (!this.textStreamed) return [done]
      this.deferred.push(done)
      return []
    }

    if (type === 'user' && !subagent) {
      const launched = backgroundLaunch(m)
      if (launched) this.background.add(launched)
    }

    const events = normalizeMessage(msg, this.sessionId, { textStreamed: this.textStreamed })
    if (subagent) return events
    if (type === 'stream_event' && events.some((e) => e.type === 'message_delta')) this.textStreamed = true
    // assistant 메시지가 한 본문의 끝이다 — 다음 본문은 다시 처음부터 센다
    if (type === 'assistant') this.textStreamed = false
    // 덩어리가 닫혔다(또는 본문 없이 턴이 끝났다) — 미뤄 둔 카드 닫기를 이제 낸다
    if ((type === 'assistant' || type === 'result') && this.deferred.length > 0) events.push(...this.deferred.splice(0))
    return events
  }

  /**
   * 아직 돌아오지 않은 에이전트의 카드를 **말없이 열어 두지 않는다.**
   *
   * 백그라운드 에이전트는 CLI 프로세스 안에서 돈다(task_type 'local_agent') — 프로세스를
   * 닫거나 잃으면 함께 사라지고, 통지는 영영 오지 않는다. 그대로 두면 카드는 "아직 일하는
   * 중"으로 남는다. 승인·질문 카드를 dispose에서 놓아주는 것과 같은 규칙이다.
   */
  release(why: string): NormalizedEvent[] {
    // 돌아왔지만 부모의 글이 닫히기를 기다리던 것은 제 결과로 닫는다 — 이미 끝난 일이다
    const out: NormalizedEvent[] = this.deferred.splice(0)
    for (const callId of this.background) out.push({ type: 'tool_result', sessionId: this.sessionId, callId, ok: false, summary: why })
    this.background.clear()
    return out
  }
}
