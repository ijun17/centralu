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
    /*
     * 이름은 **최상위의 server·tool**에 있다 (generated/v2/ThreadItem.ts).
     * invocation.tool을 읽고 있어서 코덱스의 MCP 호출이 전부 'MCP'로 뭉개져 보였다 —
     * 오케스트레이터를 코덱스로 돌려보다 드러났다.
     */
    const tool = str(item.tool) || str(obj(item.invocation).tool)
    const server = str(item.server)
    return {
      tool: tool || 'MCP',
      title: [server, tool].filter(Boolean).join(': ') || str(item.title) || 'MCP tool',
      readOnly: false,
      paths: [],
    }
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
      /*
       * 압축은 도구 호출이 아니다. 이걸 걸러내지 않으면 대화에 'contextCompaction'이라는
       * 정체불명의 도구 줄이 생긴다 — 그리고 정작 필요한 "지금 압축 중"은 어디에도 없다.
       */
      if (type === 'contextCompaction') return [{ type: 'activity', sessionId, activity: 'compacting' }]
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
      // 마커는 thread/compacted가 낸다 — 여기서 또 내면 같은 자리에 두 줄이 생긴다
      if (type === 'contextCompaction') return [{ type: 'activity', sessionId, activity: null }]
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
      /*
       * Context occupancy comes from `last`, not `total`.
       *
       * `ThreadTokenUsage` carries both (generated/v2/ThreadTokenUsage.ts): `total` is what
       * the thread has spent since it began, `last` is the most recent turn. Reading `total`
       * put a running sum against a fixed window, so the gauge climbed forever — it reached
       * **149,084%** on a real session (1,235,017,921 against a 828,400 window) before this
       * was noticed. Cumulative spend is a billing number and stays with `usage_update`;
       * how full the window is describes one request.
       */
      const lastTurn = obj(obj(p.tokenUsage).last)
      const input = num(usage.inputTokens) ?? 0
      const output = num(usage.outputTokens) ?? 0
      const cached = num(usage.cachedInputTokens) ?? 0
      const total = num(usage.totalTokens) ?? input + output
      /*
       * The field is `modelContextWindow`, on the tokenUsage object — see
       * generated/v2/ThreadTokenUsage.ts. We read `contextWindow` for a long time, found
       * nothing, and skipped the event: `usage_update` still went out, so tokens worked
       * and only the percentage was missing. The adapter meanwhile declared
       * `contextUsage: 'exact'`, so the app promised a number it never sent.
       *
       * The older names stay in the chain because a running Codex may predate the rename,
       * and reading a field that isn't there costs nothing.
       */
      const usageObj = obj(p.tokenUsage)
      const window =
        num(usageObj.modelContextWindow) ?? num(p.contextWindow) ?? num(usageObj.contextWindow)
      const events: NormalizedEvent[] = [
        { type: 'usage_update', sessionId, tokens: { inputTokens: input, outputTokens: output, cacheReadTokens: cached, cacheCreationTokens: 0 } },
      ]
      const occupied = num(lastTurn.totalTokens)
      if (window && occupied !== undefined && occupied <= window) {
        events.push({ type: 'context_update', sessionId, used: occupied, window, exactness: 'exact' })
      } else if (window && occupied !== undefined) {
        /*
         * More tokens than the window holds is not a reading, it is a misread field — the
         * shape this bug took the first time. Emit nothing and say so: a blank gauge is
         * honest, and 149,084% was not.
         */
        warnImpossibleContext(occupied, window)
      } else {
        // Say it out loud. A silent skip here is what let a renamed field hide for weeks.
        warnMissingContextWindow(usageObj)
      }
      return events
    }

    /*
     * 사용량 갱신은 **한도에 걸린 것과 다르다.**
     *
     * 여기에 조건이 없어서 코덱스 세션은 첫 도구 호출 직후 곧바로 'limited'가 됐다 —
     * 실측에서 usedPercent 27%인데도 그랬다. 그러면 아이콘 회전이 멈추고 흐려지고,
     * 있지도 않은 "Limit 27%" 딱지가 붙는다 (도그푸딩: "배시 돌 때 로딩이 안 돈다").
     *
     * 도구는 걸렸는지를 직접 알려준다 — `rateLimitReachedType`이 null이면 안 걸린 것이다
     * (Claude 어댑터도 `status !== 'allowed'`일 때만 낸다. 같은 규칙이어야 한다).
     * 남는 사용량 정보는 잃지 않는다: 사용량 창이 `agents.usage`로 따로 읽는다.
     */
    case 'account/rateLimits/updated': {
      const snapshot = obj(p.rateLimits)
      const reached = str(snapshot.rateLimitReachedType) !== '' || snapshot.spendControlReached === true
      if (!reached) return []

      const primary = obj(snapshot.primary)
      const resetsAt = num(primary.resetsAt)
      return [
        {
          type: 'limit_reached',
          sessionId,
          usedPercent: num(primary.usedPercent),
          windowMins: num(primary.windowDurationMins),
          resumeAt: resetsAt ? new Date(resetsAt * 1000).toISOString() : undefined,
        },
      ]
    }

    case 'thread/name/updated':
      // 도구가 스스로 지은 이름이다 → auto:true. 사람이 정한 이름은 이걸로 덮이지 않는다 (이슈 #5)
      return [{ type: 'session_title', sessionId, title: str(p.name), auto: true }]

    case 'thread/compacted':
      return [{ type: 'compaction', sessionId, failed: false }]

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

/*
 * Warn once per process: this fires on every token update of every Codex session, and a
 * repeating line would be noise rather than a signal.
 */
let warnedContextWindow = false
function warnMissingContextWindow(usage: Record<string, unknown>): void {
  if (warnedContextWindow) return
  warnedContextWindow = true
  console.error(
    '[codex] token usage carried no context window — the context gauge will stay empty. ' +
      `Fields present: ${Object.keys(usage).join(', ') || '(none)'}`,
  )
}

/** Warn once per process — this would otherwise repeat on every turn of every session. */
let warnedImpossible = false
function warnImpossibleContext(used: number, window: number): void {
  if (warnedImpossible) return
  warnedImpossible = true
  console.error(
    `[codex] context reading exceeds the window (${used} of ${window}) — gauge left empty. ` +
      'A used-vs-window ratio above 1 means the wrong field was read, not a full context.',
  )
}

/**
 * Reset the warn-once flags. Tests only.
 *
 * The flags exist so a misread field doesn't print on every turn of every session, but that
 * makes them process state: the second test to check for a warning would find it already
 * spent and pass for the wrong reason. Same shape as `__setSessionApiForTest` in the Claude
 * adapter — production keeps the behaviour, tests get a way to start clean.
 */
export function __resetWarningsForTest(): void {
  warnedContextWindow = false
  warnedImpossible = false
}
