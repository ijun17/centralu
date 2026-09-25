import { execFile } from 'node:child_process'
import { bridgePath } from './bridge-path.js'
/** 다리로 붙는 우리 MCP 서버 이름 — elicitation 수락이 이 이름으로 판정한다 (정의는 한 곳, #93) */
import { ORCHESTRATOR_MCP_NAME } from '../../sessions/orchestrator-tools.js'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { CLIENT_INFO } from '@cc/protocol'
import type {
  AdapterCapabilities,
  ApprovalDecision,
  ApprovalDetail,
  ApprovalScope,
  PermissionPreset,
  ToolDescriptor,
} from '@cc/protocol'
import { whichTool } from '../../env-path.js'
import type { AgentAdapter, CreateSessionOpts, DetectResult, EventSink, SessionHandle } from '../contract.js'
import { CodexClient } from './client.js'
import { lastCompactSummary as rolloutLastCompactSummary } from './rollout.js'
import type { Verbosity } from './generated/Verbosity.js'
import { listCodexThreads, readCodexHistory } from './history.js'
import { imageEventFromDisk } from './images.js'
import { readCodexUsage } from './usage-client.js'
import { listCodexModels } from './models.js'
import { approvalDetailFrom, goalFromCodex, normalizeNotification, toCodexDecision } from './normalize.js'

const exec = promisify(execFile)

/**
 * Codex 어댑터 (M0에서 프로토콜·승인 오버라이드 검증 완료).
 *
 * 설계 검증 대상(A-4): 이 디렉토리만 추가해서 UI·core가 그대로인가.
 * 규칙: Codex 타입은 여기서 끝난다 — 밖으로 나가는 것은 NormalizedEvent뿐.
 */

/**
 * 권한 프리셋 → Codex의 권한 옵션.
 *
 * Claude 쪽과 **같은 원칙**이다: normal은 우리가 정하지 않고 도구 자신의 설정
 * (`~/.codex/config.toml`)을 따른다. 그래서 아무 키도 넣지 않는다 — codex는 빠진 값을
 * 자기 설정에서 채운다.
 *
 * 덮어쓰던 것이 둘이었다는 점이 중요하다. approvalPolicy만이 아니라 **sandbox도**
 * 'workspace-write'로 못박고 있었다. 사용자가 config.toml에 danger-full-access를
 * 적어 두었어도 작업 폴더 밖은 막혀 있었다는 뜻이다 — 묻지도 않고 실패한다.
 */
/*
 * "내 설정"은 사용자의 `~/.codex/config.toml`이다 — 저장소의 `.codex/config.toml`은 프로젝트를 신뢰했을
 * 때만 여기에 끼어든다(repoFilesConfig, #92).
 */
function permissionOptionsFor(preset: PermissionPreset): Record<string, unknown> {
  if (preset === 'safe') return { approvalPolicy: 'untrusted', sandbox: 'workspace-write' } // 모든 것을 묻는다
  if (preset === 'auto') return { approvalPolicy: 'never', sandbox: 'workspace-write' } // 묻지 않는다
  return {} // 내 설정을 따른다
}

/**
 * 저장소의 파일이 이 스레드를 바꾸지 못하게 한다 (M4 결정 3, #92·#152) — 신뢰하지 않은 프로젝트와, 파일을 하나도
 * 읽지 않는 세션(`noSettingFiles`: 오케스트레이터·조율 세션 — 그 폴더는 워커가 쓸 수 있는 자리다). Claude의
 * `settingSources: ['user']`·`[]`에 대응한다. 신뢰한 폴더(신뢰한 프로젝트, 사용자 폴더 앱)에서는 아무것도 싣지
 * 않는다 — 지금까지와 같다. 어느 쪽인지는 매니저가 세션의 종류와 프로젝트로 정해서 넘긴다: 도구를 받는지로 가르지
 * 않는다(워크트리 매니저와 만드는 세션도 도구를 받지만 프로젝트의 세션이다).
 *
 * Codex에도 프로젝트 신뢰가 따로 있다(`~/.codex/config.toml`의 `projects."<경로>".trust_level`). 신뢰하지
 * 않은 폴더에서 Codex는 저장소의 `.codex/config.toml`(승인 정책·샌드박스·MCP 서버를 바꿀 수 있다), 훅,
 * 실행 규칙(exec policy)을 불러오되 끈다. 문제는 **정해지지 않은** 폴더다: `thread/start`가 cwd를 받았고
 * 신뢰가 비어 있고 샌드박스가 그 폴더에 쓸 수 있으면, app-server가 그 폴더를 **신뢰한다고 사용자 설정
 * 파일에 적어 버린다**(codex 소스 app-server `thread_processor.rs`의 `set_project_trust_level(…, Trusted)`).
 * 그래서 이 앱으로 연 저장소는 Codex 쪽에서는 모두 신뢰된 폴더가 되어 있었다.
 *
 * 스레드마다 넘기는 `config`는 CLI의 `-c`와 같은 층(SessionFlags)에 앉고, 신뢰 판정은 그 층까지 합친
 * 설정에서 `projects`를 읽는다(codex 소스 config `loader/mod.rs`의 `project_trust_context`). 그래서 이
 * 스레드에서만 그 폴더를 "untrusted"로 적으면:
 *   - 저장소의 `.codex/config.toml`·훅·실행 규칙이 꺼진 층으로 남는다 (`disabled_reason_for_decision`)
 *   - 신뢰가 정해져 있으므로 app-server가 신뢰를 적어 넣지 않는다 (위 자동 신뢰는 `trust_level.is_none()`일 때만)
 *   - AGENTS.md를 읽지 않는다 (`agents_md.rs`: `active_project.is_untrusted()`면 건너뛴다)
 * 판정은 폴더마다 **그 폴더의 열쇠를 먼저** 본다(`decision_for_dir`) — cwd에서 뿌리까지의 조상 전부를
 * 적는다. 사용자가 조상 하나를 신뢰해 두었어도 그 칸이 이기지 못한다. 경로는 적힌 그대로와 실제 경로
 * (심볼릭 링크를 푼 것) 둘 다 적는다 — Codex가 두 철자를 모두 찾는다(`normalized_project_trust_keys`).
 *
 * `project_doc_max_bytes: 0`도 함께 싣는다. AGENTS.md를 신뢰로 거르는 줄이 설치된 0.153.4에 있는지는
 * 바이너리로 확인하지 못했다. 이 키는 오케스트레이터에서 실측으로 확인한 길이다(심어 둔 AGENTS.md를 따르던
 * 것이 멈췄다). 사용자 자신의 `~/.codex/AGENTS.md`는 다른 길로 읽혀 그대로 남는다.
 *
 * 남는 것: 저장소의 스킬(`.codex/skills`, `.agents/skills`)은 신뢰와 무관하게 읽힌다("skills still load" —
 * 0.153.4 바이너리의 경고 문구). 스레드 단위로 저장소 범위의 스킬만 끄는 키는 없다(`skills.include_instructions`는
 * 사용자의 스킬까지 끈다). 스킬은 지시문일 뿐이라, 스킬을 따라 모델이 하려는 일은 여전히 승인을 지난다.
 *
 * **소스와 바이너리로만 확인했다** (Codex가 로그아웃 상태라 실행으로 재지 못했다): 키와 판정은 codex 소스
 * (main 75e0e0a, 2026-09-25)에서 읽었고, 설치된 0.153.4 바이너리에 같은 문구가 있음을 확인했다 —
 * "failed to persist trusted project state for", "is marked as untrusted in the effective configuration",
 * "Project-local config, hooks, and exec policies are disabled … but skills still load".
 */
export function repoFilesConfig(opts: Pick<CreateSessionOpts, 'cwd' | 'projectTrusted' | 'noSettingFiles'>): Record<string, unknown> {
  if (opts.projectTrusted === true && !opts.noSettingFiles) return {}
  const keys = new Set<string>()
  for (const start of [resolve(opts.cwd), realPathOr(opts.cwd)]) {
    for (let dir = start; ; dir = dirname(dir)) {
      keys.add(dir)
      if (dirname(dir) === dir) break
    }
  }
  return {
    project_doc_max_bytes: 0,
    projects: Object.fromEntries([...keys].map((k) => [k, { trust_level: 'untrusted' }])),
  }
}

function realPathOr(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/**
 * 외부 앱 서버의 도구 승인 방식 (M4 결정 5) — 세션 프리셋 → Codex의 서버별 `default_tools_approval_mode`.
 *
 *   auto    approve  묻지 않는다. 우리 auto는 `approvalPolicy: never`라서, 이 값을 적지 않으면
 *                    Codex가 주석 없는 MCP 도구를 **스스로 거부한다** ("requires approval, but
 *                    approval policy is never")
 *   normal  writes   읽기 전용 주석이 없는 도구만 묻는다 — Claude 쪽 판정과 같은 기준
 *   safe    prompt   전부 묻는다. 읽기 전용 도구는 도구별 `approve`로 따로 푼다(appBridgeConfig)
 *
 * **소스로만 확인했다** (Codex가 로그아웃 상태라 실행으로 재지 못했다, 플랜 S-3·S-7): 값의 어휘는
 * 설치된 0.153.4의 생성 타입(`AppToolApproval = "auto" | "prompt" | "writes" | "approve"`)과
 * 바이너리의 설정 필드 이름(`default_tools_approval_mode`, 도구별 `tools.<이름>.approval_mode`)으로,
 * 각 값의 뜻은 codex 소스(`core/src/mcp_tool_call.rs`의 requires_mcp_tool_approval_for_mode)로 읽었다.
 *
 * normal의 함정 하나: normal은 사용자의 config.toml을 따르므로(permissionOptionsFor), 사용자가
 * `approval_policy = "never"`를 적어 두었다면 `writes`가 물어야 할 도구를 Codex가 거부한다.
 * 우리는 사용자 설정을 읽지 않는다 — 그 조합에서는 쓰기 도구가 거절로 돌아온다.
 */
const APP_APPROVAL_MODE: Record<PermissionPreset, 'approve' | 'writes' | 'prompt'> = {
  auto: 'approve',
  normal: 'writes',
  safe: 'prompt',
}

/**
 * MCP 도구 호출 하나의 상한 — Codex의 코드 기본값(0.145부터 300초)을 **적어서** 고정한다.
 * 기본값에 기대면 Codex가 값을 바꾸는 날 오래 걸리는 호출의 처리(240초에 먼저 돌려주기)가
 * 조용히 어긋난다. 필드 이름(`tool_timeout_sec`)은 바이너리와 소스로만 확인했다.
 */
export const CODEX_TOOL_TIMEOUT_SEC = 300
/**
 * 앱 호출이 이보다 오래 걸리면 실행 id와 "아직 도는 중"을 먼저 돌려준다 (플랜 "오래 걸리는 호출").
 * 위 상한보다 60초 짧다 — 다리와 host 사이의 왕복과 Codex 쪽 처리가 그 안에 들어가야 "아직 도는
 * 중"이 시간 초과보다 먼저 모델에게 닿는다. 결과는 각 앱 서버의 `run_status`로 이어서 본다.
 */
export const APP_CALL_WAIT_MS = 240_000
/**
 * 앱 다리가 뜨고 도구 목록을 내놓기까지의 상한. 스레드를 띄우기 전에 목록을 미리 읽어 두므로
 * (mcpConfig) 보통은 즉시다. 목록을 모르는 앱은 host가 앱을 띄워 읽는 동안(최대 15초) 기다린다.
 */
const APP_STARTUP_TIMEOUT_SEC = 30

/** 재개를 사람 앞에서 기다려 주는 시간 — 잠금 오류("active writer")는 이 안에 온다 (실측 ~0.3s) */
export const LAZY_RESUME_WAIT_MS = 3_000
/** 배경 재개의 상한 — 매니저의 단계 제한(150s)과 같은 값. 이걸 넘기면 걸린 것이다 */
const BACKGROUND_RESUME_CAP_MS = 150_000

class CodexSession implements SessionHandle {
  readonly sessionId: string
  externalId: string | null = null
  private closed = false

  private client: CodexClient
  private threadId: string | null = null
  /**
   * 지금 도는 턴의 id — **멈추려면 이게 있어야 한다** (도그푸딩 2026-09-07: 스톱이 안 먹혔다).
   *
   * `turn/interrupt`는 threadId만으로는 안 된다. 실측하면 서버가
   * `Invalid request: missing field \`turnId\``(-32600)로 거절하고, 우리는 그 거절을
   * 에러 이벤트로만 흘려 보냈다 — 화면은 멈춘 듯 보이는데 턴은 끝까지 돌았다.
   * 그래서 turn/started 알림과 turn/start 응답 **양쪽에서** 잡는다: 스톱을 아주 빨리
   * 누르면 알림보다 응답이 먼저 올 수 있다.
   */
  private turnId: string | null = null
  /** 우리 requestId → Codex 서버 요청 id */
  private approvals = new Map<string, number | string>()
  /**
   * 앱 도구 승인으로 띄운 카드 (M4 A-5) — 답의 모양이 다르다(`{ decision }`이 아니라 elicitation의
   * `{ action }`). 이 집합에 있는 requestId만 elicitation으로 답한다.
   */
  private elicitations = new Set<string>()
  /** 이 스레드에 다리로 실은 앱 서버 — 그 이름의 elicitation만 우리 카드로 간다 */
  private appServers = new Set<string>()
  private reqCounter = 0
  private alwaysAllow = new Set<string>()
  /**
   * compact/review 턴이 도는 동안 도착한 메시지 (도그푸딩 실측 2026-09-02, MGH 세션).
   *
   * codex 0.147.0의 turn/start는 compact 턴이 도는 동안 **성공을 답하면서 입력을 버린다** —
   * rollout에는 설정 적용(thread_settings_applied)만 남고 user 메시지는 한 줄도 남지 않았고,
   * 에러도 오지 않아 우리 화면에는 보낸 것처럼 보였다. 상류도 이 턴들을 조종 불가로
   * 못박는다 ("cannot steer a compact turn" — turn_processor.rs). 일반 턴은 다르다:
   * codex core가 도는 턴에 입력을 합류시키므로 그대로 보낸다. 그래서 **우리가 시작한**
   * compact/review 동안만 여기 쌓고, 그 턴이 끝나면 한 턴으로 내보낸다.
   */
  private pendingInputs: string[] = []
  /** 조종 불가 턴(compact/review)이 도는 중 — 그 턴은 우리가 시작했으므로 우리가 안다 */
  private blockingTurn = false
  /** 스레드 준비 완료 — 생성 시점에 await해 externalId를 확보한다 */
  readonly ready: Promise<void>

  constructor(
    private opts: CreateSessionOpts,
    private emit: EventSink,
  ) {
    this.sessionId = opts.sessionId
    this.client = new CodexClient(
      {
        onNotification: (n) => this.onNotification(n),
        onServerRequest: (r) => this.onServerRequest(r),
        /*
         * **우리가 닫은 것을 죽었다고 말하지 않는다.**
         *
         * 여기가 조사 하루를 통째로 먹은 자리다. 잠긴 스레드를 이어가려다 실패하면
         * 매니저가 세션을 정리하는데(dispose), 그 정상 종료가 다시 이 자리로 와서
         * `adapter_crashed`를 올렸다. 화면에는 "codex app-server exited"만 남고
         * 진짜 이유("already has an active writer")는 그 아래 깔려 보이지 않았다.
         * 죽지도 않은 프로세스를 죽었다고 말하니, 원인을 찾을 길이 없었다.
         */
        onExit: (code, expected) => {
          if (expected) return
          this.emit({
            type: 'error',
            sessionId: this.sessionId,
            error: {
              code: 'adapter_crashed',
              message: `codex app-server exited (code ${code ?? 'null'})`,
              retryable: true,
            },
          })
        },
      },
      { cwd: opts.cwd, command: whichTool('codex') ?? 'codex' },
    )
    this.ready = this.start()
  }

  private async start(): Promise<void> {
    await this.client.request('initialize', {
      clientInfo: CLIENT_INFO,
      capabilities: null,
    })
    this.client.notify('initialized')

    if (this.opts.resumeExternalId) {
      // 재개 (FR-10). 실패하면 세션 매니저가 폴백을 안내한다
      let res: Record<string, unknown>
      try {
        res = await this.client.request<Record<string, unknown>>('thread/resume', {
          threadId: this.opts.resumeExternalId,
          /*
           * 응답 길이는 재개에도 따라와야 한다 (#54). turn/start에는 이 자리가 없어서
           * (effort와 다른 점) 스레드를 띄우는 이 두 자리가 유일한 길이다 —
           * 여기 빠지면 "잠들었다 깨면 설정이 풀리는" 종류의 조용한 유실이 된다.
           *
           * 추론 요약도 같은 자리다 (#58 실측): 이 스위치를 켜지 않으면
           * item/reasoning/* 스트림이 **한 건도 안 온다** — 배선만 하고 스위치를
           * 안 켜면 아무 일도 일어나지 않는 종류의 기능이다.
           */
          config: {
            model_reasoning_summary: 'auto',
            ...(this.opts.verbosity ? { model_verbosity: this.opts.verbosity } : {}),
            ...(this.opts.serviceTier ? { service_tier: this.opts.serviceTier } : {}),
            /*
             * MCP 서버는 **재개에도 싣는다** (M4 A-5, 플랜 "별개로 확인할 것" 1).
             *
             * 예전 재개는 서버를 하나도 보내지 않았다 — 처음 설정이 스레드에 남지 않는다면 잠들었다
             * 깬 Codex 오케스트레이터는 centralu 도구를 잃는다. 남는지는 실행해 봐야 아는데(S-7)
             * Codex가 로그아웃 상태라 재지 못했다. 그래서 확인을 기다리지 않고 다시 싣는다: 재개의
             * `config`는 설정 덮어쓰기라(생성 타입 ThreadResumeParams — "Configuration overrides for
             * the resumed thread") 같은 이름은 같은 칸이고, 남아 있었다면 덮어써도 잃을 것이 없다.
             * 앱은 재개가 곧 "다음 스레드 시작"이다 — 스레드가 도는 동안 붙은 앱은 여기서 붙는다.
             */
            ...(await this.mcpConfig()),
            // 저장소의 파일은 신뢰한 프로젝트에서만 이 스레드에 닿는다 — 재개에도 같은 판정이다 (#92)
            ...repoFilesConfig(this.opts),
          },
        })
      } catch (err) {
        /*
         * 원문("already has an active writer")은 사용자에게 아무것도 설명하지 못한다.
         *
         * 그리고 **사람에게 보여줄 문장만으로는 부족하다** — 위층이 문장을 정규식으로
         * 다시 읽어야 한다면 그건 계약이 아니다. 기계가 읽을 코드를 함께 올린다:
         * 이 코드가 있어야 UI가 "갈라서 이어가기"를 내밀 수 있다 (codex의 thread/fork는
         * 잠겨 있어도 된다 — 실측으로 확인).
         */
        const msg = (err as Error).message
        if (/active writer/i.test(msg)) {
          /*
           * 실측(#57)으로 이 에러의 뜻이 좁혀졌다: 락은 파일 존재가 아니라 flock이라,
           * 죽은 프로세스가 남긴 파일은 이 에러를 **못** 만든다. 여기 왔다는 건
           * 지금 이 순간 flock을 쥔 산 프로세스가 있다는 뜻이다 — 터미널의 codex거나,
           * 다른 앱이거나, 정리되지 못한 채 fd만 물려받고 살아남은 고아다.
           */
          throw Object.assign(
            new Error(
              'This conversation is already open elsewhere (codex in a terminal, another app, or a process left behind by an unclean shutdown)',
            ),
            { code: 'conversation_locked' },
          )
        }
        throw err
      }
      this.threadId = threadIdOf(res) ?? this.opts.resumeExternalId
      /*
       * 골은 라이브 필드다 (2026-09-07) — 재시작 후에도 배지가 참이려면 재개 때 다시
       * 묻는다. 옛 codex엔 이 메서드가 없다: 실패는 "골 없음"과 같게 조용히 눕는다.
       */
      void this.client
        .request<{ goal: Record<string, unknown> | null }>('thread/goal/get', { threadId: this.threadId })
        .then((r) => {
          // complete는 goalFromCodex가 null로 접는다 — 기본 상태가 이미 null이라 그때는 낼 것이 없다
          const g = r.goal ? goalFromCodex(r.goal) : null
          if (g) this.emit({ type: 'goal', sessionId: this.sessionId, goal: g })
        })
        .catch(() => {})
    } else {
      const res = await this.client.request<Record<string, unknown>>('thread/start', {
        cwd: this.opts.cwd,
        ...permissionOptionsFor(this.opts.permissionPreset),
        model: this.opts.model,
        /*
         * 오케스트레이터일 때만 붙는 둘.
         *
         * 역할은 developerInstructions로 직접 준다 — Claude의 systemPrompt append와
         * 같은 자리다. 파일(AGENTS.md)로 두지 않는 이유도 같다: 낮은 권한의 세션이
         * 그 파일을 고치면 모든 세션에 지시할 수 있는 쪽의 지시가 되어버린다.
         *
         * 도구는 stdio 다리를 통해 붙는다. 실측으로 확인한 것:
         *   per-thread config.mcp_servers  ✅ 살아 있다 (우리 명령이 실제로 실행됨)
         *   url(HTTP) 방식                 ❌ 요청이 한 건도 오지 않는다
         * 그래서 프로세스가 하나 더 뜬다 — Claude 경로에는 없는 비용이다.
         */
        ...(this.opts.systemPromptAppend ? { developerInstructions: this.opts.systemPromptAppend } : {}),
        /*
         * config는 **여기 한 곳에서만 조립한다.** 예전에는 verbosity 스프레드와
         * 오케스트레이터 스프레드가 각자 config 키를 만들어 뒤가 앞을 통째로 덮는
         * 함정이 있었다 — 기여자가 셋(요약·verbosity·오케스트레이터)이 되면서
         * 함정을 기억하는 것보다 없애는 쪽이 싸다.
         */
        config: {
          // 추론 요약 스위치 (#58 실측): 안 켜면 item/reasoning/* 스트림이 한 건도 안 온다
          model_reasoning_summary: 'auto',
          ...(this.opts.verbosity ? { model_verbosity: this.opts.verbosity } : {}),
          // 응답 속도 (실측: priority = "Fast, 1.5x speed, increased usage")
          ...(this.opts.serviceTier ? { service_tier: this.opts.serviceTier } : {}),
          // MCP 서버 — 오케스트레이터의 다리와 붙은 외부 앱의 다리(승인된 MCP 서버 포함) (mcpConfig 참고)
          ...(await this.mcpConfig()),
          // 저장소의 파일(.codex/ 설정·훅·규칙, AGENTS.md)은 신뢰한 프로젝트에서만 (#92, repoFilesConfig)
          ...repoFilesConfig(this.opts),
        },
      })
      this.threadId = threadIdOf(res)
    }
    this.externalId = this.threadId
  }

  /**
   * 스레드에 실을 MCP 설정 — 시작과 재개가 **같은 조립**을 쓴다(재개에서 빠지는 것이 없게).
   *
   * 둘이다:
   *   1. 오케스트레이터 도구의 다리 (FR-11)
   *   2. 외부 앱의 다리 (M4 A-5) — 앱마다 하나. **붙은 앱이 있는 세션에만** 생긴다: 대부분의 세션은
   *      다리 프로세스를 하나도 띄우지 않는다. 사람이 승인한 MCP 서버(propose_mcp_server)도 사용자
   *      폴더의 앱이 되어 여기로 온다(A-7). 예전에는 그 서버를 날것으로 실었는데, Codex가 그 서버의
   *      도구를 쓸지 묻는 elicitation을 우리가 거절해서(`ours`만 수락) 한 번도 돌지 못했을 가능성이
   *      높았다(플랜 "별개로 확인할 것" 2). 앱 다리의 도구 승인은 우리 승인 카드로 간다.
   *
   * 앱 다리는 Codex가 띄우는 stdio 프로세스다(플랜 S-3의 셋 중 하나). HTTP(`url`)는 0.147.0에서
   * 요청이 한 건도 오지 않았고 0.153.4에서는 재지 못했다. 다리는 오케스트레이터와 같은 파일이다
   * (`CC_APP_SERVER`로 갈린다).
   */
  private async mcpConfig(): Promise<Record<string, unknown>> {
    const bridge = this.opts.orchestratorBridge
    const servers: Record<string, unknown> = {}
    const orchestrator = !!(this.opts.orchestratorTools && bridge)
    if (orchestrator) {
      servers[ORCHESTRATOR_MCP_NAME] = {
        command: process.execPath,
        args: [bridgePath()],
        env: { CC_HOST_URL: bridge!.url, CC_HOST_TOKEN: bridge!.token, CC_SESSION_ID: this.opts.sessionId },
      }
    }
    const apps = this.opts.apps
    const attached = apps?.current() ?? []
    this.appServers = new Set()
    if (apps && bridge && attached.length > 0) {
      /*
       * 도구 목록을 먼저 읽는다 — 읽기 전용 도구를 도구별로 적어야 safe에서도 그 도구를 묻지 않는다.
       * 모르는 앱은 여기서 띄워 읽는다(상한 있음). 붙은 앱이 없는 세션은 이 줄을 지나지 않는다.
       */
      const lists = await Promise.all(attached.map((a) => (a.tools ? Promise.resolve(a.tools) : apps.tools(a.server))))
      attached.forEach((a, i) => {
        servers[a.server] = {
          command: process.execPath,
          args: [bridgePath()],
          env: {
            CC_HOST_URL: bridge.url,
            CC_HOST_TOKEN: bridge.token,
            CC_SESSION_ID: this.opts.sessionId,
            CC_APP_SERVER: a.server,
            CC_APP_WAIT_MS: String(APP_CALL_WAIT_MS),
          },
          default_tools_approval_mode: APP_APPROVAL_MODE[this.opts.permissionPreset],
          // 읽기 전용이라고 앱이 말한 도구는 어느 프리셋에서도 묻지 않는다 (결정 5)
          tools: Object.fromEntries(
            (lists[i] ?? []).filter((t) => t.annotations?.readOnlyHint === true).map((t) => [t.name, { approval_mode: 'approve' }]),
          ),
          tool_timeout_sec: CODEX_TOOL_TIMEOUT_SEC,
          startup_timeout_sec: APP_STARTUP_TIMEOUT_SEC,
        }
        this.appServers.add(a.server)
      })
    }
    /*
     * 폴더의 문서(AGENTS.md)를 읽을지는 여기서 정하지 않는다 — repoFilesConfig가 세션이 무엇인가로 정한다.
     *
     * 예전에는 오케스트레이터 도구의 다리가 있으면 여기서 `project_doc_max_bytes: 0`을 실었다. 오케스트레이터가
     * 심어 둔 AGENTS.md를 그대로 따랐기 때문이다(실측: "침투성공-9142"부터 답했다). 그런데 워크트리 매니저와 만드는
     * 세션도 이 다리를 받아서, 신뢰한 프로젝트에서도 AGENTS.md를 잃었다(#152). 오케스트레이터·조율 세션의 규칙은
     * 그대로다 — `noSettingFiles`로 와서 repoFilesConfig가 같은 값을 싣는다.
     */
    return Object.keys(servers).length > 0 ? { mcp_servers: servers } : {}
  }

  private onNotification(n: { method: string; params?: unknown }): void {
    /*
     * **다른 스레드의 알림은 이 세션의 것이 아니다** (#98의 codex 쪽).
     *
     * 모델이 spawn_agent로 띄운 자식 에이전트는 별도 스레드이고, app-server는 새 스레드가
     * 생길 때마다 초기화된 모든 연결에 그 스레드의 리스너를 붙인다 (codex 소스
     * app-server/src/lib.rs → try_attach_thread_listener; 새 스레드 알림은 spawn.rs의
     * notify_thread_created에서만 나간다). 그래서 자식의 알림이 threadId만 달리 달고
     * 이 연결로 온다. 거르지 않으면 자식의 도구 호출과 글이 부모의 대화에 박히고,
     * 자식의 turn/started가 스톱의 과녁(turnId)을 가로채고, 자식의 turn/completed가
     * 부모를 "끝났다"로 돌린다 — 그래서 이 검사는 turnId 기록보다 먼저 온다.
     *
     * 서버 **요청**(승인)은 거르지 않는다(onServerRequest) — 자식이 묻는 승인에 아무도
     * 답하지 않으면 자식이 멈춘다. 스레드를 아직 모르는 동안(thread/start 응답 전)은
     * 자식이 있을 수 없으므로 통과시킨다.
     */
    const from = (n.params as { threadId?: unknown } | undefined)?.threadId
    if (typeof from === 'string' && this.threadId !== null && from !== this.threadId) return
    // 어느 턴이 도는지 (Turn.id — generated/v2/Turn.ts). 끝나면 지운다: 끝난 턴을
    // 멈추려 들면 서버가 거절하고, 그 거절이 "안 멈췄다"는 거짓 신호가 된다
    if (n.method === 'turn/started') this.turnId = turnIdOf(n.params)
    if (n.method === 'turn/completed' || n.method === 'turn/failed') this.turnId = null

    this.noteAppCall(n)

    // compact/review가 끝나는 자리 — 그동안 쌓인 메시지가 있으면 이제 내보낸다
    if (n.method === 'turn/completed' && this.blockingTurn) {
      this.blockingTurn = false
      this.flushPending()
    }
    for (const e of normalizeNotification(this.sessionId, n)) {
      /*
       * 경로만 실려 온 이미지는 여기서 바이트를 채운다 (#40). normalize는 순수 함수라
       * 파일을 못 읽는다 — IO는 어댑터의 몫이다. 읽기는 비동기지만 이미지는 대화의
       * 순서에 민감하지 않으므로(도구 줄은 이미 나갔다) 나중에 도착해도 된다.
       */
      if (e.type === 'message_image' && !e.data && e.path) {
        void imageEventFromDisk(this.sessionId, e.path).then((filled) => this.emit(filled))
        continue
      }
      this.emit(e)
    }
  }

  /**
   * 붙은 앱의 도구 호출이 시작되고 끝나는 것을 붙이기에 알린다 (M4 B-1 — 대화 안 화면의 카드 짝짓기).
   *
   * 다리로 들어오는 호출은 카드 id(`item.id`)를 모른다 — Codex가 MCP 요청에 그 id를 싣는다는 근거를
   * 찾지 못했다. 그래서 여기서 본 "카드 X가 서버 S의 도구 T를 인자 A로 부른다"를 적어 두고, 붙이기가
   * 뒤이어 온 호출과 짝짓는다. 끝난 카드(거절 포함)는 짝짓기에서 뺀다. 다른 스레드(자식 에이전트)의
   * 알림은 위에서 이미 걸렀다 — 자식의 호출은 부모의 카드가 아니다.
   */
  private noteAppCall(n: { method: string; params?: unknown }): void {
    const apps = this.opts.apps
    if (!apps || (n.method !== 'item/started' && n.method !== 'item/completed')) return
    const item = (n.params as { item?: Record<string, unknown> } | undefined)?.item
    if (!item || item.type !== 'mcpToolCall' || typeof item.id !== 'string') return
    if (n.method === 'item/completed') return apps.callEnded(item.id)
    const server = typeof item.server === 'string' ? item.server : ''
    const tool = typeof item.tool === 'string' ? item.tool : ''
    if (!this.appServers.has(server) || !tool) return
    apps.noteCall(item.id, server, tool, item.arguments ?? (item.invocation as { arguments?: unknown } | undefined)?.arguments ?? {})
  }

  private onServerRequest(r: { id: number | string; method: string; params?: unknown }): void {
    /*
     * **elicitation은 승인과 응답 형식이 다르다.**
     *
     * MCP 서버를 쓸지 물을 때 codex는 elicitation을 보내고 `{ action }`을 기다린다.
     * 우리는 모르는 서버 요청을 `{}`로 흘려보내고 있었는데, 그러면 codex가
     * "missing field `action`"으로 역직렬화에 실패하고 **거절로 처리한다** —
     * 화면에는 "권한이 거절되어"라고만 나와 원인을 알 수 없었다 (실측).
     *
     * 우리 서버는 받아들이고, 모르는 서버는 거절한다. 물어볼 화면이 없는데
     * 조용히 승낙하면 그건 사용자를 대신해 결정하는 것이다.
     */
    if (r.method.toLowerCase().includes('elicitation')) {
      const p = (typeof r.params === 'object' && r.params !== null ? r.params : {}) as {
        serverName?: string
        message?: unknown
        _meta?: unknown
      }
      /*
       * **붙인 앱의 도구 승인은 우리 승인 카드로 간다** (M4 A-5, 결정 5).
       *
       * Codex는 MCP 도구를 쓸지 이 elicitation으로 묻고, 그것이 도구 승인이라는 표시를
       * `_meta`에 싣는다. 예전처럼 거절하면 앱 도구는 Codex에서 한 번도 돌지 못한다(플랜
       * "별개로 확인할 것" 2와 같은 모양). 카드로 보내는 것은 **이 스레드에 우리가 실은 앱 서버**의
       * **도구 승인**뿐이다 — 이름이 `app-`로 시작하는 남의 서버(사용자의 config.toml)도, 도구
       * 승인이 아닌 elicitation(입력 양식)도 예전처럼 거절한다.
       *
       * 소스로만 확인했다(로그아웃, S-3): 0.153.4 바이너리의 문자열은 `codex_approval_kind`,
       * 지금의 codex 소스는 `codex/approval_kind`다 — 둘 다 읽는다.
       */
      if (typeof p.serverName === 'string' && this.appServers.has(p.serverName) && approvalKindOf(p._meta) === 'mcp_tool_call') {
        const requestId = `codex-req-${++this.reqCounter}`
        this.approvals.set(requestId, r.id)
        this.elicitations.add(requestId)
        this.emit({ type: 'approval_request', sessionId: this.sessionId, requestId, detail: appApprovalDetail(p.serverName, p.message, p._meta) })
        return
      }
      const ours = p.serverName === ORCHESTRATOR_MCP_NAME
      this.client.respond(r.id, { action: ours ? 'accept' : 'decline', content: null, _meta: null })
      return
    }

    if (!r.method.includes('requestApproval') && !r.method.endsWith('Approval')) {
      /*
       * 승인이 아닌 서버 요청은 빈 응답으로 흘려보낸다 (프로토콜이 늘어나도 멈추지 않게).
       * 단 **무엇을 흘려보냈는지는 남긴다** (#58) — elicitation이 이 빈 {} 때문에
       * 깨졌을 때 로그 한 줄이 없어서 원인 찾기가 미궁이었다. 요청은 알림과 달라
       * 우리 답이 저쪽 행동을 바꾼다: 다음 번 같은 사고는 grep 한 번이어야 한다.
       */
      console.error('[codex] unknown server request answered with {}:', r.method)
      this.client.respond(r.id, {})
      return
    }
    const params = (typeof r.params === 'object' && r.params !== null ? r.params : {}) as Record<
      string,
      unknown
    >

    const detail = approvalDetailFrom(r.method, params)

    // 저장된 '항상 허용' 규칙에 맞으면 묻지 않는다 (C-2와 같은 규칙)
    const key = detail.kind === 'command' ? detail.command : detail.kind === 'file_edit' ? detail.path : ''
    if (key && this.isAlwaysAllowed(key)) {
      this.client.respond(r.id, { decision: 'accept' })
      return
    }

    const requestId = `codex-req-${++this.reqCounter}`
    this.approvals.set(requestId, r.id)
    this.emit({ type: 'approval_request', sessionId: this.sessionId, requestId, detail })
  }

  private isAlwaysAllowed(key: string): boolean {
    for (const m of this.alwaysAllow) {
      if (m.endsWith('*') ? key.startsWith(m.slice(0, -1)) : key === m) return true
    }
    return false
  }

  applyRules(matchers: readonly string[]): void {
    for (const m of matchers) this.alwaysAllow.add(m)
  }

  send(text: string): void {
    void this.ready
      .then(() => {
        if (!this.threadId) throw new Error('Thread is not ready')
        /*
         * compact/review가 도는 동안은 보내지 않고 쌓는다 — pendingInputs 주석의 실측이
         * 근거다 (보내면 codex가 성공을 답하며 **버린다**). 슬래시 함수가 여기 끼면
         * 글자 그대로 전달되는 한계는 남는데, compact 중의 /compact은 어차피 무의미하다.
         */
        if (this.blockingTurn) {
          this.pendingInputs.push(text)
          return
        }
        /*
         * **compact은 메시지가 아니라 함수다** (도그푸딩 지적 — "메시지 보내면 작동하는게
         * 아니라"가 정확한 관찰이었다). codex CLI에서 /compact은 대화에 들어가지 않고
         * 압축을 실행하는데, app-server 경로에는 그 슬래시 처리기가 없다 — turn/start로
         * 보내면 모델이 "/compact"라는 **글자를 읽는다.** 전용 RPC가 따로 있다:
         * thread/compact/start (generated/ClientRequest.ts). 실측: 즉시 {}를 답하고
         * turn/started → contextCompaction 아이템 → thread/compacted로 진행돼,
         * 기존 normalize 배관(압축 중 표시·완료 마커)이 그대로 받는다.
         */
        if (text.trim() === '/compact') {
          this.blockingTurn = true
          return this.client
            .request('thread/compact/start', { threadId: this.threadId })
            .catch((e: unknown) => {
              // 시작하지 못한 턴을 기다리면 큐가 영원히 잠긴다 — 풀고 쌓인 것부터 내보낸다
              this.blockingTurn = false
              this.flushPending()
              throw e
            })
        }
        /*
         * /review도 같은 종류다 (review/start RPC). 실측: 인자 없으면 codex CLI의 기본과
         * 같은 "지금 바뀐 것들" 리뷰, 인자가 있으면 그 지시대로(custom). 결과는 보통
         * 턴처럼 온다 — 리뷰 본문은 agentMessage로 스트리밍되고(기존 배관), 시작·끝은
         * enteredReviewMode/exitedReviewMode 아이템으로 온다 (normalize가 activity로 바꾼다).
         * 상류가 review 턴도 조종 불가로 분류하므로("cannot steer a review turn")
         * compact과 같이 큐로 지킨다.
         */
        if (text.trim() === '/review' || text.trim().startsWith('/review ')) {
          const instructions = text.trim().slice('/review'.length).trim()
          this.blockingTurn = true
          return this.client
            .request('review/start', {
              threadId: this.threadId,
              target: instructions ? { type: 'custom', instructions } : { type: 'uncommittedChanges' },
            })
            .catch((e: unknown) => {
              this.blockingTurn = false
              this.flushPending()
              throw e
            })
        }
        /*
         * /goal도 함수다 (2026-09-07 — /compact·/review와 같은 #58 부류). turn/start로
         * 보내면 모델이 "/goal"이라는 글자를 읽는다. 전용 RPC 세 개가 있다:
         * thread/goal/set·get·clear. 상태 변화는 thread/goal/updated|cleared 알림으로
         * 돌아와 배지가 그걸 그린다 — 여기서는 채팅에 한 줄 확인만 남긴다 (로컬 명령의
         * 답이 안 보이면 실행됐는지 알 길이 없다 — claude local_command_output의 교훈).
         * 턴이 아니라서 blockingTurn은 걸지 않는다.
         */
        if (text.trim() === '/goal' || text.trim().startsWith('/goal ')) {
          const arg = text.trim().slice('/goal'.length).trim()
          const say = (line: string) =>
            this.emit({ type: 'message_delta', sessionId: this.sessionId, role: 'assistant', text: line })
          if (!arg) {
            return this.client
              .request<{ goal: { objective?: string; status?: string } | null }>('thread/goal/get', {
                threadId: this.threadId,
              })
              .then((r) =>
                say(
                  r.goal ? `Goal (${r.goal.status ?? 'active'}): ${r.goal.objective ?? ''}` : 'No goal set.',
                ),
              )
          }
          if (arg === 'clear') {
            return this.client
              .request('thread/goal/clear', { threadId: this.threadId })
              .then(() => say('Goal cleared.'))
          }
          /*
           * 응답이 준 **상태를 그대로 말한다** (도그푸딩 2026-09-08: "등록은 된 것 같은데
           * 동작을 안 한다").
           *
           * 실측: 스레드에 이미 끝난 골이 있으면, 새 목표를 넣어도 codex가 status를
           * complete로 둔 채 objective만 갈아 끼운 기록을 남겼다. 그때 우리가 "Goal set"
           * 이라고만 답하면, 화면은 됐다고 하는데 골 루프는 돌지 않는 상태가 된다 —
           * 배지도 안 뜬다(완료된 골은 배지를 안 세우는 것이 우리 규칙이라).
           */
          const setGoal = () =>
            this.client.request<{ goal?: { status?: string } }>('thread/goal/set', {
              threadId: this.threadId as string,
              objective: arg,
            })
          const statusOf = (r: { goal?: { status?: string } }) =>
            typeof r?.goal?.status === 'string' ? r.goal.status : 'active'
          return setGoal().then(async (first) => {
            /*
             * **끝난 골 위에 새 목표를 얹으면 끝난 채로 남는다** (실측 2026-09-08).
             *
             * 그 스레드에는 이틀 전 모델이 스스로 complete로 표시한 골이 있었고, 새
             * 목표를 set하자 codex는 objective만 갈아 끼운 채 status를 complete로 두었다.
             * 완료된 골은 아무것도 굴리지 않으므로, 사람 눈에는 "등록은 됐는데 동작을
             * 안 하는" 상태가 된다.
             *
             * 사람이 새 목표를 적었다는 것은 **다시 시작하겠다는 뜻**이다. 그래서 한 번만
             * 비우고 다시 건다 — 그래도 active가 아니면 지어내지 않고 그 상태를 말한다.
             */
            let status = statusOf(first)
            if (status !== 'active') {
              await this.client.request('thread/goal/clear', { threadId: this.threadId }).catch(() => {})
              status = statusOf(await setGoal())
            }
            say(status === 'active' ? `Goal set: ${arg}` : `Goal set (${status}): ${arg}`)
          })
        }
        return (
          this.client
            .request('turn/start', {
              threadId: this.threadId,
              input: [{ type: 'text', text }],
              /*
               * 추론 강도는 턴 단위로 넘긴다 — codex가 "이 턴과 이후 턴"에 적용한다고
               * 문서화한 자리다. 세션을 다시 띄우지 않고 바꿀 수 있어서 이쪽이 더 싸다.
               */
              ...(this.opts.effort ? { effort: this.opts.effort } : {}),
              ...this.outputSchemaParam(),
            })
            // 응답에도 턴이 실려 온다 — 알림보다 먼저 도착하는 경우까지 덮는다 (스톱의 과녁)
            .then((res) => {
              this.turnId ??= turnIdOf(res)
            })
        )
      })
      .catch((e: Error) => {
        this.emit({
          type: 'error',
          sessionId: this.sessionId,
          error: { code: 'internal', message: e.message, retryable: true },
        })
      })
  }

  /** 막혔던 메시지를 한 턴으로 내보낸다 — 각 메시지는 제 input 항목으로 (경계를 뭉개지 않는다) */
  private flushPending(): void {
    if (this.pendingInputs.length === 0 || !this.threadId) return
    const input = this.pendingInputs.map((text) => ({ type: 'text', text }))
    this.pendingInputs = []
    void this.client
      .request('turn/start', {
        threadId: this.threadId,
        input,
        ...(this.opts.effort ? { effort: this.opts.effort } : {}),
        ...this.outputSchemaParam(),
      })
      .then((res) => {
        this.turnId ??= turnIdOf(res)
      })
      .catch((e: Error) => {
        this.emit({
          type: 'error',
          sessionId: this.sessionId,
          error: { code: 'internal', message: e.message, retryable: true },
        })
      })
  }

  /**
   * 앱이 스키마를 주고 부탁한 에이전트의 턴 (M4 D-1). Codex는 스키마를 **턴마다** 받는다 — 설치된 0.153.4의 생성 타입
   * `TurnStartParams.outputSchema`("Optional JSON Schema used to constrain the final assistant message for this turn").
   * 그래서 이 세션의 모든 턴에 싣는다: 한 번 빠지면 그 턴의 마지막 메시지는 스키마 밖의 글이 된다. 답은 마지막 메시지
   * 자체다 — 매니저가 그 글을 JSON으로 읽고 검증한다. 로그아웃 상태라 실행으로 재지 못했다(생성 타입으로만 확인).
   */
  private outputSchemaParam(): Record<string, unknown> {
    return this.opts.outputSchema ? { outputSchema: this.opts.outputSchema } : {}
  }

  respondApproval(
    requestId: string,
    decision: ApprovalDecision,
    _scope?: ApprovalScope,
    matcher?: string,
  ): boolean {
    const serverId = this.approvals.get(requestId)
    // 스레드를 다시 띄우면 이 맵은 비어 있다 — 그 전에 뜬 카드의 id는 여기에 없다
    if (serverId === undefined) return false
    this.approvals.delete(requestId)

    if (this.elicitations.delete(requestId)) {
      /*
       * 앱 도구 승인의 답 (M4 A-5). `always`는 Codex에게 "이 세션 동안 기억하라"로 넘긴다
       * (`_meta.persist: "session"` → ApprovedForSession). 소스로만 확인했다(로그아웃, S-3):
       * codex `parse_mcp_tool_approval_elicitation_response`가 accept와 이 값을 읽는다.
       */
      this.client.respond(serverId, {
        action: decision === 'deny' ? 'decline' : 'accept',
        content: null,
        _meta: decision === 'always' ? { persist: 'session' } : null,
      })
      this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId, decision })
      return true
    }
    if (decision === 'always' && matcher) this.alwaysAllow.add(matcher)
    this.client.respond(serverId, { decision: toCodexDecision(decision) })
    this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId, decision })
    return true
  }

  /** 슬래시 명령(스킬) — app-server의 공식 RPC */
  async listCommands(): Promise<{ name: string; description?: string; argumentHint?: string }[]> {
    const res = await this.client.request<{ data?: unknown }>('skills/list', {})
    const groups = Array.isArray(res?.data) ? res.data : []
    /*
     * compact은 스킬이 아니라 내장 명령이라 skills/list에 안 나온다 — 그런데 자동완성이
     * 이 목록으로 그려지므로, 여기 없으면 **쓸 수 있는데 보이지 않는** 명령이 된다
     * (있는 걸 숨기는 것도 목록의 거짓말이다). codex가 언젠가 목록에 실어 주면
     * 아래 dedupe가 우리 것을 걷어낸다.
     */
    const out: { name: string; description?: string; argumentHint?: string }[] = [
      { name: 'compact', description: '대화를 요약해 컨텍스트를 줄인다 (codex 내장)' },
      {
        name: 'review',
        description: '바뀐 코드를 리뷰한다 (codex 내장). 인자를 주면 그 지시대로 리뷰한다',
        argumentHint: '[지시]',
      },
    ]
    for (const g of groups) {
      const skills = (g as { skills?: unknown }).skills
      if (!Array.isArray(skills)) continue
      for (const s of skills) {
        const skill = (s ?? {}) as { name?: unknown; description?: unknown; enabled?: unknown }
        if (typeof skill.name !== 'string' || skill.enabled === false) continue
        if (out.some((c) => c.name === skill.name)) continue
        out.push({
          name: skill.name,
          description: typeof skill.description === 'string' ? skill.description : '',
        })
      }
    }
    return out
  }

  interrupt(): void {
    /*
     * 이 세션이 부른 앱 호출을 멈춘다 (M4 A-5) — **턴이 없어도.** 240초를 넘겨 먼저 돌려준 호출은
     * 턴이 끝난 뒤에도 돈다. 사람이 멈춤을 누른 세션의 일이 뒤에서 계속 돌면 안 된다.
     * 다리는 판단하지 않으므로 여기(host)가 끊는다. 취소는 런타임이 앱과 그 아래 일까지 전한다.
     */
    this.opts.apps?.cancelAll()
    // 도는 턴이 없으면 멈출 것도 없다 (턴이 막 끝난 뒤의 스톱이 이 자리다)
    if (!this.threadId || !this.turnId) return
    // 실패를 삼키면 "멈췄겠지" 하고 기다리게 된다 — 안 멈췄으면 안 멈췄다고 말한다
    void this.client
      .request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
      .catch((err: Error) => {
        this.emit({
          type: 'error',
          sessionId: this.sessionId,
          error: { code: 'internal', message: `Could not stop: ${err.message}`, retryable: true },
        })
      })
  }

  /**
   * 배경 재개의 감시자 (지연 재개 전용). 핸들을 먼저 내준 뒤 재개가 실패하거나
   * 상한을 넘기면, 조용히 잠들 수는 없다 — adapter_crashed를 올려서 매니저가
   * 핸들을 걷고 "없으면 되살려 보낸다" 자동 복구 경로가 서게 한다.
   */
  watchBackgroundStart(): void {
    const timer = setTimeout(() => {
      if (this.closed) return
      this.emit({
        type: 'error',
        sessionId: this.sessionId,
        error: {
          code: 'adapter_crashed',
          message: `Resuming codex did not finish within ${BACKGROUND_RESUME_CAP_MS / 1000}s`,
          retryable: true,
        },
      })
      void this.dispose().catch(() => {})
    }, BACKGROUND_RESUME_CAP_MS)
    this.ready.then(
      () => clearTimeout(timer),
      (e: Error) => {
        clearTimeout(timer)
        if (this.closed) return
        this.emit({
          type: 'error',
          sessionId: this.sessionId,
          error: { code: 'adapter_crashed', message: e.message, retryable: true },
        })
        void this.dispose().catch(() => {})
      },
    )
  }

  /** 매달린 승인을 말없이 놓지 않는다 (claude 어댑터와 같은 이유 — 화면이 카드를 붙든 채 막힌다) */
  async dispose(): Promise<void> {
    this.closed = true
    // 앱 붙이기는 핸들과 함께 닫힌다 — 새 핸들은 자기 것을 받는다
    this.opts.apps?.close()
    for (const requestId of this.approvals.keys()) {
      this.emit({ type: 'approval_resolved', sessionId: this.sessionId, requestId, decision: 'deny' })
    }
    this.approvals.clear()
    /*
     * compact이 끝나기를 기다리던 메시지와 함께 죽는 경우 — 화면에는 이미 보낸 것으로
     * 남아 있으므로(매니저가 먼저 기록한다), 말없이 버리면 원래 버그가 종료 시점에만
     * 다시 태어난다. 배달 안 됐다고 말해야 사용자가 다시 보낼 수 있다.
     */
    if (this.pendingInputs.length > 0) {
      const n = this.pendingInputs.length
      this.pendingInputs = []
      this.emit({
        type: 'error',
        sessionId: this.sessionId,
        error: {
          code: 'internal',
          message: `${n} message(s) sent during compaction were not delivered — please resend`,
          retryable: false,
        },
      })
    }
    await this.client.dispose()
  }
}

/** elicitation의 `_meta`가 말하는 승인 종류 — 0.153.4는 `codex_approval_kind`, 지금 소스는 `codex/approval_kind` */
function approvalKindOf(meta: unknown): string | null {
  if (typeof meta !== 'object' || meta === null) return null
  const m = meta as Record<string, unknown>
  const kind = m.codex_approval_kind ?? m['codex/approval_kind']
  return typeof kind === 'string' ? kind : null
}

/**
 * 앱 도구 승인 카드의 내용 — 어느 앱의 무슨 도구를 어떤 인자로. Codex가 싣는 `_meta`의 도구
 * 제목(`tool_title`)과 인자(`tool_params`)를 쓰고, 없으면 Codex의 문장(`message`)으로 물러난다.
 */
function appApprovalDetail(server: string, message: unknown, meta: unknown): ApprovalDetail {
  const m = (typeof meta === 'object' && meta !== null ? meta : {}) as Record<string, unknown>
  const title = typeof m.tool_title === 'string' && m.tool_title ? m.tool_title : typeof message === 'string' ? message : ''
  const params = m.tool_params === undefined ? '' : ` ${JSON.stringify(m.tool_params).slice(0, 1000)}`
  return { kind: 'other', raw: `${server} · ${title}${params}` }
}

/** `{turn: {id}}` — turn/started 알림과 turn/start 응답이 같은 모양으로 준다 */
function turnIdOf(payload: unknown): string | null {
  const turn = (payload as { turn?: { id?: unknown } } | undefined)?.turn
  return typeof turn?.id === 'string' ? turn.id : null
}

function threadIdOf(res: Record<string, unknown> | undefined): string | null {
  if (!res) return null
  const thread = res.thread as Record<string, unknown> | undefined
  const id = (thread?.id ?? res.threadId) as string | undefined
  return typeof id === 'string' ? id : null
}

/**
 * codex의 설정 폴더.
 *
 * codex CLI 본체가 `CODEX_HOME`을 존중한다 — 우리만 홈 경로를 박아 쓰면
 * `CODEX_HOME`을 쓰는 사람에게 **엉뚱한 폴더를 보고** 로그인 여부를 답하게 된다.
 * (로그인돼 있는데 "로그인 필요"로 보이거나 그 반대.)
 */
function codexHome(): string {
  const custom = process.env.CODEX_HOME?.trim()
  return custom ? custom : join(homedir(), '.codex')
}

/**
 * 응답 길이 단계 (#54). `model/list`가 모델별로 알려주지 않아 여기 적는다 — 대신
 * 생성 타입(generated/Verbosity.ts, ts-rs가 codex 소스에서 뽑는다)에 묶어 둔다:
 * codex가 단계를 더하거나 빼면 아래 두 검사 중 하나가 **컴파일에서** 터진다.
 * 실측(codex exec, 같은 질문): low 82단어 · high 269단어 — 이름값을 한다.
 */
const CODEX_VERBOSITIES = ['low', 'medium', 'high'] as const satisfies readonly Verbosity[]
// 빠진 단계가 없는지 — satisfies는 '틀린 값'만 잡고 '빼먹은 값'은 못 잡는다
type MissingVerbosity = Exclude<Verbosity, (typeof CODEX_VERBOSITIES)[number]>
const _allVerbositiesListed: MissingVerbosity extends never ? true : never = true
void _allVerbositiesListed

export class CodexAdapter implements AgentAdapter {
  readonly tool = 'codex' as const

  readonly descriptor: ToolDescriptor = {
    name: 'codex',
    label: 'Codex',
    mark: 'X',
    install: 'npm i -g @openai/codex',
    login: 'codex login',
  }

  readonly capabilities: AdapterCapabilities = {
    approvals: true, // M0 실측: thread/start의 approvalPolicy가 전역 설정을 덮어쓴다
    contextUsage: 'exact', // thread/tokenUsage/updated
    resume: true, // thread/resume
    autoTitle: true, // thread/name/updated
    attachments: ['image', 'file'],
    verbosities: [...CODEX_VERBOSITIES],
    // app-server의 writer lock ("already has an active writer" — client.ts가 번역하는 그 오류).
    // 우리가 핸들을 쥔 동안의 기록 변화는 전부 우리 것이라는 보장이고, 매니저가 그 위에서
    // 따라잡기 스킵 표식을 찍는다 (48.6MB/8초짜리 thread/read를 건너뛰는 근거다).
    exclusiveWriter: true,
  }

  async detect(): Promise<DetectResult> {
    const path = whichTool('codex')
    try {
      const { stdout } = await exec(path ?? 'codex', ['--version'], { timeout: 5000 })
      const version = `${stdout.trim()} · ${path ?? 'PATH'}`
      // 로그인 여부는 인증 파일 존재로 판단한다 (CLI를 띄우지 않고 값싸게)
      const loggedIn = existsSync(join(codexHome(), 'auth.json'))
      return {
        tool: 'codex',
        installed: true,
        loggedIn,
        detail: loggedIn ? version : `${version} · login required`,
      }
    } catch {
      return {
        tool: 'codex',
        installed: false,
        loggedIn: false,
        detail: 'codex CLI not found (check with `which codex` in a terminal)',
      }
    }
  }

  listExternalSessions(cwd: string, limit: number) {
    return listCodexThreads(cwd, limit, whichTool('codex') ?? 'codex')
  }

  /**
   * 잠긴 대화에서 갈라져 나온다 (`thread/fork`).
   *
   * 사용량 조회와 같은 이유로 **단명 클라이언트**를 쓴다 — 이건 세션이 아니라
   * 세션을 만들기 **전에** 하는 일이라, 붙잡고 있을 스레드가 아직 없다.
   *
   * 원본은 건드리지 않는다. codex가 새 스레드에 `forkedFromId`로 출처를 남겨 준다.
   */
  async forkConversation(externalId: string, cwd: string): Promise<string> {
    const client = new CodexClient(
      { onNotification: () => {}, onServerRequest: (r) => client.respond(r.id, {}), onExit: () => {} },
      { cwd, command: whichTool('codex') ?? 'codex' },
    )
    try {
      await client.request('initialize', {
        clientInfo: CLIENT_INFO,
        capabilities: null,
      })
      client.notify('initialized')
      const res = await client.request<Record<string, unknown>>('thread/fork', { threadId: externalId })
      const forked = threadIdOf(res)
      // 갈라졌다면서 새 id를 못 주면 이어갈 데가 없다 — 조용히 원본으로 되돌아가면 또 잠긴다
      if (!forked) throw new Error('codex forked the conversation but returned no thread id')
      return forked
    } finally {
      await client.dispose()
    }
  }

  /**
   * 스레드 원본을 지운다 (thread/delete RPC). fork와 같은 이유로 단명 클라이언트다 —
   * 세션은 이미 dispose된 뒤라 붙잡고 있을 프로세스가 없다. 이 호출이 rollout 파일을
   * 도구 쪽에서 거둬 간다 (실측 550MB짜리가 여기서 사라진다).
   */
  async deleteExternalConversation(externalId: string, cwd: string): Promise<void> {
    const client = new CodexClient(
      { onNotification: () => {}, onServerRequest: (r) => client.respond(r.id, {}), onExit: () => {} },
      { cwd, command: whichTool('codex') ?? 'codex' },
    )
    try {
      await client.request('initialize', { clientInfo: CLIENT_INFO, capabilities: null })
      client.notify('initialized')
      await client.request('thread/delete', { threadId: externalId })
    } catch (e) {
      /*
       * **없는 것을 지우라는 요청은 실패가 아니다** (도그푸딩 2026-09-07: 워크트리 세션을
       * 잘못 만들고 지우려다 "Could not delete: no rollout found for thread id …").
       *
       * 실측: codex는 thread/start에서 스레드 id만 발급하고 rollout 파일은 **첫 턴에**
       * 쓴다. 그래서 한 번도 말을 안 건 세션은 지울 파일이 없고, thread/delete가
       * -32600으로 거절한다. 그 거절을 그대로 던지면 매니저가 여기서 멈춰서 세션 행도
       * 워크트리도 안 지워진다 — 잘못 만든 세션일수록 못 지우는 셈이다.
       *
       * 목적("도구 쪽에 남아 있지 않게 하기")은 이미 이뤄져 있으므로 성공으로 친다.
       * 다른 실패는 그대로 던진다 — 원본이 살아 있는데 지웠다고 답하는 것이 최악이라는
       * 규칙(매니저 주석)은 그대로다.
       */
      if (!/no rollout found/i.test((e as Error).message)) throw e
    } finally {
      await client.dispose()
    }
  }

  /** 죽은 codex의 마지막 컴팩트 요약 (#78) — 롤아웃 파일에서, 바이너리 없이 (rollout.ts) */
  async lastCompactSummary(externalId: string): Promise<string | null> {
    return rolloutLastCompactSummary(externalId)
  }

  /**
   * 계정 사용량 (FR-9).
   * 세션과 무관하므로 단명 클라이언트로 묻는다 — 대화 중인 스레드에 조회를 얹지 않는다.
   */
  async listUsage() {
    return readCodexUsage(whichTool('codex') ?? 'codex')
  }

  async listModels() {
    return listCodexModels(whichTool('codex') ?? 'codex')
  }

  readExternalHistory(externalId: string, cwd: string, limit: number) {
    return readCodexHistory(externalId, cwd, limit, whichTool('codex') ?? 'codex')
  }

  async createSession(opts: CreateSessionOpts, emit: EventSink): Promise<SessionHandle> {
    const session = new CodexSession(opts, emit)
    /*
     * **재개는 클로드처럼 — 사람 앞에서 기다리지 않는다** (도그푸딩: 같은 스레드가
     * CLI에선 3초, 우리 경로에선 13초+였다. thread/resume이 파일 전체를 되읽는 비용은
     * 못 없애지만, 그 비용을 "Waking…" 화면 앞에서 치를 이유는 없다 — 재개는 스레드
     * id를 이미 알고 있어서, 핸들을 먼저 내줘도 잃는 것이 없다. send는 ready에
     * 큐잉된다).
     *
     * 단 3초는 동기로 기다린다: 잠금 오류("already has an active writer")는 즉시
     * 오므로(실측 ~0.3s), 이 창 안에서 던져야 "다른 곳에서 열려 있음 → 갈라서
     * 이어가기" 갈림길 UI가 지금처럼 산다. 새 스레드(thread/start)는 예전 그대로
     * 끝까지 기다린다 — id가 생겨야 재개가 가능하다 (M1.5 결함 5번 교훈).
     */
    if (opts.resumeExternalId) {
      session.externalId = opts.resumeExternalId
      const outcome = await Promise.race([
        session.ready.then(
          () => 'ready' as const,
          (err: unknown) => ({ err }),
        ),
        new Promise<'pending'>((r) => setTimeout(() => r('pending'), LAZY_RESUME_WAIT_MS)),
      ])
      if (outcome === 'pending') {
        session.watchBackgroundStart()
        return session
      }
      if (outcome !== 'ready') {
        await session.dispose().catch(() => {})
        throw outcome.err
      }
      return session
    }
    try {
      await session.ready
    } catch (err) {
      /*
       * 준비에 실패한 세션은 핸들이 밖으로 나가지 않는다 — dispose를 불러줄 사람이 없다.
       * 생성자에서 이미 뜬 app-server를 여기서 거두지 않으면, 잠긴 스레드를 이어가려다
       * 실패할 때마다 자식 프로세스가 하나씩 조용히 샜다.
       */
      await session.dispose().catch(() => {})
      throw err
    }
    return session
  }
}
