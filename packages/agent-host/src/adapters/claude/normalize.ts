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
export function normalizeMessage(msg: unknown, sessionId: string): NormalizedEvent[] {
  const m = msg as Json
  const type = str(m.type)
  const out: NormalizedEvent[] = []

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
        error: { code: 'internal', message: str(m.result, `턴 실패: ${str(m.subtype)}`), retryable: true },
      })
    } else {
      out.push({ type: 'turn_complete', sessionId })
    }
    return out
  }

  return out
}
