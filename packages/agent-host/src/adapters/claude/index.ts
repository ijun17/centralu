import { query, type McpServerConfig } from '@anthropic-ai/claude-agent-sdk'

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
    /** 질의를 닫고 CLI 프로세스를 끝낸다 (sdk.d.ts) — dispose가 부른다 (#157) */
    close(): void
    /**
     * 동적으로 붙인 MCP 서버의 집합을 **통째로 바꾼다** (sdk.d.ts). 처음 `mcpServers`로 넘긴
     * 인프로세스 서버도 이 집합에 들어 있다(설치된 0.3.263의 sdk.mjs: 초기 SDK 서버가 같은
     * 맵에 앉는다) — 그래서 부를 때마다 오케스트레이터 서버까지 전부 실어야 한다.
     */
    setMcpServers(servers: Record<string, McpServerConfig>): Promise<{ added: string[]; removed: string[]; errors: Record<string, string> }>
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
  ToolDescriptor,
} from '@cc/protocol'
import { whichTool } from '../../env-path.js'
import { deleteClaudeSession, listClaudeSessions, readClaudeHistory } from './history.js'
import { readUsage, type UsageQuery } from './usage.js'
import { ORCHESTRATOR_MCP_NAME, orchestratorMcp } from './orchestrator-mcp.js'
import { appProxy, type AppProxy } from './app-proxy.js'
import { APP_MCP_PREFIX } from '../../apps/contract.js'
import { readClaudeModels, type ModelQuery } from './models.js'
import type { AgentAdapter, CreateSessionOpts, DetectResult, EventSink, SessionHandle } from '../contract.js'
import { approvalDetail, ClaudeStreamNormalizer } from './normalize.js'

const exec = promisify(execFile)

/**
 * Claude Code 어댑터 (M0 검증 반영 — docs/spikes/m0-findings.md).
 * 제약 3가지:
 *  1. allowedTools에 bare 도구명 금지 (canUseTool이 셰도잉됨)
 *  2. includePartialMessages: true (스트리밍 델타)
 *  3. 신뢰한 프로젝트에서는 settingSources를 지정하지 않는다 = **사용자·프로젝트 설정·훅·CLAUDE.md를
 *     전부 로드한다.** (한때 주석이 정반대로 적혀 있었다. 실측: 생략하면 전역 훅 3개가 실제로 돌았다.)
 *     의도한 것이다 — 이 앱은 워크플로우를 강제하지 않는다. 사람이 자기 도구에
 *     맞춰 둔 설정은 이 앱 안에서도 그대로 살아 있어야 한다.
 *     예외가 둘이다(settingSourcesFor): 오케스트레이터·조율 세션(settingSources: [] — 파일로 들어오는
 *     지시가 곧 권한 상승 통로다)과, 신뢰하지 않은 프로젝트(['user'] — 저장소의 파일이 승인을 정하지 못한다, #92).
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
 * 이 도구가 **우리 인프로세스 서버의** 도구인가 (승인 예외의 판정).
 *
 * MCP 도구 이름은 `mcp__<서버>__<도구>`이고 칸막이가 `__`다. 그래서 접두 검사
 * (`startsWith('mcp__centralu__')`)는 서버 이름 자체를 보지 못한다 —
 * `centralu__pw`라는 이름의 서버가 내놓는 `mcp__centralu__pw__navigate`도 통과했고,
 * 그 도구는 canUseTool을 통째로 건너뛰었다 (실측, #93).
 *
 * 칸을 세어 **서버 이름 전체**로 판정한다. 우리 도구 이름에는 `__`가 없으므로
 * (list_sessions·propose_mcp_server… 전부 홑밑줄) 칸은 정확히 셋이다.
 * 이름 쪽에서 이미 막지만(mcpServerNameError), 신뢰를 내주는 자리는 남의 검사를
 * 믿지 않고 자기 힘으로 옳아야 한다.
 */
function isOrchestratorTool(toolName: string): boolean {
  const parts = toolName.split('__')
  return parts.length === 3 && parts[0] === 'mcp' && parts[1] === ORCHESTRATOR_MCP_NAME
}

/**
 * 이 도구가 외부 앱 대리 서버의 도구라면 그 서버와 도구 이름 (M4 A-5) — `mcp__app-<id>__<도구>`.
 *
 * 위와 같은 이유로 칸을 센다. 앱 id에는 밑줄이 없고 앱의 도구 이름에는 `__`가 없으므로
 * (manifest.ts의 두 규칙) 우리 것이면 칸이 정확히 셋이다. 이름만으로 무엇을 내주지는 않는다 —
 * 읽기 전용인지는 붙은 앱의 목록에 묻는다(`SessionApps.readOnly`).
 */
function appToolOf(toolName: string): { server: string; tool: string } | null {
  const parts = toolName.split('__')
  if (parts.length !== 3 || parts[0] !== 'mcp' || !parts[1]!.startsWith(APP_MCP_PREFIX)) return null
  return { server: parts[1]!, tool: parts[2]! }
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
 *
 * **"내 설정"이 누구의 설정인가는 여기서 정하지 않는다** — 어느 파일을 읽을지(settingSourcesFor)가
 * 정한다. 신뢰하지 않은 프로젝트에서 normal은 사용자 설정만 따른다(#92, 아래 표).
 */
function permissionOptionsFor(preset: 'safe' | 'normal' | 'auto'): Record<string, unknown> {
  if (preset === 'auto') return { permissionMode: 'bypassPermissions' } // 무조건 통과
  if (preset === 'safe') return { permissionMode: 'default' } // 내 설정과 무관하게 항상 묻는다
  return { resolvePermissionModeInCli: true } // 내 설정을 따른다
}

/**
 * 어느 설정 파일을 읽는가 (M4 결정 3, #92·#152) — **저장소에 커밋된 파일이 승인을 정하지 못하게 한다.**
 *
 *   오케스트레이터·조율 세션(noSettingFiles)   []        아무 파일도 안 읽는다 (아래 query 옵션의 주석)
 *   신뢰한 프로젝트·사용자 폴더 앱의 세션       생략      사용자·프로젝트·로컬 전부 — CLI의 기본 그대로
 *   신뢰하지 않은 프로젝트                      ['user']  사용자 설정만 (~/.claude)
 *
 * **어느 줄인지는 매니저가 세션의 종류와 프로젝트로 정해서 넘긴다** (manager의 settingFilesFor). 도구를 받는지로
 * 가르면 안 된다 — 예전에는 `orchestratorTools`가 곧 `[]`였는데, 워크트리 매니저와 만드는 세션도 그 도구를
 * 받는다. 신뢰한 프로젝트의 만드는 세션이 CLAUDE.md도, 사용자의 ~/.claude(전역 bypass)도 읽지 못해서 사람이
 * 다른 모든 자리에서 끈 승인 카드를 띄웠다. 실측(이 어댑터로 만드는 세션을 띄워 `touch`를 시킴, normal, CLI 2.1.282,
 * haiku, 2026-09-25): 예전(`[]`) 카드 뜸·프로젝트 훅 안 돎·CLAUDE.md 안 읽힘 → 지금(생략) 카드 없음(사용자의
 * bypass)·훅 돎·CLAUDE.md 읽힘. 오케스트레이터는 지금도 카드 뜸·아무것도 안 읽힘이다.
 *
 * 저장소의 `.claude/`는 우리 승인 카드를 끌 수 있었다. 실측(probe-project-trust.mts, CLI 2.1.282,
 * SDK 0.3.263, 받아 온 저장소 흉내로 임시 폴더에 심고 `touch`를 시킴. 사용자 설정은 손대지 않았다):
 *
 *   심은 것                          프리셋  생략(전부 읽음)         ['user']
 *   settings.json의 permissions.allow safe   콜백 불림               콜백 불림
 *   settings.local.json의 allow        safe   **안 불림**             콜백 불림
 *   settings.json의 PreToolUse 훅(allow) safe **안 불림**, 훅 돎      콜백 불림, 훅 안 돎
 *   같은 훅                            normal 안 불림                 안 불림 ← 사용자 설정(bypass)이 정했다
 *   CLAUDE.md · .claude/commands        -     읽힘 · 목록에 뜸         안 읽힘 · 안 뜸
 *
 * 커밋된 settings.json의 allow 규칙은 CLI가 이미 따르지 않았다. 구멍은 settings.local.json(보통 git에서
 * 빠지지만 커밋할 수 있다)과 훅이었고, **safe에서도** 카드를 껐다. 훅은 그 자체로 임의 명령이기도 하다.
 *
 * 신뢰하지 않은 프로젝트에서 normal이 `resolvePermissionModeInCli`를 그대로 보내는 이유: 결정 3이 끄는
 * 것은 저장소의 파일이지 사람 자신의 선택이 아니다. 사용자가 ~/.claude에 bypass를 걸어 두었으면 그것이
 * 이긴다(마지막 줄) — 그 사람이 모든 자리에서 그렇게 하기로 한 것이다. 신뢰하지 않은 폴더에서 사용자의
 * defaultMode까지 덮어 'default'로 묻게 하면 이 앱이 워크플로우를 강제하는 것이 된다. 어디서나 카드를
 * 원하는 사람에게는 safe가 있다.
 */
function settingSourcesFor(opts: Pick<CreateSessionOpts, 'noSettingFiles' | 'projectTrusted'>): Record<string, unknown> {
  if (opts.noSettingFiles) return { settingSources: [] }
  if (opts.projectTrusted === true) return {}
  return { settingSources: ['user'] }
}

class ClaudeSession implements SessionHandle {
  externalId: string | null = null
  private queue: string[] = []
  private notify: (() => void) | null = null
  private closed = false
  /** 보낸 말의 턴이 아직 result로 닫히지 않았다 — 중단을 표시할지 가른다 (interrupt 참고) */
  private turnOpen = false
  /** 답을 기다리는 선택지들. 승인과 달리 **여러 장이 동시에 떠 있을 수 있다** */
  private questions = new Map<string, (r: unknown) => void>()
  private pending = new Map<string, PendingApproval>()
  /** 살아 있는 질의 — 슬래시 명령·컨텍스트를 물어보는 창구 */
  private query: QueryHandle | null = null
  /** 자동 승인 매처. 세션 시작 시 저장된 규칙을 주입받고, 'always' 응답으로 늘어난다 */
  private alwaysAllow = new Set<string>()
  private reqCounter = 0
  private readonly stream: ClaudeStreamNormalizer
  /**
   * 붙어 있는 앱의 대리 서버 (M4 A-5) — 서버 이름 → 대리 서버와, 마지막으로 본 도구 목록.
   * 같은 앱이 붙어 있는 동안은 같은 객체를 다시 싣는다: SDK는 이미 연결된 이름이면 새 객체를
   * 무시하고(sdk.mjs `setMcpServers`), 다른 객체로 바꾸려면 떼었다 다시 붙여야 한다.
   */
  private appProxies = new Map<string, { proxy: AppProxy; tools: string }>()
  /** 오케스트레이터의 인프로세스 서버 — 처음 넘긴 그 객체를 서버 집합을 바꿀 때마다 다시 싣는다 */
  private orchestratorServer: ReturnType<typeof orchestratorMcp> | null = null
  /** 서버 집합 바꾸기를 한 줄로 세운다 — 앞선 것이 끝나기 전에 뒤의 것이 끼지 않게 */
  private serversSync: Promise<unknown> = Promise.resolve()
  private stopAppWatch: (() => void) | null = null

  constructor(
    readonly sessionId: string,
    private opts: CreateSessionOpts,
    private emit: EventSink,
  ) {
    this.stream = new ClaudeStreamNormalizer(sessionId)
  }

  async start(): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- async generator 안에서 인스턴스 접근 필요
    const self = this
    const preset = this.opts.permissionPreset

    /*
     * 외부 앱 (M4 A-5) — 앱마다 대리 서버 하나. 지금 붙은 것을 싣고, 앱이 오고 가거나 도구가
     * 바뀌면 세션을 다시 띄우지 않고 따라간다(syncApps).
     */
    for (const a of this.opts.apps?.current() ?? []) {
      this.appProxies.set(a.server, { proxy: appProxy(this.opts.apps!, a.server), tools: JSON.stringify(a.tools) })
    }
    if (this.opts.orchestratorTools) {
      this.orchestratorServer = orchestratorMcp(this.opts.orchestratorTools, this.opts.toolProfile, this.opts.sessionId)
    }
    const servers = this.mcpServers()

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

    // 사용량은 계정의 성질이지만 SDK는 Query에만 그 메서드를 둔다 — 살아 있는 질의를 빌려 쓴다 (liveQueries)
    const q: QueryHandle = (this.query = query({
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
        // MCP 서버 — 오케스트레이터의 도구와 붙은 외부 앱(승인된 MCP 서버 포함) (mcpServers() 참고)
        ...(Object.keys(servers).length > 0 ? { mcpServers: servers } : {}),
        /*
         * 읽을 설정 파일 (settingSourcesFor) — 오케스트레이터·조율 세션은 **파일에서 지시를 읽지 않는다.**
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
         * 도중에 누구도 바꿔 쓸 수 없다. 프로젝트의 세션은 도구를 받든(매니저·만드는 세션)
         * 안 받든(워커) 프로젝트의 신뢰가 정한다(#92·#152).
         */
        ...settingSourcesFor(this.opts),
        ...(this.opts.orchestratorTools
          ? {
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
        /*
         * 앱이 스키마를 주고 부탁한 에이전트 (M4 D-1). 질의 단위 옵션이라 세션을 시작할 때만 줄 수 있다. 실측(SDK 0.3.263,
         * CLI 2.1.282, haiku): CLI가 `StructuredOutput` 도구를 더하고, 모델이 글로 먼저 답하면 "[structured-output-enforce]"
         * 메시지로 그 도구를 부르게 한다. 그 도구는 canUseTool을 지나지 않았다(승인 카드가 뜨지 않는다). 답은
         * `result.structured_output`에 온다 — 정규화기가 `turn_complete.output`으로 옮긴다.
         */
        ...(this.opts.outputSchema ? { outputFormat: { type: 'json_schema' as const, schema: this.opts.outputSchema } } : {}),
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
                if (isOrchestratorTool(toolName)) {
                  return { behavior: 'allow' as const, updatedInput: toolInput }
                }

                /*
                 * **읽기만 하는 앱 도구는 묻지 않는다** (M4 결정 5).
                 *
                 * 기준은 앱이 도구에 단 주석(`readOnlyHint: true`)이고, 판정은 이름이 아니라 붙은
                 * 앱의 목록이 한다 — `app-`로 시작하는 서버라고 믿어 주지 않는다(#93의 교훈).
                 * 나머지 앱 도구는 아래의 보통 승인 카드로 간다: safe는 언제나, normal은 이
                 * 콜백이 불리면 묻는다. auto는 이 콜백 자체가 없다(bypassPermissions).
                 * Codex의 `writes` 방식과 같은 기준이라 두 도구가 같게 움직인다.
                 *
                 * centralu의 예외와는 따로다 — 그 예외는 넓히지 않는다.
                 */
                const appTool = appToolOf(toolName)
                if (appTool && self.opts.apps?.readOnly(appTool.server, appTool.tool)) {
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
                /*
                 * 규칙의 열쇠 — 명령은 명령 전문, 파일 편집은 **그 경로**다 (#170). 화면이 "항상 허용"에 싣는 매처가 그렇고
                 * (명령은 core의 suggestMatcher, 편집은 detail.path), Codex 어댑터가 같은 규칙으로 찾는다. 예전에는 편집을
                 * `Edit:file_edit`로 찾아서, 경로로 저장된 규칙이 영영 맞지 않았다 — 같은 파일을 다시 고칠 때마다 물었다.
                 * 그 밖의 종류(`other`)에는 열쇠가 없다: "항상"이 무엇을 뜻할지 아직 정하지 않았다.
                 */
                const key =
                  detail.kind === 'command' ? detail.command
                  : detail.kind === 'file_edit' && detail.path !== '?' ? detail.path
                  : ''
                if (key && self.isAlwaysAllowed(key)) return { behavior: 'allow' as const, updatedInput: toolInput }

                const requestId = `req-${++self.reqCounter}`
                self.emit({ type: 'approval_request', sessionId: self.sessionId, requestId, detail })
                return new Promise((resolve) => {
                  self.pending.set(requestId, { resolve: resolve as PendingApproval['resolve'], input: toolInput })
                })
              },
      },
    }))
    ClaudeAdapter.liveQueries.add(q)

    // 앱이 오고 가면 서버 집합을, 도구가 바뀌면 그 서버의 목록을 따라간다 — 세션을 다시 띄우지 않는다
    this.stopAppWatch = this.opts.apps?.onChange(() => this.syncApps()) ?? null

    void (async () => {
      try {
        /*
         * 메시지 하나로는 판단이 안 서는 것(본문이 델타로 이미 나갔는가, 띄워 둔
         * 백그라운드 에이전트)은 정규화기가 기억한다 — ClaudeStreamNormalizer 참고.
         * /usage 같은 로컬 합성 응답은 델타가 0개라(실측), 그 기억이 없으면 통짜 본문을
         * 낼지 판단할 수 없다 — 내면 보통 턴에서 두 번 붙고, 안 내면 영영 안 보인다.
         */
        for await (const msg of q) {
          /*
           * **닫은 뒤에 온 말은 받지 않는다** (#157). dispose가 프로세스를 끝내도 이미 읽어 둔 메시지가
           * 몇 개 더 나올 수 있다 — 끝나 가던 턴의 글과 result다. 그 세션 자리에는 이미 새 프로세스가
           * 앉아 있을 수 있으므로, 옛 턴의 끝이 새 프로세스의 기록으로 들어가면 안 된다.
           */
          if (this.closed) break
          const m = msg as { type?: string; session_id?: string; subtype?: string }
          if (m.type === 'system' && m.subtype === 'init' && m.session_id) this.externalId = m.session_id
          this.noteAppCalls(msg)
          if (m.type === 'result') this.turnOpen = false
          for (const e of this.stream.push(msg)) this.emit(e)
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
        ClaudeAdapter.liveQueries.delete(q)
        if (!this.closed) {
          this.releaseAgents('The session process ended before this agent reported back')
          this.emit({
            type: 'error',
            sessionId: this.sessionId,
            error: { code: 'adapter_crashed', message: 'claude process ended unexpectedly', retryable: true },
          })
        }
      } catch (err) {
        ClaudeAdapter.liveQueries.delete(q)
        /*
         * **우리가 닫은 프로세스의 예외는 크래시가 아니다** (#157). 위의 정상 종료 분기와 같은 규칙이다.
         * 멈춘 턴(마지막 result가 error_during_execution) 뒤에 설정을 바꾸면 옛 CLI는 오류 result를 안은 채
         * 끝나고, SDK는 그것을 "Claude Code returned an error result: …"로 바꿔 던진다. 예전에는 그 예외가
         * adapter_crashed로 올라가 매니저가 방금 새로 띄운 프로세스를 죽은 것으로 여겨 닫았다.
         */
        if (this.closed) return
        this.releaseAgents('The session process ended before this agent reported back')
        this.emit({
          type: 'error',
          sessionId: this.sessionId,
          error: { code: 'adapter_crashed', message: (err as Error).message, retryable: true },
        })
      }
    })()
  }

  /**
   * 붙은 앱의 도구를 부르는 `tool_use`를 붙이기에 적는다 (M4 B-1 — 대화 안 화면의 카드 짝짓기).
   *
   * 보통은 필요 없다: CLI가 호출에 카드 id를 실어 보낸다(app-proxy.ts `CLAUDE_TOOL_USE_META`). 그 자리가
   * 바뀐 CLI에서도 화면이 제 카드를 찾도록 Codex와 같은 짝짓기를 뒤에 둔다. 결과(`tool_result`)가 온
   * 카드는 짝짓기에서 뺀다 — 승인에서 거절된 호출은 앱까지 오지 않는다.
   */
  private noteAppCalls(msg: unknown): void {
    const apps = this.opts.apps
    const m = msg as { type?: string; message?: { content?: unknown } }
    if (!apps || (m.type !== 'assistant' && m.type !== 'user') || !Array.isArray(m.message?.content)) return
    for (const b of m.message.content as { type?: string; id?: unknown; name?: unknown; input?: unknown; tool_use_id?: unknown }[]) {
      if (b?.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
        const t = appToolOf(b.name)
        if (t && this.appProxies.has(t.server)) apps.noteCall(b.id, t.server, t.tool, b.input ?? {})
      } else if (b?.type === 'tool_result' && typeof b.tool_use_id === 'string') {
        apps.callEnded(b.tool_use_id)
      }
    }
  }

  send(text: string): void {
    /*
     * /goal은 아직 대화형 CLI 전용이다 (실측 2026-09-07, 0.3.231과 최신 0.3.263
     * 양쪽에서 재측정): 헤드리스 원류에 active_goal도 local_command_output도 0건,
     * 세팅 API도 타입 어디에도 없다. 그냥 보내면 모델이 글자를 읽고 골 **역할극**을
     * 한다 ("Goal achieved!" — 훅 없이 말만). 조용한 거짓말보다 정직한 한 줄이 낫다.
     * SDK가 이 경로를 열면 이 가로채기가 그 배선 자리다 (active_goal 수신은 배선 완료).
     */
    if (/^\/goal(\s|$)/.test(text.trim())) {
      this.emit({
        type: 'message_delta',
        sessionId: this.sessionId,
        role: 'assistant',
        text: 'Goals currently need the interactive Claude CLI — the headless SDK path has no way to set one yet, and sending /goal as a message would only make the model role-play the hook.',
      })
      this.emit({ type: 'turn_complete', sessionId: this.sessionId })
      return
    }
    this.queue.push(text)
    this.turnOpen = true
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
  /**
   * 이 세션의 MCP 서버 전부 — 처음 띄울 때도, 집합을 바꿀 때도 이 한 곳에서 조립한다.
   *
   * 둘이다. 둘 다 인프로세스라 별도 프로세스가 없다:
   *   1. 오케스트레이터의 도구 (FR-11) — 이 도구들이 볼 수 있는 것은 매니저가 넘겨준 것뿐이다.
   *   2. 외부 앱의 대리 서버 (M4 A-5) — `app-<id>`. 사람이 승인한 MCP 서버(propose_mcp_server)도
   *      사용자 폴더의 앱이 되어 여기로 온다(A-7). 예전에는 그 서버를 stdio 항목으로 날것으로 실었다 —
   *      호출이 중개도 기록도 지나지 않았고, `centralu`라는 이름 하나가 인프로세스 오케스트레이터를
   *      갈아치울 수 있었다(#93). 이제 날것으로 싣는 서버는 없다.
   *
   * 집합을 바꿀 때(`setMcpServers`) 1을 빼면 SDK가 그것을 **떼어 낸다** — 그 호출은 동적으로
   * 붙인 서버 전부를 넘긴 것으로 바꾼다. 그래서 언제나 전부를 싣는다.
   */
  private mcpServers(): Record<string, McpServerConfig> {
    return {
      ...(this.orchestratorServer ? { [ORCHESTRATOR_MCP_NAME]: this.orchestratorServer } : {}),
      ...Object.fromEntries([...this.appProxies].map(([name, { proxy }]) => [name, proxy.config])),
    }
  }

  /**
   * 붙은 앱이 바뀌었다 (M4 A-5) — 재시작 없이 따라간다.
   *
   *   앱이 오고 감(신뢰가 뒤집힘 포함)   `setMcpServers`로 집합을 바꾼다. 새 도구는 다음 턴부터 보인다
   *   붙은 앱의 도구가 바뀜              그 대리 서버가 `tools/list_changed`를 보낸다 — 서버는 그대로
   */
  private syncApps(): void {
    const apps = this.opts.apps
    if (!apps || this.closed) return
    const now = apps.current()
    const want = new Set(now.map((a) => a.server))
    let setChanged = false
    for (const name of [...this.appProxies.keys()]) {
      if (want.has(name)) continue
      this.appProxies.delete(name)
      setChanged = true
    }
    for (const a of now) {
      const tools = JSON.stringify(a.tools)
      const held = this.appProxies.get(a.server)
      if (!held) {
        // 떼었다 다시 붙는 앱도 새 대리 서버로 온다 — SDK가 뗀 서버는 다시 연결할 수 없다
        this.appProxies.set(a.server, { proxy: appProxy(apps, a.server), tools })
        setChanged = true
      } else if (held.tools !== tools) {
        held.tools = tools
        held.proxy.toolsChanged()
      }
    }
    if (!setChanged || !this.query) return
    const q = this.query
    const servers = this.mcpServers()
    this.serversSync = this.serversSync
      .then(() => q.setMcpServers(servers))
      .then((r) => {
        const errors = Object.entries(r?.errors ?? {})
        if (errors.length) console.error(`[claude] ${this.sessionId.slice(0, 8)} app servers failed to attach:`, errors)
      })
      .catch((err: Error) => console.error(`[claude] ${this.sessionId.slice(0, 8)} could not update app servers: ${err.message}`))
  }

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
    /*
     * 이 세션이 부른 앱 호출도 멈춘다 (M4 A-5). CLI가 턴을 끊으며 도구 호출에 취소를 보내는지는
     * SDK가 약속하지 않는다 — 우리가 직접 끊는다. 취소는 런타임이 앱과 그 아래 일까지 전한다.
     */
    this.opts.apps?.cancelAll()
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: 'Stopped by user' })
      this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId: id, decision: 'deny' })
    }
    this.pending.clear()
    this.releaseQuestions('Stopped by user')
    /*
     * 끊긴 턴의 결말(error_during_execution)은 실패가 아니라 중단이다 (#168, 정규화기의 stopping). **도는 턴이
     * 있을 때만** 표시한다 — 쉬는 세션에서 누른 Stop이 표시를 남기면 다음 턴의 진짜 실패를 삼킨다.
     */
    if (this.turnOpen) this.stream.stopped()

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
    // 앱 붙이기는 핸들과 함께 닫힌다 — 새 핸들은 자기 것을 받는다
    this.stopAppWatch?.()
    this.opts.apps?.close()
    /*
     * 큐에 남은 메시지도 같은 규칙이다 (codex 어댑터의 compact 큐와 대칭 — 2026-09-02
     * 유실 사고 후 맞춤). generator가 closed를 보고 빠져나가면 여기 남은 건 아무도
     * 안 읽는다 — 화면에는 이미 보낸 것으로 남아 있으므로(매니저가 먼저 기록한다),
     * 말없이 버리면 "보냈는데 에이전트가 못 읽는" 상태가 조용히 생긴다.
     */
    if (this.queue.length > 0) {
      const n = this.queue.length
      this.queue.length = 0
      this.emit({
        type: 'error',
        sessionId: this.sessionId,
        error: {
          code: 'internal',
          message: `${n} message(s) were still queued when the session closed and were not delivered — please resend`,
          retryable: false,
        },
      })
    }
    for (const [id, p] of this.pending) {
      p.resolve({ behavior: 'deny', message: 'Session closed' })
      this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId: id, decision: 'deny' })
    }
    this.pending.clear()
    this.releaseQuestions('Session closed')
    this.releaseAgents('The session closed before this agent reported back')
    /*
     * **프로세스를 끝낸다** (#157). 예전에는 입력 제너레이터만 끝냈다 — SDK가 CLI의 stdin을 닫을 뿐이고, CLI는
     * 돌던 턴을 마저 돌았다(auto에서는 묻는 일이 없으니 남은 도구 호출까지). 갈아 끼운 세션에서는 옛 프로세스와
     * 새 프로세스가 한 대화에 함께 쓰고 있었던 셈이다. `close()`는 stdin을 닫고 끝나지 않으면 SIGTERM을 보낸다
     * (sdk.d.ts "Close the query and terminate the underlying process"). 사용량 창구도 여기서 거둔다.
     */
    if (this.query) {
      ClaudeAdapter.liveQueries.delete(this.query)
      this.query.close()
    }
  }

  /** 띄워 둔 백그라운드 에이전트의 카드를 닫는다 — 프로세스와 함께 사라졌으므로 통지는 안 온다 (#98) */
  private releaseAgents(why: string): void {
    for (const e of this.stream.release(why)) this.emit(e)
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

  readonly descriptor: ToolDescriptor = {
    name: 'claude',
    label: 'Claude Code',
    mark: 'C',
    install: 'npm i -g @anthropic-ai/claude-code',
    login: 'claude auth login',
  }
  /**
   * 사용량을 물어볼 창구.
   *
   * 사용량은 **계정**의 성질인데 SDK는 세션(Query)에만 그 메서드를 준다.
   * 그래서 살아 있는 질의 하나를 빌려 쓴다 — 어느 세션에 묻든 답은 같다.
   */
  /**
   * 사용량·모델 목록은 계정의 성질인데 SDK는 둘 다 Query에만 둔다 — 살아 있는 질의를 빌려 쓴다.
   *
   * **살아 있는 것만 담는다** (#157). 예전에는 마지막으로 시작한 질의 하나를 들고 있다가 그 세션이 닫히거나
   * 죽어도 놓지 않아서, 더 오래된 세션이 살아 있는데도 죽은 질의에 물었다. 넣은 차례가 곧 시작한 차례다.
   */
  static readonly liveQueries = new Set<UsageQuery & ModelQuery>()
  /** 가장 최근에 시작해 아직 살아 있는 질의 */
  static get lastQuery(): (UsageQuery & ModelQuery) | null {
    let last: (UsageQuery & ModelQuery) | null = null
    for (const q of ClaudeAdapter.liveQueries) last = q
    return last
  }
  readonly capabilities: AdapterCapabilities = {
    approvals: true, // M0 검증: 전역 bypass를 세션 단위로 덮어쓸 수 있음
    contextUsage: 'exact',
    resume: true,
    autoTitle: true,
    attachments: ['image', 'file'],
    // SDK 0.3.231의 타입에 응답 길이 노브가 없다 (effortLevel뿐 — #54에서 실측).
    // 생기면 여기만 채우면 된다 — UI는 이 배열을 보고 행을 그린다.
    verbosities: [],
    // 대화 파일(JSONL)에 잠금이 없다 — 우리가 세션을 쥔 동안에도 터미널의 claude가
    // 같은 대화에 쓸 수 있다. 그러니 "내려놓은 시각까지는 전부 내 것" 표식을 못 찍는다.
    // 어차피 여기 기록 읽기는 SDK가 로컬 파일을 읽는 것이라 스킵의 이득도 몇 ms뿐이다.
    exclusiveWriter: false,
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

  /** 대화 원본 삭제 ("진짜로 삭제") — SDK의 deleteSession이 자기 파일 배치를 안다 */
  deleteExternalConversation(externalId: string, cwd: string) {
    return deleteClaudeSession(externalId, cwd)
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
