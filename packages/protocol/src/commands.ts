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
 * `projectId === null`이 곧 오케스트레이터라는 판정이 여섯 군데에 흩어져 있었다 —
 * 프로젝트 오케스트레이터(프로젝트가 **있는** 오케스트레이터)가 생기는 순간 그 여섯
 * 군데가 서로 다른 답을 내기 시작하므로, 판정을 명시적 표식 하나로 모은다.
 * 계급: 중앙(projectId=null) > 프로젝트(projectId=P) > 워커.
 */
export const SessionKind = z.enum(['worker', 'orchestrator'])
export type SessionKind = z.infer<typeof SessionKind>

export const SessionInfo = z.object({
  id: z.string(),
  /**
   * 소속 프로젝트. **중앙 오케스트레이터만 null이다** — 프로젝트를 가로지르는 세션이라
   * 어디에도 매달지 않는다 (매달면 그 프로젝트를 지울 때 함께 죽는다).
   * 프로젝트 오케스트레이터(#13)는 프로젝트가 있다 — 역할은 kind가 말한다.
   */
  projectId: z.string().nullable(),
  /** 워커인가 오케스트레이터인가. 기본은 워커 — 옛 프레임에는 이 필드가 없다 */
  kind: SessionKind.default('worker'),
  tool: ToolName,
  externalId: z.string().nullable(),
  name: z.string(),
  autoNamed: z.boolean(),
  state: SessionState,
  archived: z.boolean().default(false),
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
  worktree: z.object({ path: z.string(), branch: z.string() }).nullable().default(null),
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
  'pendingApproval' | 'pendingQuestions' | 'activity' | 'limit' | 'usage' | 'context'
> {
  return { pendingApproval: null, pendingQuestions: [], activity: null, limit: null, usage: null, context: null }
}

export const ProjectInfo = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  defaultTool: ToolName.default('claude'),
  defaultModel: z.string().optional(),
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
   * 목록에서 숨긴다(=아카이브). 삭제와 달리 **기록은 남는다** — 되돌릴 수 있다.
   * archived:false면 다시 꺼낸다.
   */
  'agents.archiveSession': {
    params: z.object({ sessionId: z.string(), archived: z.boolean().default(true) }),
    result: z.object({ ok: z.literal(true) }),
  },
  /** 세션을 완전히 지운다 — 아카이브와 달리 대화 기록·첨부까지 사라진다 */
  'agents.deleteSession': {
    params: z.object({
      sessionId: z.string(),
      /**
       * 워크트리 세션일 때만 의미가 있다. **기본은 남기는 것이다** —
       * 에이전트가 몇 시간 작업한 결과가 거기 있을 수 있고, 조용히 지우면 되돌릴 길이 없다.
       * UI가 `agents.worktreeStatus`로 먼저 묻고, 사람이 정한 답을 여기로 보낸다.
       */
      deleteWorktree: z.boolean().default(false),
    }),
    result: z.object({ ok: z.literal(true) }),
  },
  /**
   * 워크트리를 지워도 되는지 판단할 재료. 지우기 직전에 UI가 묻는다.
   * `null`이면 워크트리 세션이 아니다 — 물어볼 것도 없다.
   */
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
   * 오케스트레이터 도구 — **별도 프로세스(다리)가 host로 돌아오는 길**.
   *
   * Claude는 인프로세스로 붙어서 이 문이 필요 없다. Codex는 스레드별 config로
   * stdio 서버만 물릴 수 있어서(HTTP는 실측에서 안 붙었다) 다리가 필요하고,
   * 다리는 판단을 하지 않는다 — 이름과 인자만 넘기고 규칙은 전부 host에 남는다.
   */
  'orchestrator.tools': {
    params: z.object({}),
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
  /**
   * 세션을 오케스트레이터로 승격하거나 워커로 되돌린다 (#13).
   *
   * **다음에 깰 때 적용된다** — 도구·역할 프롬프트는 프로세스를 띄울 때 주입되므로,
   * 살아 있는 세션은 표식만 먼저 바뀐다. 그 자리에서 재시작하지 않는 이유:
   * 승격하는 세션은 대개 한창 일하던 세션이고, 재시작은 진행 중인 턴을 죽인다.
   * 중앙 오케스트레이터(projectId=null)는 이 문으로 못 바꾼다.
   */
  'sessions.setKind': {
    params: z.object({ sessionId: z.string(), kind: SessionKind }),
    result: SessionInfo,
  },
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
