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
