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
  return { tool: name, title, readOnly: READ_ONLY.has(name), paths }
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
    }
    return out
  }

  if (type === 'assistant') {
    const content = ((m.message as Json | undefined)?.content ?? []) as Json[]
    // 델타 없이 온 본문의 유일한 출구 (위 opts.textStreamed 주석 참고 — /usage가 이 길로 온다)
    if (!opts?.textStreamed) {
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
        const paths = toolSummary(name, input).paths
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
    for (const block of content) {
      if (str(block.type) === 'tool_result') {
        const c = block.content
        out.push({
          type: 'tool_result',
          sessionId,
          callId: str(block.tool_use_id),
          ok: block.is_error !== true,
          summary: (typeof c === 'string' ? c : JSON.stringify(c ?? '')).slice(0, 300),
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
            if (str(source.type) !== 'base64' || !str(source.data)) continue
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

  // 한도 (M0 발견: rate_limit_event.rate_limit_info)
  if (type === 'rate_limit_event') {
    const info = (m.rate_limit_info ?? {}) as Json
    if (str(info.status) !== 'allowed') {
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
    const first = Object.values(modelUsage)[0]
    if (first) {
      /*
       * 컨텍스트 사용량은 여기서 계산하지 않는다.
       *
       * modelUsage는 **세션 누적**이다. 캐시 재읽기(cacheReadInputTokens)가 매 턴
       * 더해지므로 이걸 더해 쓰면 창 크기를 금세 넘어선다 —
       * 실제로 "컨텍스트 533%"로 나타났다.
       * 지금 창에 무엇이 들어 있는지는 SDK의 getContextUsage()가 알고 있고,
       * 어댑터가 턴이 끝날 때 그걸 물어서 context_update를 낸다.
       */
      out.push({
        type: 'usage_update',
        sessionId,
        tokens: {
          inputTokens: Number(first.inputTokens ?? 0),
          outputTokens: Number(first.outputTokens ?? 0),
          cacheReadTokens: Number(first.cacheReadInputTokens ?? 0),
          cacheCreationTokens: Number(first.cacheCreationInputTokens ?? 0),
          costUsd: typeof m.total_cost_usd === 'number' ? m.total_cost_usd : undefined,
        },
      })
    }
    if (str(m.subtype) !== 'success' || m.is_error === true) {
      out.push({
        type: 'error',
        sessionId,
        error: { code: 'internal', message: str(m.result, `Turn failed: ${str(m.subtype)}`), retryable: true },
      })
    } else {
      out.push({ type: 'turn_complete', sessionId })
    }
    return out
  }

  return out
}
