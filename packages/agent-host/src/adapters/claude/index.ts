import { query } from '@anthropic-ai/claude-agent-sdk'

/**
 * SDK Query 중 우리가 쓰는 부분만.
 * 외부 타입을 어댑터 밖으로 내보내지 않기 위해 최소 표면만 적는다.
 */
type QueryHandle = AsyncIterable<unknown> &
  UsageQuery &
  ModelQuery & {
    getContextUsage(): Promise<{ totalTokens?: number; maxTokens?: number } | undefined>
    /** 진행 중인 턴을 끊는다. 스트리밍 입력 모드에서만 쓸 수 있다 — 우리가 쓰는 모드가 그렇다 */
    interrupt(): Promise<unknown>
    supportedCommands(): Promise<{ name: string; description?: string; argumentHint?: string }[]>
  }
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type {
  AdapterCapabilities,
  ApprovalDecision,
  ApprovalScope,
  NormalizedEvent,
  Question,
  QuestionAnswer,
} from '@cc/protocol'
import { whichTool } from '../../env-path.js'
import { listClaudeSessions, readClaudeHistory } from './history.js'
import { readUsage, type UsageQuery } from './usage.js'
import { ORCHESTRATOR_MCP_NAME, orchestratorMcp } from './orchestrator-mcp.js'
import { readClaudeModels, type ModelQuery } from './models.js'
import type { AgentAdapter, CreateSessionOpts, DetectResult, EventSink, SessionHandle } from '../contract.js'
import { approvalDetail, normalizeMessage } from './normalize.js'

const exec = promisify(execFile)

/**
 * Claude Code 어댑터 (M0 검증 반영 — docs/spikes/m0-findings.md).
 * 제약 3가지:
 *  1. allowedTools에 bare 도구명 금지 (canUseTool이 셰도잉됨)
 *  2. includePartialMessages: true (스트리밍 델타)
 *  3. settingSources를 지정하지 않는다 = **사용자 설정·훅·CLAUDE.md를 전부 로드한다.**
 *     (한때 주석이 정반대로 적혀 있었다. 실측: 생략하면 전역 훅 3개가 실제로 돌았다.)
 *     의도한 것이다 — 이 앱은 워크플로우를 강제하지 않는다. 사람이 자기 도구에
 *     맞춰 둔 설정은 이 앱 안에서도 그대로 살아 있어야 한다.
 *     예외는 오케스트레이터뿐이다(settingSources: []): 그쪽은 파일로 들어오는 지시가
 *     곧 권한 상승 통로라서 닫아 둔다.
 */

type PendingApproval = { resolve: (r: { behavior: 'allow'; updatedInput: unknown } | { behavior: 'deny'; message: string }) => void; input: unknown }

/**
 * AskUserQuestion의 인자 → 우리 Question[].
 *
 * SDK 타입을 믿지 않고 직접 읽는다 (경계 규칙). 형태가 어긋나면 빈 배열을 돌려
 * **평소 경로로 흘려보낸다** — 반쯤 그린 선택지를 내미는 것보다 낫다.
 */
function parseQuestions(input: unknown): Question[] {
  const raw = (input as { questions?: unknown })?.questions
  if (!Array.isArray(raw)) return []
  const out: Question[] = []
  for (const q of raw) {
    const o = (q ?? {}) as Record<string, unknown>
    const opts = Array.isArray(o.options) ? o.options : []
    const options = opts
      .map((x) => {
        const t = (x ?? {}) as Record<string, unknown>
        return { label: String(t.label ?? ''), description: String(t.description ?? '') }
      })
      .filter((x) => x.label !== '')
    if (typeof o.question !== 'string' || options.length === 0) continue
    out.push({
      question: o.question,
      header: typeof o.header === 'string' ? o.header : '',
      options,
      multiSelect: o.multiSelect === true,
    })
  }
  return out
}

/**
 * 프리셋 → SDK 권한 옵션.
 *
 * **normal은 값을 보내지 않는다.** 이 앱은 사용자 설정·훅·CLAUDE.md를 전부 로드하면서
 * (settingSources 미지정) 권한만 조용히 덮어쓰고 있었다. 워크플로우를 강제하지 않는다는
 * 원칙과 어긋나는 자리는 거기였다.
 *
 * 그런데 **그냥 빼면 안 된다.** 실측(probe-perm2.mts):
 *
 *   permissionMode:'default'                 우리 콜백 불림   (설정 무시)
 *   permissionMode:'bypassPermissions'       안 불림
 *   아무것도 안 보냄                          우리 콜백 불림   ← 설정 여전히 무시!
 *   안 보냄 + resolvePermissionModeInCli      안 불림          ← 설정이 살아났다
 *
 * 안 보내도 SDK가 'default'로 굳힌다. 그래서 **아무것도 안 바꾸면서 바꾼 줄 알게 되는**
 * 변경이 될 뻔했다. CLI에게 해석을 넘기라고 명시해야 비로소 설정이 산다.
 *
 * 이 값으로 세 프리셋의 뜻이 처음으로 서로 달라진다 —
 * 전에는 safe와 normal이 글자 그대로 같은 동작이었다.
 */
function permissionOptionsFor(preset: 'safe' | 'normal' | 'auto'): Record<string, unknown> {
  if (preset === 'auto') return { permissionMode: 'bypassPermissions' } // 무조건 통과
  if (preset === 'safe') return { permissionMode: 'default' } // 내 설정과 무관하게 항상 묻는다
  return { resolvePermissionModeInCli: true } // 내 설정을 따른다
}

class ClaudeSession implements SessionHandle {
  externalId: string | null = null
  private queue: string[] = []
  private notify: (() => void) | null = null
  private closed = false
  /** 답을 기다리는 선택지들. 승인과 달리 **여러 장이 동시에 떠 있을 수 있다** */
  private questions = new Map<string, (r: unknown) => void>()
  private pending = new Map<string, PendingApproval>()
  /** 살아 있는 질의 — 슬래시 명령·컨텍스트를 물어보는 창구 */
  private query: QueryHandle | null = null
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

    // 사용량은 계정의 성질이지만 SDK는 Query에만 그 메서드를 둔다 — 최근 질의를 빌려 쓴다
    const q: QueryHandle = (ClaudeAdapter.lastQuery = this.query = query({
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
        /*
         * 추론 강도. 모델이 지원할 때만 의미가 있어서, 지원 여부 판단은
         * 목록을 주는 쪽(supportedModels)에 맡기고 여기서는 받은 값을 넘기기만 한다.
         */
        effort: this.opts.effort as never,
        includePartialMessages: true,
        /*
         * 오케스트레이터에게만 도구를 준다 (FR-11).
         * 인프로세스 MCP라 별도 프로세스가 없고, 이 도구들이 볼 수 있는 것은
         * 매니저가 넘겨준 것뿐이다 — 이 앱이 관리하는 세션 밖으로 나갈 방법이 없다.
         */
        ...(this.opts.orchestratorTools
          ? {
              mcpServers: { [ORCHESTRATOR_MCP_NAME]: orchestratorMcp(this.opts.orchestratorTools) },
              /*
               * **파일에서 지시를 읽지 않는다.**
               *
               * 워커 세션은 자기 프로젝트에만 권한이 있지만 파일은 쓸 수 있다.
               * 그 세션이 오케스트레이터 폴더에 지시문을 써 넣으면, 모든 세션에
               * 지시할 수 있는 오케스트레이터가 그걸 자기 지시로 읽는다 —
               * 낮은 권한에서 높은 권한으로 넘어가는 길이다.
               *
               * 실측값 (probe):
               *   생략        CLAUDE.md 읽음 · 사용자 전역 훅 3개 실행
               *   ['project'] CLAUDE.md 읽음 · 훅 0개
               *   []          아무것도 안 읽음      ← 관제탑에는 이것뿐이다
               *
               * 역할은 아래 systemPrompt로 직접 주입한다. 파일을 거치지 않으므로
               * 도중에 누구도 바꿔 쓸 수 없다.
               */
              settingSources: [] as never,
              /*
               * 역할은 파일이 아니라 여기서 보증한다. AGENTS.md는 사람이 고칠 수 있고
               * 고쳐야 하는 파일이라, 지워지면 안 되는 것을 거기 두면 안 된다.
               */
              ...(this.opts.systemPromptAppend
                ? { systemPrompt: { type: 'preset' as const, preset: 'claude_code' as const, append: this.opts.systemPromptAppend } }
                : {}),
            }
          : {}),
        ...permissionOptionsFor(preset),
        resume: this.opts.resumeExternalId,
        // allowedTools는 절대 설정하지 않는다 (M0: canUseTool 셰도잉)
        canUseTool:
          preset === 'auto'
            ? undefined
            : async (toolName: string, toolInput: Record<string, unknown>) => {
                /*
                 * **우리 도구는 우리가 보증한다.**
                 *
                 * 오케스트레이터의 centralu 도구는 이 앱이 관리하는 세션 밖으로
                 * 나갈 수 없고(매니저만 본다), 진짜 위험한 일 — 대상 세션이 무엇을
                 * 실행하는가 — 은 **그 세션의 권한 설정이 그대로 가른다.**
                 * 여기서 또 물으면 승인이 두 겹이 되고, "한 창에서 지시한다"는
                 * 이 기능의 존재 이유가 사라진다.
                 *
                 * 실측에서 이걸 안 하면 목록 한 번 읽는 데도 승인 창이 떠서
                 * 오케스트레이터가 첫 도구에서 멈춰 섰다.
                 */
                if (toolName.startsWith(`mcp__${ORCHESTRATOR_MCP_NAME}__`)) {
                  return { behavior: 'allow' as const, updatedInput: toolInput }
                }

                /*
                 * **선택지는 승인이 아니라 질문이다** (FR: AskUserQuestion).
                 *
                 * 실측으로 길을 찾았다 (probe-askuserquestion.mts):
                 *   canUseTool로 온다        ✅ 인자(질문·선택지)가 통째로 들어온다
                 *   onUserDialog로 온다      ❌ 종류를 선언해도 한 번도 안 불렸다
                 *   그냥 실행시키면          → "The user did not answer the questions."
                 *
                 * 그래서 여기서 가로채 사람에게 묻고, 답을 **deny의 message로 돌려준다.**
                 * 이상해 보이지만 그 message가 곧 이 도구의 결과로 모델에게 간다 —
                 * 실측에서 모델은 "사용자는 라면을 골랐습니다"라고 정확히 읽었다.
                 * allow로 보내면 CLI가 자기 화면을 띄우려다 실패하고 답 없이 끝난다.
                 */
                if (toolName === 'AskUserQuestion') {
                  const questions = parseQuestions(toolInput)
                  // 질문 형태가 아니면 우리가 그릴 수 없다 — 삼키지 말고 평소대로 흘린다
                  if (questions.length === 0) return { behavior: 'allow' as const, updatedInput: toolInput }
                  const requestId = `q-${++self.reqCounter}`
                  self.emit({ type: 'question_request', sessionId: self.sessionId, requestId, questions })
                  return new Promise((resolve) => {
                    self.questions.set(requestId, resolve as (r: unknown) => void)
                  })
                }
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
    }))

    void (async () => {
      try {
        for await (const msg of q) {
          const m = msg as { type?: string; session_id?: string; subtype?: string }
          if (m.type === 'system' && m.subtype === 'init' && m.session_id) this.externalId = m.session_id
          for (const e of normalizeMessage(msg, this.sessionId)) this.emit(e)
          // 턴이 끝나면 지금 창에 무엇이 들어 있는지 묻는다 (FR-14)
          if (m.type === 'result') void this.reportContext(q)
        }
        /*
         * **스트림이 끝났는데 우리가 닫은 게 아니면 CLI가 죽은 것이다.**
         *
         * CLI 프로세스가 조용히 사라지면 스트림은 예외 없이 그냥 끝나기도 한다.
         * 그때 아무 말도 안 올리면 화면은 영원히 '작업 중'이고 다음 말은 허공으로 간다 —
         * codex 어댑터가 onExit(expected=false)에서 하는 것과 같은 신호를 올린다.
         */
        if (!this.closed) {
          this.emit({
            type: 'error',
            sessionId: this.sessionId,
            error: { code: 'adapter_crashed', message: 'claude process ended unexpectedly', retryable: true },
          })
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

  respondApproval(requestId: string, decision: ApprovalDecision, scope?: ApprovalScope, matcher?: string): boolean {
    const p = this.pending.get(requestId)
    // 프로세스를 갈아 끼우면 이 맵은 비어서 다시 뜬다 — 그 전에 뜬 카드의 id는 여기에 없다
    if (!p) return false
    this.pending.delete(requestId)
    if (decision === 'deny') {
      p.resolve({ behavior: 'deny', message: 'Denied by user' })
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
    return true
  }

  /**
   * 선택지에 답한다. 승인과 같은 규칙 — **닿았는지를 돌려준다.**
   *
   * 답은 deny의 message로 나간다. 그 message가 이 도구의 결과가 되어 모델에게 간다
   * (실측으로 확인). 거절이라는 이름이지만 실제로 전달되는 것은 사람이 고른 내용이다.
   */
  answerQuestion(requestId: string, answers: QuestionAnswer[]): boolean {
    const resolve = this.questions.get(requestId)
    if (!resolve) return false
    this.questions.delete(requestId)
    resolve({ behavior: 'deny', message: JSON.stringify({ answers }) })
    this.emit({ type: 'question_resolved', sessionId: this.sessionId, requestId })
    return true
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
  /** 슬래시 명령 목록 (SDK 공개 API) */
  async listCommands(): Promise<{ name: string; description?: string; argumentHint?: string }[]> {
    if (!this.query) throw new Error('Session is not ready yet')
    return this.query.supportedCommands()
  }

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

  /**
   * 중단.
   *
   * 두 가지를 **둘 다** 해야 한다. 예전엔 승인만 거절하고 말았는데,
   * 그러면 도구를 기다리던 턴만 풀릴 뿐 모델이 그냥 생각 중일 때는 아무 일도 일어나지 않았다.
   * 버튼은 눌리는데 아무것도 멈추지 않는 것 — 이 프로젝트가 금지하는 조용한 실패다.
   *
   *   1) 대기 중 승인 거절: canUseTool이 promise를 붙들고 있으면 그 자리에서 멈춰 있어
   *      중단 신호가 도착해도 정리될 지점이 없다. 먼저 풀어준다.
   *   2) SDK interrupt: 실제로 턴을 끊는다. 우리는 프롬프트를 async generator로 넘기는
   *      스트리밍 입력 모드라 이 메서드를 쓸 수 있다.
   */
  interrupt(): void {
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: 'Stopped by user' })
      this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId: id, decision: 'deny' })
    }
    this.pending.clear()
    this.releaseQuestions('Stopped by user')

    void this.query?.interrupt().catch((err: Error) => {
      // 못 끊었으면 그렇다고 말한다. 멈춘 줄 알고 기다리게 두는 게 제일 나쁘다.
      this.emit({
        type: 'error',
        sessionId: this.sessionId,
        error: { code: 'internal', message: `Could not stop: ${err.message}`, retryable: true },
      })
    })

    this.emit({ type: 'state_change', sessionId: this.sessionId, state: 'waiting_input', reason: 'interrupted' })
  }

  /**
   * 매달린 승인을 **말없이 놓지 않는다.**
   *
   * 여기서 알리지 않으면 화면에는 승인 카드가 그대로 남는다. 그 카드의 requestId는
   * 새로 뜬 프로세스의 맵에 없으므로 눌러도 아무 일이 없고, 세션은 멀쩡히 idle인데
   * 화면만 "에이전트가 막혀 있음"이라고 말한다 — 나가는 길이 없는 상태다.
   * interrupt()는 이미 이렇게 하고 있었다. 프로세스를 갈아 끼울 때만 빠져 있었다.
   */
  async dispose(): Promise<void> {
    this.closed = true
    this.notify?.()
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: 'Session closed' })
      this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId: id, decision: 'deny' })
    }
    this.pending.clear()
    this.releaseQuestions('Session closed')
  }

  /** 답을 기다리던 선택지를 놓아준다 — 승인과 같은 이유로 **말없이 놓지 않는다** */
  private releaseQuestions(why: string): void {
    for (const [id, resolve] of this.questions) {
      resolve({ behavior: 'deny', message: why })
      this.emit({ type: 'question_resolved', sessionId: this.sessionId, requestId: id })
    }
    this.questions.clear()
  }
}

/**
 * 로그인 여부를 CLI에게 **직접 묻는다** (`claude auth status --json`).
 *
 * `claude --version`은 인증을 아예 보지 않는다 — 자격이 하나도 없어도 성공한다.
 * 그래서 예전에는 "깔려 있음"이 곧 "로그인됨"이었고, 화면은 로그인 안 된 Claude를
 * 언제나 초록 점으로 그렸다. 세션을 시작해 봐야 그제서야 실패했다 (#11).
 *
 * **왜 `claude -p`로 진짜 질의를 던지지 않는가:**
 * detect()는 앱이 뜰 때마다, 새 세션 다이얼로그를 열 때마다 도는 길목이다.
 * 여기서 추론을 한 번이라도 태우면 **앱을 켜는 행위 자체에 과금이 붙는다.**
 * 인증 여부를 알자고 치를 값이 아니다.
 *
 * **왜 codex처럼 자격 파일 존재 확인으로 하지 않는가:**
 * Claude Code의 자격은 한 곳에 있지 않다 — macOS 키체인, OAuth 토큰,
 * `ANTHROPIC_API_KEY`, `apiKeyHelper`, Bedrock/Vertex 중 어디든 될 수 있고
 * `CLAUDE_CONFIG_DIR`이 그 위치를 통째로 옮긴다. 그 목록을 우리가 흉내내면
 * CLI가 한 번 바뀔 때마다 우리 판정이 틀린다. **CLI가 아는 것은 CLI에게 묻는다.**
 *
 * 실측(2.1.223): 네트워크를 타지 않는다 — 죽은 프록시를 물려도 답이 같고 0.2초에
 * 끝난다. `CLAUDE_CONFIG_DIR`도, `ANTHROPIC_API_KEY`도 CLI가 알아서 반영한다.
 *
 * 로그인 안 됐을 때는 **종료 코드 1**이지만 stdout에는 JSON이 그대로 나온다.
 * 그래서 던져진 오류에 붙어 온 stdout도 읽는다.
 *
 * 판단이 안 서면 **통과시킨다**(true). 틀린 "로그인 안 됨"은 멀쩡한 것을 고치게
 * 만들어서 지금 상태보다 나쁘다. 옛 CLI에는 `auth` 하위 명령이 없어서
 * JSON 대신 오류 문구가 나오는데, 그건 "로그인 안 됨"이 아니라 "모름"이다.
 */
async function claudeLoggedIn(bin: string): Promise<boolean> {
  let out = ''
  try {
    out = (await exec(bin, ['auth', 'status', '--json'], { timeout: 5000 })).stdout
  } catch (e) {
    // 종료 코드 1(=로그인 안 됨)이어도 stdout의 JSON은 믿을 수 있다
    out = typeof (e as { stdout?: unknown }).stdout === 'string' ? (e as { stdout: string }).stdout : ''
  }
  try {
    const flag = (JSON.parse(out) as { loggedIn?: unknown }).loggedIn
    return typeof flag === 'boolean' ? flag : true
  } catch {
    return true // JSON이 아니면 이 CLI는 auth status를 모르는 것이다 — 모르면 통과
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly tool = 'claude' as const
  /**
   * 사용량을 물어볼 창구.
   *
   * 사용량은 **계정**의 성질인데 SDK는 세션(Query)에만 그 메서드를 준다.
   * 그래서 살아 있는 질의 하나를 빌려 쓴다 — 어느 세션에 묻든 답은 같다.
   */
  /** 사용량·모델 목록은 계정의 성질인데 SDK는 둘 다 Query에만 둔다 — 최근 질의를 빌려 쓴다 */
  static lastQuery: (UsageQuery & ModelQuery) | null = null
  readonly capabilities: AdapterCapabilities = {
    approvals: true, // M0 검증: 전역 bypass를 세션 단위로 덮어쓸 수 있음
    contextUsage: 'exact',
    resume: true,
    autoTitle: true,
    attachments: ['image', 'file'],
  }

  async detect(): Promise<DetectResult> {
    const path = whichTool('claude')
    try {
      const { stdout } = await exec(path ?? 'claude', ['--version'], { timeout: 5000 })
      // 어디에 설치된 것을 쓰는지 보여준다 — 여러 버전이 깔린 환경에서 혼란을 줄인다
      const version = `${stdout.trim()} · ${path ?? 'PATH'}`
      const loggedIn = await claudeLoggedIn(path ?? 'claude')
      return {
        tool: 'claude',
        installed: true,
        loggedIn,
        detail: loggedIn ? version : `${version} · login required`,
      }
    } catch {
      return {
        tool: 'claude',
        installed: false,
        loggedIn: false,
        detail: 'claude CLI not found (check with `which claude` in a terminal)',
      }
    }
  }

  listExternalSessions(cwd: string, limit: number) {
    return listClaudeSessions(cwd, limit)
  }

  /**
   * 계정 사용량 (FR-9).
   *
   * **살아 있는 세션이 있어야 물어볼 수 있다** — SDK가 Query에만 이 메서드를 둔다.
   * 세션이 하나도 없으면 던지고, 매니저가 이유와 함께 degrade한다.
   */
  async listUsage() {
    const q = ClaudeAdapter.lastQuery
    if (!q) throw new Error('A running session is required to read usage')
    return readUsage(q)
  }

  async listModels() {
    // 사용량과 같은 사정 — SDK는 이 메서드도 Query에만 둔다
    const q = ClaudeAdapter.lastQuery
    if (!q) throw new Error('A running session is required to list models')
    return readClaudeModels(q)
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
