import { z } from 'zod'
import {
  AdapterCapabilities,
  ApprovalDecision,
  ApprovalDetail,
  ApprovalScope,
  Attachment,
  GitBranch,
  GitCommit,
  GitDiff,
  ExternalSession,
  UsageSnapshot,
  GitFileStatus,
  ModelOption,
  PermissionPreset,
  Question,
  QuestionAnswer,
  SessionActivity,
  SessionState,
  TokenUsage,
  ToolName,
  UpdateStatus,
} from './entities.js'

/** UI → host RPC. 포트 인터페이스(platform/ports)와 1:1 대응 (docs/protocol.md §3) */

export const CreateSessionParams = z.object({
  projectId: z.string(),
  cwd: z.string(),
  tool: ToolName,
  model: z.string().optional(),
  effort: z.string().optional(),
  /** 응답 길이 (codex의 model_verbosity). 지원 단계는 어댑터 능력 선언이 말한다 (#54) */
  verbosity: z.string().optional(),
  /** 응답 속도 (codex의 service_tier). 지원 티어는 모델 목록(ModelOption.tiers)이 말한다 */
  serviceTier: z.string().optional(),
  permissionPreset: PermissionPreset.default('normal'),
  initialPrompt: z.string().optional(),
  resumeExternalId: z.string().optional(),
  /** 재개할 때 이전 대화도 화면에 복원한다 (resumeExternalId와 함께 쓴다) */
  importHistory: z.boolean().optional(),
  /**
   * 이 세션만 **깃 워크트리에서** 돌린다 (FR-2의 후순위 옵션).
   *
   * 기본은 원본 디렉토리에서 직접 작업하는 것이다 — 워크트리는 강제하지 않는다.
   * 같은 디렉토리에 세션이 여럿일 때 파일 충돌을 원천적으로 없애고 싶은 사람만 켠다.
   */
  worktree: z.boolean().optional(),
  /**
   * 워크트리 브랜치 이름 (#69). 생략하면 자동 이름(`centralu/<id 앞 8자>`)이다.
   *
   * 브랜치 이름이 곧 세션 이름이자 워크트리 디렉토리 이름이다 — 사실상 영구라서
   * (나중에 바꾸려면 트리를 다시 만들어야 한다) 여기서 사람이 정할 수 있어야 한다.
   * 검증은 host가 한다 (`git check-ref-format` — 규칙을 우리가 다시 적지 않는다).
   */
  worktreeBranch: z.string().optional(),
})
export type CreateSessionParams = z.infer<typeof CreateSessionParams>

/**
 * 세션 설정 변경. **이름을 주는 이유**는 포트도 이 타입을 그대로 쓰기 위해서다.
 *
 * 예전에는 포트가 `{ model?, permissionPreset? }`라고 손으로 다시 적었고,
 * 나중에 추가된 `effort`가 거기 빠진 채로 남았다. 그런데도 동작했다 —
 * 스토어가 **변수**로 넘기면 TypeScript는 초과 속성을 검사하지 않기 때문이다.
 * 타입이 "없다"고 말하는 필드가 실제로는 흐르고 있었다.
 */
export const UpdateSettingsParams = z.object({
  sessionId: z.string(),
  model: z.string().nullable().optional(),
  /** 추론 강도. 모델마다 지원 단계가 다르므로 문자열 그대로 나른다 */
  effort: z.string().nullable().optional(),
  /** 응답 길이. effort와 같은 규칙으로 문자열 그대로 나른다 (#54) */
  verbosity: z.string().nullable().optional(),
  /** 응답 속도. 같은 규칙 — 지원 티어는 모델 목록이 말한다 */
  serviceTier: z.string().nullable().optional(),
  permissionPreset: PermissionPreset.optional(),
})
export type UpdateSettingsParams = z.infer<typeof UpdateSettingsParams>

/**
 * 세션의 역할 (#13).
 *
 * `projectId === null`이 곧 오케스트레이터라는 판정이 여섯 군데에 흩어져 있었고, 그
 * 흩어짐을 표식 하나로 모은 것이 이 필드다. 프로젝트 오케스트레이터가 폐기되면서
 * (2026-09-01) 두 판정은 다시 같은 뜻이 됐지만, 표식은 남긴다 — 판정이 한 군데인 편이
 * 여전히 낫고, 되돌리는 마이그레이션은 얻는 것 없이 위험만 있다.
 */
export const SessionKind = z.enum(['worker', 'orchestrator'])
export type SessionKind = z.infer<typeof SessionKind>

export const SessionInfo = z.object({
  id: z.string(),
  /**
   * 소속 프로젝트. **오케스트레이터만 null이다** — 프로젝트를 가로지르는 세션이라
   * 어디에도 매달지 않는다 (매달면 그 프로젝트를 지울 때 함께 죽는다).
   */
  projectId: z.string().nullable(),
  /** 워커인가 오케스트레이터인가. 기본은 워커 — 옛 프레임에는 이 필드가 없다 */
  kind: SessionKind.default('worker'),
  tool: ToolName,
  externalId: z.string().nullable(),
  name: z.string(),
  autoNamed: z.boolean(),
  state: SessionState,
  lastReadSeq: z.number().default(0),
  lastSeq: z.number().default(0),
  createdAt: z.number(),
  /** 대기 시작 시각 — 인박스 정렬·경과 시간 표시 (FR-12/15) */
  waitingSince: z.number().nullable().default(null),
  /** 프로세스가 살아 있는가. false면 대화를 이어가려면 재개가 필요하다 (FR-10) */
  live: z.boolean().default(true),
  /** 대화 도중에도 바꿀 수 있다 (FR-7) — 세션 헤더에서 고른다 */
  model: z.string().nullable().default(null),
  /** 추론 강도. 지원하지 않는 모델이면 null이다 */
  effort: z.string().nullable().default(null),
  /**
   * 응답 길이 (#54). null이면 도구 기본값.
   *
   * effort와 달리 **다음에 깰 때** 적용된다 — codex의 turn/start에는 이 자리가 없고
   * thread config로만 넘어간다 (generated/v2/TurnStartParams.ts에 없음 — 실측).
   * 매니저의 drift 재시작이 그 길을 이미 알고 있으므로 배관은 effort와 같다.
   */
  verbosity: z.string().nullable().default(null),
  /** 응답 속도 (#54와 같은 배관). null이면 codex 기본. verbosity처럼 다음에 깰 때 적용된다 */
  serviceTier: z.string().nullable().default(null),
  permissionPreset: PermissionPreset.default('normal'),
  /**
   * 이어받은 이전 대화의 식별자 (불러오기로 만든 세션만).
   * externalId와 다를 수 있다 — 도구가 resume하면서 새 식별자를 발급하기 때문이다.
   */
  importedFrom: z.string().nullable().default(null),
  /**
   * 이 세션이 도는 워크트리. null이면 프로젝트 디렉토리에서 직접 돈다(기본).
   *
   * 경로를 들고 있는 이유: 재개할 때도 **같은 워크트리**로 돌아가야 한다.
   * 프로젝트 경로로 되돌아가면 격리가 조용히 풀린다 — 사용자는 여전히 격리된 줄 안다.
   */
  worktree: z
    .object({
      path: z.string(),
      branch: z.string(),
      /** 생성 시점의 HEAD sha (#69) — 병합 감지의 기준점. 갓 만든 브랜치를 병합됨으로 안 읽기 위한 것 */
      base: z.string().optional(),
    })
    .nullable()
    .default(null),
  /**
   * 이 워크트리 브랜치의 작업이 프로젝트 줄기에 다 들어갔는가 (#69).
   *
   * git에서 파생되는 사실이라 저장하지 않는다 — 기동 때와 프로젝트 git 새로고침 때
   * 다시 판정한다. 스쿼시·리베이스 병합은 로컬 감지 불가(실측)라 이 값이 false로
   * 남을 수 있다. 그 비용은 배지 하나다: 사람이 지우는 길은 언제나 열려 있다.
   */
  worktreeMerged: z.boolean().default(false),
  /**
   * 이 워크트리 브랜치의 풀 리퀘스트 (#76 stage 3). null이면 "모른다"다 — 없다가 아니다.
   *
   * gh CLI로 측정한 파생 사실이라 저장하지 않는다(worktreeMerged와 같은 원칙).
   * 존재 이유는 위 사각지대다: 스쿼시·리베이스 병합은 로컬 감지 불가인데 GitHub PR의
   * 지배적 결말이 스쿼시다. PR의 MERGED는 서버가 기록한 사실이라 그 사각지대가 없다.
   * gh가 없거나 오프라인이면 이 값은 그냥 null로 남는다 — 배지 하나의 근거일 뿐이다.
   */
  worktreePr: z
    .object({ number: z.number(), state: z.enum(['open', 'merged', 'closed']), url: z.string() })
    .nullable()
    .default(null),
  /**
   * 이 세션이 매달린 매니저 세션 (#69). null이면 최상위(보통).
   *
   * 워크트리 세션은 반드시 매니저 아래에 선다 — 소속이 없을 때 이 분류의 1번 문서화된
   * 실패(고아 워크트리: Vibe Kanban #1764/#2335/#1571)가 일어난다. 매니저는 새로운 종류가
   * 아니라 자식을 가진 보통 세션이고, 사이드바 트리가 이 필드 하나로 그려진다.
   *
   * 대화가 아니라 행에 사는 이유: 소속은 세션 프로세스보다 오래 살아야 한다.
   * 도구 쪽 대화가 사라져도(외부 삭제) 이 링크는 남아서 관계가 복원된다.
   */
  parentSessionId: z.string().nullable().default(null),
  /**
   * **살아 있는 동안만 유효한 사실들** — DB가 아니라 host 메모리에서 온다.
   *
   * 이 필드들이 없던 동안, 재연결·앱 재시작 후 목록을 다시 받으면
   * state=waiting_approval인데 **카드를 그릴 payload가 없어** 승인 카드가 안 뜨고
   * requestId도 없어 응답할 길이 없었다 — 에이전트는 영원히 블록됐다 (실측).
   * host 프로세스가 재시작되면 정말로 사라진 것이므로 기본값(null/[])이 맞다.
   */
  pendingApproval: z.object({ requestId: z.string(), detail: ApprovalDetail }).nullable().default(null),
  pendingQuestions: z.array(z.object({ requestId: z.string(), questions: z.array(Question) })).default([]),
  activity: SessionActivity.nullable().default(null),
  limit: z
    .object({ resumeAt: z.string().optional(), usedPercent: z.number().optional(), windowMins: z.number().optional() })
    .nullable()
    .default(null),
  usage: TokenUsage.nullable().default(null),
  /**
   * How full the conversation's context is — **the one above that survives a restart** (#48).
   *
   * It sits with the live-only fields because it arrives the same way (an event, once a turn),
   * but it is not a fact about our process: it describes the conversation, which belongs to the
   * tool and outlives us. So the store writes it down and reads it back (schema v17), and
   * `null` here means "this session has never reported one" rather than "we forgot".
   */
  context: z
    .object({ used: z.number(), window: z.number(), exactness: z.enum(['exact', 'estimate']) })
    .nullable()
    .default(null),
})
export type SessionInfo = z.infer<typeof SessionInfo>

/**
 * 살아-있는-동안 필드들의 초기값. 저장소 행이나 새 세션에서 SessionInfo를 조립할 때 쓴다 —
 * 손으로 나열하면 필드가 늘 때 한 곳이 빠진 채 컴파일이 지나간다.
 */
export function sessionLiveDefaults(): Pick<
  SessionInfo,
  'pendingApproval' | 'pendingQuestions' | 'activity' | 'limit' | 'usage' | 'context' | 'worktreeMerged' | 'worktreePr'
> {
  return {
    pendingApproval: null,
    pendingQuestions: [],
    activity: null,
    limit: null,
    usage: null,
    context: null,
    // 병합 여부(#69)도 여기 산다 — git에서 파생되는 사실이라 기동 때 다시 판정한다
    worktreeMerged: false,
    // PR 상태(#76 stage 3)도 같은 원칙 — gh로 다시 측정한다
    worktreePr: null,
  }
}

export const ProjectInfo = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  defaultTool: ToolName.default('claude'),
  defaultModel: z.string().nullable().optional(),
  /** 마지막으로 고른 추론 강도 (#69 ⑤) — default_tool·default_model과 같은 규칙: 고른 행위가 곧 기본값이다 */
  defaultEffort: z.string().nullable().optional(),
  /**
   * The shell commands saved on this project — what the Run menu offers (issue #44).
   *
   * They arrive **with the project** rather than being asked for when the menu opens. A
   * separate fetch would force the menu to tell "none saved yet" from "not loaded yet"
   * (which is why `agents.commands` carries a `ready` flag), and the project is already
   * in the store in one piece, so there is no reason to invent that distinction here.
   *
   * The string is the command itself, with no name beside it. A row therefore shows
   * exactly what it will run, and there is no label that can drift away from it.
   */
  commands: z.array(z.string()).default([]),
  /**
   * 워크트리 프로비저닝 (#69). 새 워크트리는 빈 작업대다 — 추적 파일만 있고
   * node_modules도 gitignored .env도 없다. 생성 순서: 워크트리 → 파일 복사 → 셋업
   * (Vibe Kanban이 검증한 순서). null이면 아무것도 안 돈다 — 강제하지 않는다.
   * 레포가 아니라 우리 DB에 산다 (#50: 저장소에는 아무것도 쓰지 않는다).
   */
  worktreeSetup: z.object({ command: z.string(), copyFiles: z.array(z.string()) }).nullable().default(null),
  /**
   * 이 프로젝트의 워크트리 매니저 자리와 줄기 (#76). null이면 아직 없다 — 화면은 그때
   * "매니저 시작"을 내민다. baseBranch가 워크트리가 갈라지는 곳이자 병합 판정의 기준이다.
   */
  worktreeManager: z.object({ sessionId: z.string(), baseBranch: z.string() }).nullable().default(null),
  git: z
    .object({
      branch: z.string(),
      changedFiles: z.number(),
      isRepo: z.boolean(),
      /** OS가 접근을 막았다 — '저장소 아님'과 구분해 안내한다 (F-1 실측) */
      denied: z.boolean().optional(),
    })
    .nullable()
    .default(null),
})
export type ProjectInfo = z.infer<typeof ProjectInfo>

/** 슬래시 명령(스킬) 하나 */
export const CommandInfo = z.object({
  name: z.string(),
  description: z.string().default(''),
  /** 인자 힌트 (예: "<file>") */
  argumentHint: z.string().default(''),
})
export type CommandInfo = z.infer<typeof CommandInfo>

/** 터미널 하나 (목록·생성·재시작이 모두 이 모양을 돌려준다) */
export const TerminalInfo = z.object({
  terminalId: z.string(),
  cwd: z.string(),
  title: z.string(),
  /** 지금까지의 출력 — 다시 붙었을 때 화면을 되살린다 */
  history: z.string(),
  alive: z.boolean(),
})
export type TerminalInfo = z.infer<typeof TerminalInfo>

/**
 * 자주 쓰는 명령어의 실행 하나 (#60). 명령별 **마지막 실행**만 남는다 —
 * 같은 명령을 다시 실행할 때만 교체된다 (사용자 결정, host 수명 동안 유지).
 * 출력 스트림은 터미널 프레임 레인을 그대로 탄다: runId가 terminalId 자리에 실린다.
 */
export const CommandRunInfo = z.object({
  command: z.string(),
  /** 실행마다 새 id — 화면이 출력 스트림을 갈아탈 기준 */
  runId: z.string(),
  running: z.boolean(),
  /** null이면 아직 돌고 있거나, 프로세스를 띄우지도 못한 것 (history가 이유를 말한다) */
  exitCode: z.number().nullable(),
  startedAt: z.number(),
})
export type CommandRunInfo = z.infer<typeof CommandRunInfo>

export const StoredMessage = z.object({
  sessionId: z.string(),
  seq: z.number(),
  role: z.enum(['user', 'assistant', 'system']),
  kind: z.enum(['text', 'tool_call', 'tool_result', 'approval', 'marker', 'image', 'reasoning']),
  payload: z.unknown(),
  ts: z.number(),
})
export type StoredMessage = z.infer<typeof StoredMessage>

export const RpcMethods = {
  'agents.createSession': { params: CreateSessionParams, result: SessionInfo },
  'agents.send': {
    params: z.object({ sessionId: z.string(), text: z.string(), attachments: z.array(Attachment).optional() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'agents.respondApproval': {
    params: z.object({
      sessionId: z.string(),
      requestId: z.string(),
      decision: ApprovalDecision,
      scope: ApprovalScope.optional(),
      /** '항상 허용'의 대상 패턴. core가 계산해 UI가 보낸다 */
      matcher: z.string().optional(),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * 선택지에 답한다 (AskUserQuestion). 답은 그 도구의 결과로 모델에게 돌아간다.
   *
   * 승인과 나눠 둔 이유는 돌아가는 것이 다르기 때문이다 — 승인은 실행 여부고,
   * 이건 **내용**이다. 질문이 여러 개면 답도 여러 개 온다.
   */
  'agents.answerQuestion': {
    params: z.object({
      sessionId: z.string(),
      requestId: z.string(),
      answers: z.array(QuestionAnswer),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'agents.interrupt': { params: z.object({ sessionId: z.string() }), result: z.object({ ok: z.literal(true) }) },
  /**
   * 세션을 완전히 지운다 — 대화 기록·첨부까지 사라진다.
   *
   * 한때 그 앞에 아카이브(목록에서만 숨기기)가 있었다. 2026-09-02에 폐기했다:
   * 들어가는 문(인박스의 `d`)만 있고 나오는 문이 없어서, 사람 눈에는 삭제와
   * 구별되지 않았다. 자세한 경위는 sessions/manager.ts의 deleteSession 주석에.
   */
  'agents.deleteSession': {
    params: z.object({
      sessionId: z.string(),
      /**
       * 워크트리 세션일 때만 의미가 있다. **기본은 남기는 것이다** —
       * 에이전트가 몇 시간 작업한 결과가 거기 있을 수 있고, 조용히 지우면 되돌릴 길이 없다.
       * UI가 `agents.worktreeStatus`로 먼저 묻고, 사람이 정한 답을 여기로 보낸다.
       */
      deleteWorktree: z.boolean().default(false),
      /**
       * 도구 쪽 대화 원본까지 지운다 (도그푸딩 "진짜로 삭제" — codex rollout 실측 550MB,
       * claude JSONL). 기본은 역시 남기는 것이다: 그 파일은 도구의 것이고, 남아 있으면
       * 삭제를 후회했을 때 그 도구에서 이어갈 마지막 길이 된다. 사람이 체크박스로
       * 명시한 경우에만 켠다. 원본 삭제가 실패하면 우리 쪽 삭제도 멈춘다 —
       * "지웠다"고 답했는데 원본이 남는 것이 최악의 결과라서다.
       */
      deleteExternal: z.boolean().default(false),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * 워크트리를 지워도 되는지 판단할 재료. 지우기 직전에 UI가 묻는다.
   * `null`이면 워크트리 세션이 아니다 — 물어볼 것도 없다.
   */
  /**
   * 오케스트레이터의 MCP 서버 제안 흐름 (propose_mcp_server → 사람의 원클릭 승인 →
   * 앱이 등록하고 오케스트레이터를 재시작). 제안 목록은 조회로, 답은 resolve로.
   */
  'agents.mcpProposals': {
    params: z.object({}),
    result: z.object({
      proposals: z.array(
        z.object({
          name: z.string(),
          command: z.string(),
          args: z.array(z.string()),
          why: z.string().optional(),
        }),
      ),
    }),
  },
  'agents.resolveMcpProposal': {
    params: z.object({ name: z.string(), approve: z.boolean() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * 오케스트레이터 스킬 (#71) — 제안 조회·응답과, 승인된 스킬의 목록·삭제.
   * 삭제가 있는 이유: 넣을 수만 있고 못 지우는 스킬은 없느니만 못하다 (이슈의 결정).
   */
  'agents.skillProposals': {
    params: z.object({}),
    result: z.object({
      proposals: z.array(z.object({ name: z.string(), content: z.string(), why: z.string().optional() })),
    }),
  },
  'agents.resolveSkillProposal': {
    params: z.object({ name: z.string(), approve: z.boolean() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'agents.orchestratorSkills': {
    params: z.object({}),
    result: z.object({ skills: z.array(z.object({ name: z.string(), content: z.string() })) }),
  },
  'agents.deleteOrchestratorSkill': {
    params: z.object({ name: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'agents.worktreeStatus': {
    params: z.object({ sessionId: z.string() }),
    result: z
      .object({ path: z.string(), branch: z.string(), dirty: z.boolean(), changedFiles: z.number() })
      .nullable(),
  },
  /**
   * 세션에 연결된 에이전트만 재시작한다 (대화 기록은 그대로).
   * 도구가 이상해졌을 때 세션을 새로 만들지 않고 프로세스만 갈아 끼우는 길.
   */
  'agents.restartSession': {
    params: z.object({ sessionId: z.string() }),
    result: z.object({ session: SessionInfo, resumed: z.boolean(), reason: z.string().optional() }),
  },
  'agents.resumeSession': {
    params: z.object({ sessionId: z.string() }),
    result: z.object({
      session: SessionInfo,
      resumed: z.boolean(),
      reason: z.string().optional(),
      /**
       * 이 대화를 **다른 쪽이 쥐고 있다**. 화면은 이 값만 보고 갈림길을 내민다 —
       * reason 문구를 되읽지 않는다 (문구를 고치면 조용히 깨지는 계약이 된다).
       */
      lockedElsewhere: z.boolean().optional(),
    }),
  },
  /**
   * 잠긴 대화에서 **갈라져 나와** 이 세션으로 이어간다.
   *
   * 한 대화의 쓰기 권한이 하나뿐인 도구(codex)에서, 다른 앱을 닫지 않고도 이어갈 수 있는
   * 유일한 길이다. 원본은 건드리지 않고 사본을 만들어 이 세션이 그쪽을 가리키게 한다.
   */
  'agents.forkConversation': {
    params: z.object({ sessionId: z.string() }),
    result: z.object({ session: SessionInfo, resumed: z.boolean(), reason: z.string().optional() }),
  },
  /**
   * 세션의 에이전트를 바꾼다 (claude ↔ codex).
   *
   * updateSettings와 **따로 두는 이유**: 모델·권한은 같은 대화를 이어가며 바뀌지만
   * 도구를 바꾸면 대화가 이어지지 않는다 (externalId가 도구 고유 id라 끊어내야 한다).
   * 결과가 다른 일을 같은 문으로 부르면 부르는 쪽이 그 차이를 모른 채 쓴다.
   */
  'agents.switchTool': {
    params: z.object({ sessionId: z.string(), tool: ToolName }),
    result: SessionInfo,
  },
  /** 모델·권한을 대화 도중에 바꾼다 (다음 턴부터 적용) */
  'agents.updateSettings': {
    params: UpdateSettingsParams,
    result: SessionInfo,
  },
  /**
   * 이 프로젝트 디렉토리에서 도구가 보관 중인 이전 세션 (FR-10 확장).
   * supported=false면 이유를 함께 준다 — 구버전 도구에서도 '새 세션'은 그대로 된다.
   */
  'agents.listExternalSessions': {
    params: z.object({ projectId: z.string(), tool: ToolName, limit: z.number().default(30) }),
    result: z.object({
      supported: z.boolean(),
      reason: z.string().optional(),
      sessions: z.array(ExternalSession),
    }),
  },
  'agents.capabilities': { params: z.object({ tool: ToolName }), result: AdapterCapabilities },
  'agents.detect': {
    params: z.object({}),
    result: z.array(z.object({ tool: ToolName, installed: z.boolean(), loggedIn: z.boolean(), detail: z.string() })),
  },
  'git.status': { params: z.object({ projectId: z.string() }), result: z.array(GitFileStatus) },
  'git.diff': {
    params: z.object({ projectId: z.string(), path: z.string(), staged: z.boolean().optional() }),
    result: GitDiff,
  },
  'git.log': { params: z.object({ projectId: z.string(), limit: z.number().optional() }), result: z.array(GitCommit) },
  'git.commitDetail': {
    params: z.object({ projectId: z.string(), sha: z.string() }),
    result: z.object({ files: z.array(z.string()), diff: z.string(), truncated: z.boolean() }),
  },
  'git.branches': { params: z.object({ projectId: z.string() }), result: z.array(GitBranch) },
  /**
   * git이 무시하는 것들 (#76) — 새 워크트리에 **없을** 것들의 목록.
   *
   * 워크트리 셋업 창이 "무엇을 복사할까"의 후보로 내민다. bytes는 거들 뿐이라 null일
   * 수 있다(측정이 오래 걸리면 포기한다) — 목록 자체가 답이고 크기는 판단의 재료다.
   */
  'git.ignoredEntries': {
    params: z.object({ projectId: z.string() }),
    result: z.array(z.object({ path: z.string(), bytes: z.number().nullable() })),
  },
  'git.checkout': {
    params: z.object({ projectId: z.string(), branch: z.string(), dryRun: z.boolean().optional() }),
    result: z.object({ ok: z.boolean(), conflicts: z.array(z.string()), message: z.string().optional() }),
  },
  'git.stage': {
    params: z.object({ projectId: z.string(), paths: z.array(z.string()), unstage: z.boolean().optional() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'git.commit': {
    params: z.object({ projectId: z.string(), message: z.string() }),
    result: z.object({ ok: z.boolean(), message: z.string().optional() }),
  },
  'git.push': {
    params: z.object({ projectId: z.string() }),
    result: z.object({ ok: z.boolean(), message: z.string().optional() }),
  },
  /** 붙여넣은 이미지를 host가 파일로 저장한다 (base64를 DB에 넣지 않기 위해) */
  'attachments.save': {
    params: z.object({ sessionId: z.string(), name: z.string(), mime: z.string(), dataBase64: z.string() }),
    result: Attachment,
  },
  'fs.listDir': {
    params: z.object({ projectId: z.string(), path: z.string() }),
    result: z.array(z.object({ name: z.string(), path: z.string(), isDir: z.boolean(), ignored: z.boolean() })),
  },
  /**
   * 이 프로젝트에서 감시할 디렉토리 집합 (#34). **전체를 통째로 받는다** —
   * projects.reorder와 같은 문법, 같은 이유다: 화면의 펼쳐진 집합이 곧 감시 집합이라
   * "이걸 더하고 저걸 빼고"로 주고받으면 둘이 어긋난 채로도 오류가 없다.
   * 변화는 `fs_changed` 이벤트로 온다. watched가 보낸 수보다 작으면 상한에 잘린 것이다.
   */
  'fs.watch': {
    params: z.object({ projectId: z.string(), paths: z.array(z.string()) }),
    result: z.object({ watched: z.number() }),
  },
  'fs.readFile': {
    params: z.object({ projectId: z.string(), path: z.string() }),
    result: z.object({ text: z.string(), truncated: z.boolean(), binary: z.boolean(), bytes: z.number() }),
  },
  /**
   * Move a file or folder into another folder of the same project (#19).
   *
   * The destination is a **folder**, not a full path: the gesture is a drop onto a row, and
   * the new name is always the old one. `moved: false` means it landed where it already was.
   */
  'fs.move': {
    params: z.object({ projectId: z.string(), from: z.string(), toDir: z.string() }),
    result: z.object({ path: z.string(), moved: z.boolean() }),
  },
  /**
   * Put a file dragged in from the desktop into the project (#19).
   *
   * Bytes, not a source path — the webview never tells the page where a dropped file lives,
   * which is the same reason attachments travel this way.
   */
  'fs.importFile': {
    params: z.object({ projectId: z.string(), toDir: z.string(), name: z.string(), dataBase64: z.string() }),
    result: z.object({ path: z.string() }),
  },
  /**
   * The absolute path of a project file, for the desktop shell's own OS calls
   * (revealing it in the file manager, moving it to the trash).
   *
   * The host is the only side that knows the project root, so it is the only side allowed
   * to build one — and it refuses paths that leave the project, or that are not there.
   */
  'fs.resolve': {
    params: z.object({ projectId: z.string(), path: z.string() }),
    result: z.object({ path: z.string() }),
  },
  'messages.search': {
    params: z.object({ query: z.string(), limit: z.number().optional() }),
    result: z.array(z.object({ sessionId: z.string(), seq: z.number(), snippet: z.string() })),
  },
  'workspace.save': {
    params: z.object({ layout: z.record(z.string(), z.unknown()) }),
    result: z.object({ ok: z.literal(true) }),
  },
  'approvals.deleteRule': {
    params: z.object({ id: z.number() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'workspace.load': { params: z.object({}), result: z.record(z.string(), z.unknown()).nullable() },
  'projects.add': { params: z.object({ path: z.string() }), result: ProjectInfo },
  /**
   * 프로젝트를 **지운다** — 목록에서 빼는 것이 아니라 이 앱의 기록에서 없앤다
   * (세션·대화·검색 색인·승인 규칙·사용량 귀속까지).
   *
   * **폴더는 건드리지 않는다.** 파일을 버리는 일은 OS 휴지통을 통해서만 하고 그건
   * 셸(Rust)의 몫이라, 부르는 쪽이 이 명령보다 먼저 끝낸다. 여기에 `deleteFiles`
   * 같은 스위치를 두지 않는 이유이기도 하다 — host는 파일을 버릴 손이 없으므로,
   * 받아 봐야 지킬 수 없는 약속이 된다.
   */
  'projects.delete': {
    params: z.object({ projectId: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * 사이드바 순서 바꾸기. **전체 순서를 통째로 받는다** —
   * "이걸 저기로" 식으로 주고받으면 목록이 그 사이 바뀌었을 때 어긋난다.
   */
  'projects.reorder': {
    params: z.object({ orderedIds: z.array(z.string()) }),
    result: z.array(ProjectInfo),
  },
  /**
   * Replace this project's saved shell commands (issue #44).
   *
   * The **whole list**, like `projects.reorder` above and for the same reason: it is a
   * short list a person edits by hand, so "make it look like this" states every edit —
   * adding, deleting and (one day) reordering all arrive through one door instead of three.
   *
   * Nothing on the way through inspects the commands. These are the user's own, the same
   * as typing into the terminal below; the approval system is for what an *agent* wants to
   * run, and asking permission for what the person just typed would teach them to wave the
   * prompt through where it matters.
   *
   * Answers with the stored list rather than the project so that saving a command does not
   * cost a `git status` — the caller already has everything else about the project.
   */
  'projects.setCommands': {
    params: z.object({ projectId: z.string(), commands: z.array(z.string()) }),
    result: z.array(z.string()),
  },
  /**
   * 워크트리 매니저 자리를 만든다 (#76) — 자식이 하나도 없을 때도.
   *
   * baseBranch는 이 프로젝트의 **줄기**다: 워크트리가 갈라지는 곳이자, 병합됐는지를
   * 재는 기준이다. 기본값을 host가 지어내지 않는다 — 어느 브랜치가 줄기인지는
   * 저장소마다 다르고, 틀린 기본값은 워크트리가 엉뚱한 데서 갈라진 뒤에야 드러난다.
   * 이미 자리가 있으면 그 자리를 돌려주고 줄기만 새로 적는다 (줄기를 고치는 길).
   */
  'worktrees.createManager': {
    params: z.object({ projectId: z.string(), baseBranch: z.string() }),
    result: SessionInfo,
  },
  /** 워크트리 프로비저닝 설정 저장 (#69) — 새 세션 창의 워크트리 영역이 편집한다 */
  'projects.setWorktreeSetup': {
    params: z.object({
      projectId: z.string(),
      setup: z.object({ command: z.string(), copyFiles: z.array(z.string()) }).nullable(),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  'sessions.reorder': {
    params: z.object({ projectId: z.string(), orderedIds: z.array(z.string()) }),
    result: z.array(SessionInfo),
  },
  /**
   * 그리드에 올려둔 세션들 (순서 포함).
   *
   * 자동 흐름 그리드라 배치가 곧 순서 하나다. 그래서 **추가·제거·순서 바꾸기가
   * 전부 이 한 가지**로 표현된다 — "목록을 이렇게 만들어라".
   */
  /**
   * 앱에 하나뿐인 오케스트레이터. **부르면 없을 때 만든다.**
   * 미리 만들어 두면 쓰지도 않는 세션이 도구 프로세스를 물고 있게 된다.
   */
  'orchestrator.get': { params: z.object({}), result: SessionInfo },
  /**
   * 있으면 주고, **없으면 만들지 않는다** (#63).
   *
   * 온보딩이 오케스트레이터 화면을 먼저 보여주게 되면서 "화면을 연다"와 "프로세스를
   * 만든다"가 갈라졌다 — 화면은 이걸로 묻기만 하고, 만드는 것은 사람이 첫 질문을
   * 던지는 순간의 `orchestrator.get`이다. 그 전에 만들면 묻지도 않은 사람 몫의
   * 도구 프로세스가 떠 있게 된다 (지연 기동 원칙).
   */
  'orchestrator.peek': { params: z.object({}), result: SessionInfo.nullable() },
  /**
   * 중앙 오케스트레이터가 **어느 도구 위에서 돌지** (#63, 소개 화면의 카드 선택).
   * 아직 세션이 없을 때를 위한 설정이다 — 이미 있으면 세션 설정의 Agent 전환이 맡는다.
   */
  'orchestrator.configure': {
    params: z.object({ tool: ToolName }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * 오케스트레이터 도구 — **별도 프로세스(다리)가 host로 돌아오는 길**.
   *
   * Claude는 인프로세스로 붙어서 이 문이 필요 없다. Codex는 스레드별 config로
   * stdio 서버만 물릴 수 있어서(HTTP는 실측에서 안 붙었다) 다리가 필요하고,
   * 다리는 판단을 하지 않는다 — 이름과 인자만 넘기고 규칙은 전부 host에 남는다.
   */
  'orchestrator.tools': {
    /** sessionId를 주면 그 세션의 도구 묶음(#69 매니저는 부분집합)으로 거른다 — 다리가 쓴다 */
    params: z.object({ sessionId: z.string().optional() }),
    result: z.array(z.object({ name: z.string(), description: z.string(), inputSchema: z.unknown() })),
  },
  'orchestrator.tool': {
    params: z.object({ sessionId: z.string(), name: z.string(), args: z.record(z.string(), z.unknown()) }),
    result: z.object({ text: z.string(), isError: z.boolean().optional() }),
  },
  'grid.get': { params: z.object({}), result: z.array(z.string()) },
  'grid.set': {
    params: z.object({ sessionIds: z.array(z.string()) }),
    result: z.array(z.string()),
  },
  'projects.list': { params: z.object({}), result: z.array(ProjectInfo) },
  'projects.gitStatus': { params: z.object({ projectId: z.string() }), result: ProjectInfo },
  'sessions.list': { params: z.object({}), result: z.array(SessionInfo) },
  'sessions.rename': {
    params: z.object({ sessionId: z.string(), name: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /*
   * 여기 있던 sessions.setKind(#13의 승격·강등)는 폐기했다 (2026-09-01).
   * 오케스트레이터는 이제 앱에 하나(중앙)뿐이고, 프로젝트 안에서 세션을 지휘하는 자리는
   * 워크트리 매니저(#69)다 — 역할은 고르는 것이 아니라 관계에서 나온다.
   */
  'sessions.markRead': {
    params: z.object({ sessionId: z.string(), seq: z.number() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'messages.load': {
    params: z.object({ sessionId: z.string(), limit: z.number().default(200), beforeSeq: z.number().optional() }),
    result: z.array(StoredMessage),
  },
  /**
   * 프로젝트의 터미널 목록.
   *
   * **터미널의 정체성은 cwd다** — 세션이 아니다.
   * 그래서 같은 프로젝트에서 세션을 바꿔도 같은 터미널들이 그대로 이어지고,
   * 나중에 깃 워크트리 세션이 생기면 cwd가 다르므로 자기 터미널을 따로 갖는다.
   */
  /**
   * 이 세션에서 쓸 수 있는 슬래시 명령(스킬).
   *
   * ready=false는 **아직 도구가 준비되지 않았다**는 뜻이지 없다는 뜻이 아니다 —
   * 세션을 막 만든 직후에는 CLI가 뜨는 중이라 물어볼 수 없다.
   * UI는 이걸 구분해서 '없음'과 '불러오는 중'을 다르게 보여준다.
   */
  'agents.commands': {
    params: z.object({ sessionId: z.string() }),
    result: z.object({ ready: z.boolean(), commands: z.array(CommandInfo) }),
  },
  /**
   * 계정 사용량·한도 (FR-9). 구독 한도만 다룬다.
   * supported=false면 이유가 함께 온다 — 도구가 못 주는 것과 우리가 못 읽은 것을 구분한다.
   */
  /**
   * 고를 수 있는 모델 목록. 도구가 공식 API로 알려주는 것을 그대로 나른다.
   * 구버전 도구는 모를 수 있으므로 supported=false + 이유로 내려온다.
   */
  'agents.models': {
    params: z.object({ tool: ToolName }),
    result: z.object({
      supported: z.boolean(),
      reason: z.string().optional(),
      models: z.array(ModelOption),
    }),
  },
  'agents.usage': {
    params: z.object({ tool: ToolName }),
    result: z.object({ supported: z.boolean(), reason: z.string().optional(), usage: UsageSnapshot.nullable() }),
  },
  /** `@` 자동완성용 파일 검색 (프로젝트 안에서만) */
  'files.search': {
    params: z.object({ projectId: z.string(), query: z.string(), limit: z.number().default(20) }),
    result: z.array(z.object({ path: z.string(), name: z.string() })),
  },
  'terminal.list': {
    params: z.object({ projectId: z.string() }),
    result: z.object({ terminals: z.array(TerminalInfo) }),
  },
  /** 터미널을 하나 더 연다 */
  'terminal.create': {
    params: z.object({ projectId: z.string(), cols: z.number().default(80), rows: z.number().default(24) }),
    result: TerminalInfo,
  },
  /** 터미널 하나를 닫는다 (셸 종료 + 기록 폐기) */
  'terminal.close': {
    params: z.object({ terminalId: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'terminal.input': {
    params: z.object({ terminalId: z.string(), data: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'terminal.resize': {
    params: z.object({ terminalId: z.string(), cols: z.number(), rows: z.number() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** 셸을 끝내고 새로 띄운다 (먹통이 됐을 때) */
  'terminal.restart': {
    params: z.object({ terminalId: z.string(), cols: z.number().default(80), rows: z.number().default(24) }),
    result: TerminalInfo,
  },
  /** 자주 쓰는 명령어 실행 (#60). 같은 명령이 돌고 있으면 죽이고 새로 시작한다 */
  'commands.run': {
    params: z.object({ projectId: z.string(), command: z.string(), cols: z.number().default(100), rows: z.number().default(30) }),
    result: CommandRunInfo,
  },
  /** 데브 서버를 끈다. 로그는 남는다 — 종료도 결과다 */
  'commands.stop': {
    params: z.object({ projectId: z.string(), command: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** 실행된 적 있는 명령들의 상태 (목록 뱃지용 — 로그는 log가 준다) */
  'commands.state': {
    params: z.object({ projectId: z.string() }),
    result: z.object({ runs: z.array(CommandRunInfo) }),
  },
  /** 명령 하나의 마지막 실행, 로그째. 실행된 적 없으면 null */
  'commands.log': {
    params: z.object({ projectId: z.string(), command: z.string() }),
    result: z.object({ run: CommandRunInfo.extend({ history: z.string() }).nullable() }),
  },
  'commands.resize': {
    params: z.object({ projectId: z.string(), command: z.string(), cols: z.number(), rows: z.number() }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * Where this install stands against the registry (issue #43).
   *
   * `force` is the difference between "what do you already know" (app start, cheap,
   * no network) and "go look now" (the Check now button). One method rather than two
   * because the answer is the same shape either way, and a caller that wants a fresh
   * answer wants the same fields a stale one has.
   *
   * **This never rejects for a network failure.** A version check that can break the
   * screen it decorates is worse than no version check; what went wrong comes back in
   * `error` instead, where the person who pressed the button can read it.
   */
  'updates.status': {
    params: z.object({ force: z.boolean().default(false) }),
    result: UpdateStatus,
  },
  /**
   * Turn the periodic check on or off.
   *
   * The host holds this, not the UI, because the host is what owns the timer — a
   * preference kept on the other side of the wire from the thing it governs is one
   * that eventually stops governing it.
   */
  'updates.setAuto': {
    params: z.object({ enabled: z.boolean() }),
    result: UpdateStatus,
  },
  /**
   * Install the newer version. **Explicitly asked for — never automatic.**
   *
   * Answers as soon as the work has *started*, not when it has finished: `npm i -g`
   * routinely outruns the 30s RPC deadline, and a call that times out while the
   * install keeps going leaves the screen saying the opposite of what happened.
   * Progress arrives as `update_status` events instead.
   */
  'updates.apply': {
    params: z.object({}),
    result: UpdateStatus,
  },
  'approvals.rules': {
    params: z.object({ projectId: z.string().optional() }),
    result: z.array(
      z.object({
        id: z.number(),
        scope: ApprovalScope,
        matcher: z.string(),
        decision: z.string(),
        createdAt: z.number(),
      }),
    ),
  },
} as const

export type RpcMethodName = keyof typeof RpcMethods

/**
 * **보내는 쪽**이 갖춰야 하는 것 (`z.input`).
 *
 * 출력 타입이 아닌 이유: `.default()`가 붙은 필드는 파서가 채우므로 부르는 쪽은
 * 생략할 수 있다. 둘을 하나로 뭉뚱그리면 `files.search`의 `limit`처럼
 * "생략 가능한데 필수라고 우기는" 자리가 생긴다 — 실제로 걸렸다.
 */
export type RpcParams<M extends RpcMethodName> = z.input<(typeof RpcMethods)[M]['params']>

/** **받는 쪽**이 손에 쥐는 것 (`z.output`) — 기본값이 채워진 뒤다 */
export type RpcResult<M extends RpcMethodName> = z.output<(typeof RpcMethods)[M]['result']>
