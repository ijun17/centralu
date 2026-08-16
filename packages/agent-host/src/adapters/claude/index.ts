import { query } from '@anthropic-ai/claude-agent-sdk'

/**
 * SDK Query 중 우리가 쓰는 부분만.
 * 외부 타입을 어댑터 밖으로 내보내지 않기 위해 최소 표면만 적는다.
 */
type QueryHandle = AsyncIterable<unknown> & {
  getContextUsage(): Promise<{ totalTokens?: number; maxTokens?: number } | undefined>
}
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AdapterCapabilities, ApprovalDecision, ApprovalScope, NormalizedEvent } from '@cc/protocol'
import { whichTool } from '../../env-path.js'
import { listClaudeSessions, readClaudeHistory } from './history.js'
import type { AgentAdapter, CreateSessionOpts, DetectResult, EventSink, SessionHandle } from '../contract.js'
import { approvalDetail, normalizeMessage } from './normalize.js'

const exec = promisify(execFile)

/**
 * Claude Code 어댑터 (M0 검증 반영 — docs/spikes/m0-findings.md).
 * 제약 3가지:
 *  1. allowedTools에 bare 도구명 금지 (canUseTool이 셰도잉됨)
 *  2. includePartialMessages: true (스트리밍 델타)
 *  3. settingSources를 지정하지 않아 사용자 훅·플러그인을 로드하지 않는다
 *     (Control Center 세션이 사용자 훅으로 오염되지 않도록 — 기본값 결정)
 */

type PendingApproval = { resolve: (r: { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }) => void; input: unknown }

const PRESET_MODE = {
  safe: 'default',
  normal: 'default',
  auto: 'bypassPermissions',
} as const

class ClaudeSession implements SessionHandle {
  externalId: string | null = null
  private queue: string[] = []
  private notify: (() => void) | null = null
  private closed = false
  private pending = new Map<string, PendingApproval>()
  /** 자동 승인 매처. 세션 시작 시 저장된 규칙을 주입받고, 'always' 응답으로 늘어난다 */
  private alwaysAllow = new Set<string>()
  private reqCounter = 0

  constructor(
    readonly sessionId: string,
    private opts: CreateSessionOpts,
    private emit: EventSink,
  ) {}

  async start(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- async generator 안에서 인스턴스 접근 필요
    const self = this
    const preset = this.opts.permissionPreset

    async function* input() {
      while (!self.closed) {
        const next = self.queue.shift()
        if (next !== undefined) {
          yield {
            type: 'user' as const,
            parent_tool_use_id: null,
            session_id: self.externalId ?? '',
            message: { role: 'user' as const, content: [{ type: 'text' as const, text: next }] },
          }
          continue
        }
        await new Promise<void>((r) => (self.notify = r))
      }
    }

    const q: QueryHandle = query({
      prompt: input(),
      options: {
        cwd: this.opts.cwd,
        model: this.opts.model,
        /**
         * SDK가 자체 동봉한 네이티브 CLI를 찾는데, host를 번들하면 그 경로가 깨진다
         * ("Native CLI binary for darwin-arm64 not found" — 배포 앱에서 세션 생성이 전부 실패했다).
         * 사용자가 이미 설치해 쓰는 `claude`를 직접 가리킨다. dev에서도 동일하게 동작한다.
         */
        pathToClaudeCodeExecutable: whichTool('claude') ?? undefined,
        includePartialMessages: true,
        permissionMode: PRESET_MODE[preset],
        resume: this.opts.resumeExternalId,
        // allowedTools는 절대 설정하지 않는다 (M0: canUseTool 셰도잉)
        canUseTool:
          preset === 'auto'
            ? undefined
            : async (toolName: string, toolInput: Record<string, unknown>) => {
                const detail = approvalDetail(toolName, toolInput, self.opts.cwd)
                const key = detail.kind === 'command' ? detail.command : `${toolName}:${detail.kind}`
                if (self.isAlwaysAllowed(key)) return { behavior: 'allow' as const, updatedInput: toolInput }

                const requestId = `req-${++self.reqCounter}`
                self.emit({ type: 'approval_request', sessionId: self.sessionId, requestId, detail })
                return new Promise((resolve) => {
                  self.pending.set(requestId, { resolve: resolve as PendingApproval['resolve'], input: toolInput })
                })
              },
      },
    })

    void (async () => {
      try {
        for await (const msg of q) {
          const m = msg as { type?: string; session_id?: string; subtype?: string }
          if (m.type === 'system' && m.subtype === 'init' && m.session_id) this.externalId = m.session_id
          for (const e of normalizeMessage(msg, this.sessionId)) this.emit(e)
          // 턴이 끝나면 지금 창에 무엇이 들어 있는지 묻는다 (FR-14)
          if (m.type === 'result') void this.reportContext(q)
        }
      } catch (err) {
        this.emit({
          type: 'error',
          sessionId: this.sessionId,
          error: { code: 'adapter_crashed', message: (err as Error).message, retryable: true },
        })
      }
    })()
  }

  send(text: string): void {
    this.queue.push(text)
    this.notify?.()
    this.notify = null
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'working' })
  }

  respondApproval(requestId: string, decision: ApprovalDecision, scope?: ApprovalScope, matcher?: string): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)
    if (decision === 'deny') {
      p.resolve({ behavior: 'deny', message: '사용자가 거부함' })
    } else {
      if (decision === 'always') {
        // 매처는 core가 계산해 UI가 보내준다 (agent-host는 core를 import하지 않는다 — 경계 규칙).
        // 없으면 명령 전문으로 대체한다.
        const cmd = (p.input as { command?: string }).command
        const m = matcher ?? cmd
        if (m) this.alwaysAllow.add(m)
      }
      p.resolve({ behavior: 'allow', updatedInput: p.input })
    }
    this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId, decision })
    void scope // scope별 영속화는 세션 매니저가 store에 기록한다
  }

  /** 저장된 규칙 주입 (재시작 후에도 '항상 허용'이 유지되도록) */
  applyRules(matchers: readonly string[]): void {
    for (const m of matchers) this.alwaysAllow.add(m)
  }

  /** 접미 와일드카드(`npm test*`)만 지원 — core의 matchesRule과 같은 규칙 */
  /**
   * 컨텍스트 사용량 보고 (FR-14).
   *
   * **SDK에 직접 묻는다.** result 메시지의 modelUsage로 계산하면 안 된다 —
   * 그건 세션 누적이라 캐시 재읽기가 매 턴 더해지고, 창 크기를 넘어선다
   * (실측: "컨텍스트 533%"). getContextUsage()는 지금 창의 점유를 돌려준다.
   *
   * 실패해도 조용히 넘어간다 — 게이지가 잠깐 안 보이는 것이 대화를 막는 것보다 낫다.
   */
  private async reportContext(q: QueryHandle): Promise<void> {
    try {
      const usage = await q.getContextUsage()
      const used = Number(usage?.totalTokens ?? 0)
      const window = Number(usage?.maxTokens ?? 0)
      if (window > 0 && used >= 0) {
        this.emit({ type: 'context_update', sessionId: this.sessionId, used, window, exactness: 'exact' })
      }
    } catch {
      // 컨텍스트를 못 물어봐도 대화는 계속된다
    }
  }

  private isAlwaysAllowed(key: string): boolean {
    for (const m of this.alwaysAllow) {
      if (m.endsWith('*') ? key.startsWith(m.slice(0, -1)) : key === m) return true
    }
    return false
  }

  interrupt(): void {
    // 진행 중 승인을 거부해 턴을 끊는다 (SDK interrupt는 스트림 모드에서 제한적)
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: '사용자가 중단함' })
      this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId: id, decision: 'deny' })
    }
    this.pending.clear()
    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'waiting_input', reason: 'interrupted' })
  }

  async dispose(): Promise<void> {
    this.closed = true
    this.notify?.()
    for (const [, p] of this.pending) p.resolve({ behavior: 'deny', message: '세션 종료' })
    this.pending.clear()
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly tool = 'claude' as const
  readonly capabilities: AdapterCapabilities = {
    approvals: true, // M0 검증: 전역 bypass를 세션 단위로 덮어쓸 수 있음
    contextUsage: 'exact',
    resume: true,
    listExternal: true, // SDK listSessions/getSessionMessages (공식 API)
    autoTitle: true,
    attachments: ['image', 'file'],
  }

  async detect(): Promise<DetectResult> {
    const path = whichTool('claude')
    try {
      const { stdout } = await exec(path ?? 'claude', ['--version'], { timeout: 5000 })
      // 어디에 설치된 것을 쓰는지 보여준다 — 여러 버전이 깔린 환경에서 혼란을 줄인다
      return { tool: 'claude', installed: true, loggedIn: true, detail: `${stdout.trim()} · ${path ?? 'PATH'}` }
    } catch {
      return {
        tool: 'claude',
        installed: false,
        loggedIn: false,
        detail: 'claude CLI를 찾을 수 없습니다 (터미널에서 which claude 로 확인)',
      }
    }
  }

  listExternalSessions(cwd: string, limit: number) {
    return listClaudeSessions(cwd, limit)
  }

  readExternalHistory(externalId: string, cwd: string, limit: number) {
    return readClaudeHistory(externalId, cwd, limit)
  }

  async createSession(opts: CreateSessionOpts, emit: EventSink): Promise<SessionHandle> {
    const s = new ClaudeSession(opts.sessionId, opts, emit)
    await s.start()
    return s
  }
}

export type { NormalizedEvent }
