import { z } from 'zod'

/**
 * The ACP frames this adapter reads, parsed at the boundary (agent-host.md §2: nothing of a tool's shape leaves
 * `adapters/acp/`). Only the fields read are named; the rest pass through untouched (`looseObject`), since the agent
 * is another program at another version. Shapes from protocol version 1 as measured on Cursor 2026.10.22 and
 * OpenCode 1.19.4 (docs/plans/acp-adapter.md §1.1).
 */

const nullish = <T extends z.ZodType>(t: T) => t.nullish().transform((v) => v ?? undefined)

export const InitializeResult = z.looseObject({
  protocolVersion: z.number(),
  agentCapabilities: nullish(
    z.looseObject({
      loadSession: nullish(z.boolean()),
      promptCapabilities: nullish(z.looseObject({ image: nullish(z.boolean()) })),
      sessionCapabilities: nullish(
        z.looseObject({ resume: z.unknown().optional(), list: z.unknown().optional(), close: z.unknown().optional() }),
      ),
    }),
  ),
  agentInfo: nullish(z.looseObject({ name: nullish(z.string()), version: nullish(z.string()) })),
})
export type InitializeResult = z.infer<typeof InitializeResult>

const SelectOption = z.looseObject({ value: z.string(), name: nullish(z.string()) })
export const ConfigOption = z.looseObject({
  id: z.string(),
  category: nullish(z.string()),
  type: nullish(z.string()),
  currentValue: z.unknown().optional(),
  options: nullish(z.array(z.union([SelectOption, z.looseObject({ options: z.array(SelectOption) })]))),
})
export type ConfigOption = z.infer<typeof ConfigOption>

export const OpenedSession = z.looseObject({
  sessionId: nullish(z.string()),
  configOptions: nullish(z.array(ConfigOption)),
})
export type OpenedSession = z.infer<typeof OpenedSession>

export const StopReason = z.enum(['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'])
export type StopReason = z.infer<typeof StopReason>

export const PromptResult = z.looseObject({
  stopReason: z.union([StopReason, z.string()]),
  usage: nullish(
    z.looseObject({
      inputTokens: nullish(z.number()),
      outputTokens: nullish(z.number()),
      cachedReadTokens: nullish(z.number()),
      cachedWriteTokens: nullish(z.number()),
      thoughtTokens: nullish(z.number()),
    }),
  ),
})
export type PromptResult = z.infer<typeof PromptResult>

export const ContentBlock = z.looseObject({
  type: z.string(),
  text: nullish(z.string()),
  data: nullish(z.string()),
  mimeType: nullish(z.string()),
})
export type ContentBlock = z.infer<typeof ContentBlock>

const ToolCallContent = z.looseObject({
  type: z.string(),
  content: nullish(ContentBlock),
  path: nullish(z.string()),
  oldText: nullish(z.string()),
  newText: nullish(z.string()),
})
export type ToolCallContent = z.infer<typeof ToolCallContent>

export const ToolStatus = z.enum(['pending', 'in_progress', 'completed', 'failed'])
export type ToolStatus = z.infer<typeof ToolStatus>

/** `tool_call` and `tool_call_update` share one shape: an upsert by id, every field but the id optional on an update */
export const ToolCallFields = z.looseObject({
  toolCallId: z.string(),
  title: nullish(z.string()),
  kind: nullish(z.string()),
  status: nullish(z.union([ToolStatus, z.string()])),
  rawInput: z.unknown().optional(),
  rawOutput: z.unknown().optional(),
  content: nullish(z.array(ToolCallContent)),
  locations: nullish(z.array(z.looseObject({ path: z.string() }))),
})
export type ToolCallFields = z.infer<typeof ToolCallFields>

const Chunk = z.looseObject({ content: ContentBlock, messageId: nullish(z.string()) })

/** What `session/update` carries, by `sessionUpdate`. An unknown kind parses as `other`, logged once (`unmapped.ts`) */
export const SessionUpdate = z.discriminatedUnion('sessionUpdate', [
  Chunk.extend({ sessionUpdate: z.literal('agent_message_chunk') }),
  Chunk.extend({ sessionUpdate: z.literal('agent_thought_chunk') }),
  Chunk.extend({ sessionUpdate: z.literal('user_message_chunk') }),
  ToolCallFields.extend({ sessionUpdate: z.literal('tool_call') }),
  ToolCallFields.extend({ sessionUpdate: z.literal('tool_call_update') }),
  z.looseObject({
    sessionUpdate: z.literal('plan'),
    entries: z.array(z.looseObject({ content: z.string(), status: z.string(), priority: nullish(z.string()) })),
  }),
  z.looseObject({
    sessionUpdate: z.literal('available_commands_update'),
    availableCommands: z.array(
      z.looseObject({ name: z.string(), description: nullish(z.string()), input: nullish(z.looseObject({ hint: nullish(z.string()) })) }),
    ),
  }),
  z.looseObject({ sessionUpdate: z.literal('session_info_update'), title: nullish(z.string()) }),
  z.looseObject({ sessionUpdate: z.literal('usage_update'), used: z.number(), size: z.number() }),
  z.looseObject({ sessionUpdate: z.literal('current_mode_update'), currentModeId: z.string() }),
  z.looseObject({ sessionUpdate: z.literal('config_option_update'), configOptions: z.array(ConfigOption) }),
  z.looseObject({
    sessionUpdate: z.literal('compaction_update'),
    compactionId: z.string(),
    status: z.string(),
    summary: nullish(z.array(ContentBlock)),
    error: nullish(z.string()),
  }),
  z.looseObject({ sessionUpdate: z.literal('compaction_summary_chunk'), compactionId: z.string(), content: ContentBlock }),
  z.looseObject({ sessionUpdate: z.literal('notice'), severity: z.string(), title: z.string(), description: nullish(z.string()) }),
])
export type SessionUpdate = z.infer<typeof SessionUpdate>
export type SessionUpdateKind = SessionUpdate['sessionUpdate']

export const SessionNotification = z.looseObject({ sessionId: z.string(), update: z.looseObject({ sessionUpdate: z.string() }) })

/** One `session/update`, read: a known kind, or `other` with its name so it is logged and dropped */
export type ReadUpdate = { sessionId: string; update: SessionUpdate } | { sessionId: string; other: string } | null

export function readUpdate(params: unknown): ReadUpdate {
  const n = SessionNotification.safeParse(params)
  if (!n.success) return null
  const u = SessionUpdate.safeParse(n.data.update)
  return u.success ? { sessionId: n.data.sessionId, update: u.data } : { sessionId: n.data.sessionId, other: n.data.update.sessionUpdate }
}

export const PermissionOptionKind = z.enum(['allow_once', 'allow_always', 'reject_once', 'reject_always'])
export type PermissionOptionKind = z.infer<typeof PermissionOptionKind>

export const PermissionOption = z.looseObject({ optionId: z.string(), kind: z.union([PermissionOptionKind, z.string()]), name: nullish(z.string()) })
export type PermissionOption = z.infer<typeof PermissionOption>

export const RequestPermission = z.looseObject({
  sessionId: z.string(),
  toolCall: ToolCallFields,
  options: z.array(PermissionOption),
})
export type RequestPermission = z.infer<typeof RequestPermission>

/** What `session/request_permission` is answered with */
export type PermissionOutcome = { outcome: { outcome: 'selected'; optionId: string } | { outcome: 'cancelled' } }

/** The text of a content block, or empty for one that carries none (an image, a resource link) */
export function blockText(block: ContentBlock | undefined): string {
  return block?.type === 'text' ? (block.text ?? '') : ''
}
