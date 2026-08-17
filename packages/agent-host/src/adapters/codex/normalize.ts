import type { ApprovalDetail, NormalizedEvent } from '@cc/protocol'

/**
 * Codex 프로토콜 → NormalizedEvent 변환 (M0에서 확인한 메서드 이름 기준).
 *
 * 여기가 anti-corruption 경계다. 이 파일 밖으로 Codex 타입이 나가지 않는다.
 * 순수 함수로 유지해 계약 테스트가 프로세스 없이 돌게 한다.
 */

type Notification = { method: string; params?: unknown }
const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined)

/** 도구 호출 항목을 사람이 읽는 한 줄로 (대화창 카드 제목) */
function itemSummary(item: Record<string, unknown>): { tool: string; title: string; readOnly: boolean; paths: string[] } {
  const type = str(item.type)
  if (type === 'commandExecution') {
    const cmd = str(item.command)
    return { tool: 'Bash', title: cmd, readOnly: isReadOnlyCommand(cmd), paths: [] }
  }
  if (type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : []
    const paths = changes.map((c) => str(obj(c).path)).filter(Boolean)
    return { tool: 'Edit', title: paths.join(', ') || 'Edit files', readOnly: false, paths }
  }
  if (type === 'mcpToolCall') {
    return { tool: str(obj(item.invocation).tool) || 'MCP', title: str(item.title) || 'MCP tool', readOnly: false, paths: [] }
  }
  if (type === 'webSearch') {
    return { tool: 'WebSearch', title: str(item.query), readOnly: true, paths: [] }
  }
  return { tool: type || 'tool', title: str(item.title) || type, readOnly: true, paths: [] }
}

/** 조회성 명령은 카드를 접는다 (core의 정책과 같은 취지 — 여기선 힌트만 준다) */
function isReadOnlyCommand(cmd: string): boolean {
  const head = cmd.replace(/^\/bin\/\w*sh\s+-l?c\s+'?/, '').trimStart().split(/\s+/)[0] ?? ''
  return ['ls', 'cat', 'pwd', 'grep', 'rg', 'find', 'head', 'tail', 'wc', 'git'].includes(head)
}

export function approvalDetailFrom(method: string, params: Record<string, unknown>): ApprovalDetail {
  if (method === 'item/commandExecution/requestApproval') {
    const item = obj(params.item)
    return { kind: 'command', command: str(item.command) || str(params.command), cwd: str(item.cwd) || str(params.cwd) }
  }
  if (method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval') {
    const item = obj(params.item)
    const changes = Array.isArray(item.changes) ? item.changes : []
    const paths = changes.map((c) => str(obj(c).path)).filter(Boolean)
    const diff = changes.map((c) => str(obj(c).diff ?? obj(c).unifiedDiff)).filter(Boolean).join('\n')
    return {
      kind: 'file_edit',
      path: paths[0] ?? str(params.path) ?? '(no path)',
      diffPreview: diff.slice(0, 4000),
      multi: paths.length > 1,
    }
  }
  return { kind: 'other', raw: JSON.stringify(params).slice(0, 2000) }
}

/**
 * 알림 하나를 0~N개의 NormalizedEvent로 변환한다.
 * 모르는 알림은 **조용히 버린다** — 프로토콜이 늘어나도 깨지지 않아야 한다 (protocol.md §4).
 */
export function normalizeNotification(sessionId: string, n: Notification): NormalizedEvent[] {
  const p = obj(n.params)

  switch (n.method) {
    case 'item/agentMessage/delta':
      return [{ type: 'message_delta', sessionId, role: 'assistant', text: str(p.delta) || str(p.text) }]

    case 'item/started': {
      const item = obj(p.item)
      const type = str(item.type)
      if (type === 'userMessage' || type === 'reasoning' || type === 'agentMessage') return []
      const s = itemSummary(item)
      return [{ type: 'tool_call', sessionId, callId: str(item.id), summary: s }]
    }

    case 'item/completed': {
      const item = obj(p.item)
      const type = str(item.type)
      if (type === 'agentMessage') {
        // 스트리밍 델타를 못 받은 경우를 위한 보강 (델타가 있었으면 중복이므로 비운다)
        return str(item.text) ? [{ type: 'message_delta', sessionId, role: 'assistant', text: '' }] : []
      }
      if (type === 'userMessage' || type === 'reasoning') return []
      const s = itemSummary(item)
      const out: NormalizedEvent[] = [
        {
          type: 'tool_result',
          sessionId,
          callId: str(item.id),
          ok: str(item.status) !== 'failed',
          summary: (str(item.aggregatedOutput) || str(item.output) || '').slice(0, 2000),
        },
      ]
      // 파일을 실제로 바꿨으면 충돌 감지·하이라이트용으로 알린다 (FR-2, FR-5)
      if (s.paths.length > 0) out.push({ type: 'files_touched', sessionId, paths: s.paths })
      return out
    }

    case 'turn/completed':
      return [{ type: 'turn_complete', sessionId }]

    case 'turn/started':
      return [{ type: 'state_change', sessionId, state: 'working' }]

    case 'thread/tokenUsage/updated': {
      const usage = obj(obj(p.tokenUsage).total)
      const input = num(usage.inputTokens) ?? 0
      const output = num(usage.outputTokens) ?? 0
      const cached = num(usage.cachedInputTokens) ?? 0
      const total = num(usage.totalTokens) ?? input + output
      const window = num(p.contextWindow) ?? num(obj(p.tokenUsage).contextWindow)
      const events: NormalizedEvent[] = [
        { type: 'usage_update', sessionId, tokens: { inputTokens: input, outputTokens: output, cacheReadTokens: cached, cacheCreationTokens: 0 } },
      ]
      if (window) events.push({ type: 'context_update', sessionId, used: total, window, exactness: 'exact' })
      return events
    }

    case 'account/rateLimits/updated': {
      const primary = obj(obj(p.rateLimits).primary)
      const used = num(primary.usedPercent)
      const resetsAt = num(primary.resetsAt)
      return [
        {
          type: 'limit_reached',
          sessionId,
          usedPercent: used,
          windowMins: num(primary.windowDurationMins),
          resumeAt: resetsAt ? new Date(resetsAt * 1000).toISOString() : undefined,
        },
      ]
    }

    case 'thread/name/updated':
      return [{ type: 'session_title', sessionId, title: str(p.name) }]

    case 'thread/compacted':
      return [{ type: 'compaction', sessionId }]

    case 'error':
      return [
        {
          type: 'error',
          sessionId,
          error: { code: 'internal', message: str(obj(p.error).message) || str(p.message) || 'Unknown error', retryable: true },
        },
      ]

    default:
      return []
  }
}

/** 승인 응답을 Codex decision으로 (6종 중 우리가 쓰는 것만) */
export function toCodexDecision(decision: 'allow' | 'deny' | 'always'): string {
  if (decision === 'deny') return 'decline'
  if (decision === 'always') return 'acceptForSession' // '항상 허용·세션'과 정확히 대응 (M0 확인)
  return 'accept'
}
