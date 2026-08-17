import { z } from 'zod'
import {
  AdapterCapabilities,
  ApprovalDecision,
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
  SessionState,
  ToolName,
} from './entities.js'

/** UI → host RPC. 포트 인터페이스(platform/ports)와 1:1 대응 (docs/protocol.md §3) */

export const CreateSessionParams = z.object({
  projectId: z.string(),
  cwd: z.string(),
  tool: ToolName,
  model: z.string().optional(),
  effort: z.string().optional(),
  permissionPreset: PermissionPreset.default('normal'),
  initialPrompt: z.string().optional(),
  resumeExternalId: z.string().optional(),
  /** 재개할 때 이전 대화도 화면에 복원한다 (resumeExternalId와 함께 쓴다) */
  importHistory: z.boolean().optional(),
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
  permissionPreset: PermissionPreset.optional(),
})
export type UpdateSettingsParams = z.infer<typeof UpdateSettingsParams>

export const SessionInfo = z.object({
  id: z.string(),
  /**
   * 소속 프로젝트. **오케스트레이터만 null이다** — 앱에 하나뿐이고 프로젝트를 가로지른다.
   * 프로젝트에 매달면 그 프로젝트를 지울 때 함께 죽는다.
   */
  projectId: z.string().nullable(),
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
  permissionPreset: PermissionPreset.default('normal'),
  /**
   * 이어받은 이전 대화의 식별자 (불러오기로 만든 세션만).
   * externalId와 다를 수 있다 — 도구가 resume하면서 새 식별자를 발급하기 때문이다.
   */
  importedFrom: z.string().nullable().default(null),
})
export type SessionInfo = z.infer<typeof SessionInfo>

export const ProjectInfo = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  defaultTool: ToolName.default('claude'),
  defaultModel: z.string().optional(),
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
  kind: z.enum(['text', 'tool_call', 'tool_result', 'approval', 'marker']),
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
    params: z.object({ sessionId: z.string() }),
    result: z.object({ ok: z.literal(true) }),
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
    result: z.object({ session: SessionInfo, resumed: z.boolean(), reason: z.string().optional() }),
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
  'fs.readFile': {
    params: z.object({ projectId: z.string(), path: z.string() }),
    result: z.object({ text: z.string(), truncated: z.boolean(), binary: z.boolean(), bytes: z.number() }),
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
  'sessions.reorder': {
    params: z.object({ projectId: z.string(), orderedIds: z.array(z.string()) }),
    result: z.array(SessionInfo),
  },
  /**
   * 컨트롤 센터에 올려둔 세션들 (순서 포함).
   *
   * 자동 흐름 그리드라 배치가 곧 순서 하나다. 그래서 **추가·제거·순서 바꾸기가
   * 전부 이 한 가지**로 표현된다 — "목록을 이렇게 만들어라".
   */
  'controlCenter.get': { params: z.object({}), result: z.array(z.string()) },
  'controlCenter.set': {
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
