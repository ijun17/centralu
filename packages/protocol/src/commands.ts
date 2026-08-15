import { z } from 'zod'
import {
  AdapterCapabilities,
  ApprovalDecision,
  ApprovalScope,
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
})
export type SessionInfo = z.infer<typeof SessionInfo>

export const ProjectInfo = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  defaultTool: ToolName.default('claude'),
  defaultModel: z.string().optional(),
  git: z
    .object({ branch: z.string(), changedFiles: z.number(), isRepo: z.boolean() })
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
    params: z.object({ sessionId: z.string(), text: z.string() }),
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
  'agents.archiveSession': {
    params: z.object({ sessionId: z.string() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'agents.resumeSession': {
    params: z.object({ sessionId: z.string() }),
    result: z.object({ session: SessionInfo, resumed: z.boolean(), reason: z.string().optional() }),
  },
  'agents.capabilities': { params: z.object({ tool: ToolName }), result: AdapterCapabilities },
  'agents.detect': {
    params: z.object({}),
    result: z.array(z.object({ tool: ToolName, installed: z.boolean(), loggedIn: z.boolean(), detail: z.string() })),
  },
  'workspace.save': {
    params: z.object({ layout: z.record(z.string(), z.unknown()) }),
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
    result: z.array(z.object({ scope: ApprovalScope, matcher: z.string(), decision: z.string() })),
  },
} as const

export type RpcMethodName = keyof typeof RpcMethods
export type RpcParams<M extends RpcMethodName> = z.infer<(typeof RpcMethods)[M]['params']>
export type RpcResult<M extends RpcMethodName> = z.infer<(typeof RpcMethods)[M]['result']>
