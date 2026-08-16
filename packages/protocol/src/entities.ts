import { z } from 'zod'

/** 세션 상태 (product-spec FR-12). 긴급도는 core/session이 판정한다. */
export const SessionState = z.enum(['idle', 'working', 'waiting_approval', 'waiting_input', 'limited', 'error'])
export type SessionState = z.infer<typeof SessionState>

export const ToolName = z.enum(['claude', 'codex'])
export type ToolName = z.infer<typeof ToolName>

/** 권한 프리셋 — CLI 전역 설정을 세션 단위로 덮어쓴다 (M0 검증 완료) */
export const PermissionPreset = z.enum(['safe', 'normal', 'auto'])
export type PermissionPreset = z.infer<typeof PermissionPreset>

export const ApprovalDecision = z.enum(['allow', 'deny', 'always'])
export type ApprovalDecision = z.infer<typeof ApprovalDecision>

export const ApprovalScope = z.enum(['session', 'project'])
export type ApprovalScope = z.infer<typeof ApprovalScope>

/**
 * 승인 요청 상세. 어댑터가 도구별 원시 형식을 이 3종으로 정규화한다.
 * core/approval은 kind만 보고 배너 제자리 승인 가능 여부를 판정한다 (FR-3).
 */
export const ApprovalDetail = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('command'), command: z.string(), cwd: z.string() }),
  z.object({
    kind: z.literal('file_edit'),
    path: z.string(),
    diffPreview: z.string(),
    multi: z.boolean().default(false),
  }),
  z.object({ kind: z.literal('other'), raw: z.string() }),
])
export type ApprovalDetail = z.infer<typeof ApprovalDetail>

export const ToolSummary = z.object({
  tool: z.string(),
  /** 한 줄 요약 (명령 전문, 파일 경로 등) */
  title: z.string(),
  /** 조회성 도구는 UI에서 기본 접힘 (FR-3 접힘 정책) */
  readOnly: z.boolean().default(false),
  paths: z.array(z.string()).default([]),
})
export type ToolSummary = z.infer<typeof ToolSummary>

export const TokenUsage = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number().default(0),
  cacheCreationTokens: z.number().default(0),
  costUsd: z.number().optional(),
})
export type TokenUsage = z.infer<typeof TokenUsage>

/** 어댑터 능력 선언 — UI는 이걸 보고 기능을 활성/비활성 (architecture §6.2) */
export const AdapterCapabilities = z.object({
  approvals: z.boolean(),
  contextUsage: z.enum(['exact', 'estimate', 'none']),
  resume: z.boolean(),
  /** 도구가 자체 보관 중인 이전 세션 목록을 **공식 API로** 읽을 수 있는가 */
  listExternal: z.boolean().default(false),
  autoTitle: z.boolean(),
  attachments: z.array(z.enum(['image', 'file'])).default([]),
})
export type AdapterCapabilities = z.infer<typeof AdapterCapabilities>

export const ProtocolErrorCode = z.enum([
  'adapter_crashed',
  'tool_not_installed',
  'not_logged_in',
  'session_not_found',
  'rate_limited',
  'version_mismatch',
  'internal',
])
export type ProtocolErrorCode = z.infer<typeof ProtocolErrorCode>

export const ProtocolError = z.object({
  code: ProtocolErrorCode,
  /** 사람이 읽는 설명 — UI가 그대로 표시 가능해야 한다 */
  message: z.string(),
  retryable: z.boolean().default(false),
  data: z.unknown().optional(),
})
export type ProtocolError = z.infer<typeof ProtocolError>

/** 깃 패널 (FR-4) */
export const GitFileStatus = z.object({
  path: z.string(),
  staged: z.boolean(),
  status: z.enum(['M', 'A', 'D', 'R', 'U', '?']),
})
export type GitFileStatus = z.infer<typeof GitFileStatus>

export const GitCommit = z.object({
  sha: z.string(),
  shortSha: z.string(),
  subject: z.string(),
  author: z.string(),
  when: z.number(),
  parents: z.array(z.string()),
})
export type GitCommit = z.infer<typeof GitCommit>

export const GitBranch = z.object({
  name: z.string(),
  current: z.boolean(),
  remote: z.boolean(),
  upstream: z.string().optional(),
})
export type GitBranch = z.infer<typeof GitBranch>

export const GitDiff = z.object({ diff: z.string(), truncated: z.boolean(), binary: z.boolean() })
export type GitDiff = z.infer<typeof GitDiff>

/**
 * 첨부 (FR-13).
 * 이미지는 base64로 messages.payload에 넣지 않는다 — DB가 비대해지고 FTS가 오염된다.
 * host가 파일로 저장하고 경로만 주고받는다 (m2-plan D-1 결정).
 */
export const Attachment = z.object({
  kind: z.enum(['image', 'file']),
  /** 프로젝트 내 파일이면 상대 경로, 붙여넣은 이미지면 저장된 절대 경로 */
  path: z.string(),
  name: z.string(),
  mime: z.string().optional(),
  bytes: z.number().optional(),
})
export type Attachment = z.infer<typeof Attachment>

/**
 * 도구가 자체적으로 보관 중인 이전 세션 (Control Center 밖 — 터미널에서 만든 것 포함).
 *
 * 목록도 본문도 **각 도구의 공식 API로만** 읽는다.
 * ~/.claude/projects/**.jsonl 이나 ~/.codex/sessions/**.jsonl 을 직접 파싱하지 않는다:
 * 그 파일 포맷은 문서화된 계약이 아니라서 도구가 올라가면 소리 없이 깨진다.
 * 공식 API는 자기 버전의 저장 포맷 차이를 스스로 흡수한다.
 */
export const ExternalSession = z.object({
  externalId: z.string(),
  tool: ToolName,
  title: z.string(),
  updatedAt: z.number(),
  createdAt: z.number().nullable().default(null),
  branch: z.string().nullable().default(null),
  /** 이미 Control Center로 불러온 세션 — 같은 대화를 두 번 열지 않게 한다 */
  imported: z.boolean().default(false),
  /**
   * 이미 열려 있다면 **그 세션의 id**.
   *
   * 표시만으로는 부족하다 — 예전에는 '이미 불러옴'이라고 써 두고도 클릭은 그대로 돼서
   * 같은 대화가 목록에 둘 생겼다 (실측으로 확인). UI는 이 값이 있으면 새로 만들지 않고
   * 그 세션으로 데려간다.
   */
  importedAs: z.string().nullable().default(null),
})
export type ExternalSession = z.infer<typeof ExternalSession>
