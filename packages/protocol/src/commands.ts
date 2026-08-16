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
  GitFileStatus,
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
  permissionPreset: PermissionPreset.default('normal'),
  initialPrompt: z.string().optional(),
  resumeExternalId: z.string().optional(),
  /** 재개할 때 이전 대화도 화면에 복원한다 (resumeExternalId와 함께 쓴다) */
  importHistory: z.boolean().optional(),
})
export type CreateSessionParams = z.infer<typeof CreateSessionParams>

export const SessionInfo = z.object({
  id: z.string(),
  projectId: z.string(),
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
    params: z.object({
      sessionId: z.string(),
      model: z.string().nullable().optional(),
      permissionPreset: PermissionPreset.optional(),
    }),
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
export type RpcParams<M extends RpcMethodName> = z.infer<(typeof RpcMethods)[M]['params']>
export type RpcResult<M extends RpcMethodName> = z.infer<(typeof RpcMethods)[M]['result']>
