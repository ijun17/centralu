/**
 * Every notification method the adapter handles or leaves out on purpose. Anything else is said once per session in
 * host.log (`UnmappedTypes`, #58). The groups follow the #58 survey (2026-10-04, codex-cli 0.160.0, 85 methods):
 *
 *   - mapped: a case below, or read in index.ts (`patchUpdated`, `serverRequest/resolved`)
 *   - ignored by #58: the git panel covers the diff, and the rest is internal detail
 *   - correctly ignored: features Centralu does not use (Codex app projects, realtime voice, client-run processes,
 *     fs/watch, fuzzy search, OAuth and login flows), the server's own bookkeeping (`thread/started`, `account/updated`),
 *     deprecated or unstable shapes, and Windows-only notices
 *
 * The methods the survey would show or store but nobody has wired yet stay out on purpose: `item/reasoning/textDelta`,
 * `item/mcpToolCall/progress`, `skills/changed` and `thread/reverted` among them. Their log line is how a real instance
 * gets noticed.
 */
export const CODEX_KNOWN_NOTIFICATIONS: ReadonlySet<string> = new Set([
  // mapped
  'error', 'thread/name/updated', 'thread/goal/updated', 'thread/goal/cleared', 'thread/tokenUsage/updated',
  'turn/started', 'turn/completed', 'turn/plan/updated', 'item/started', 'item/completed', 'item/agentMessage/delta',
  'item/commandExecution/outputDelta', 'item/fileChange/patchUpdated', 'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded', 'thread/compacted', 'account/rateLimits/updated',
  // read in index.ts: closes the approval card of a request Codex ended without our answer
  'serverRequest/resolved',
  // mapped by #290 for a child thread (CodexChildTracker); the parent's own status is still not read
  'thread/status/changed',
  // mapped by #304: notices, model switches and MCP servers that failed to start (thread/settings/updated in index.ts)
  'warning', 'configWarning', 'deprecationNotice', 'guardianWarning', 'model/rerouted', 'thread/settings/updated',
  'mcpServer/startupStatus/updated',
  // ignored by #58
  'turn/diff/updated', 'hook/started', 'hook/completed',
  'rawResponseItem/completed', 'rawResponse/completed',
  // correctly ignored
  'thread/started', 'thread/archived', 'thread/unarchived', 'thread/deleted', 'thread/closed',
  'account/updated', 'remoteControl/status/changed', 'item/fileChange/outputDelta', 'item/autoApprovalReview/started',
  'item/autoApprovalReview/completed', 'autoApprovalReview/strictReviewRequired', 'item/plan/delta',
  'thread/attachment/updated', 'thread/queue/changed', 'project/changed', 'thread/project/updated',
  'thread/environment/connected', 'thread/environment/disconnected', 'command/exec/outputDelta', 'process/outputDelta',
  'process/exited', 'fs/changed', 'fuzzyFileSearch/sessionUpdated', 'fuzzyFileSearch/sessionCompleted',
  'mcpServer/oauthLogin/completed', 'mcpServer/event/stream/notification', 'account/gatewayOAuth/changed',
  'account/login/completed', 'app/list/updated', 'externalAgentConfig/import/progress',
  'externalAgentConfig/import/completed', 'turn/moderationMetadata', 'windows/worldWritableWarning',
  'windowsSandbox/setupCompleted', 'thread/realtime/started', 'thread/realtime/itemAdded',
  'thread/realtime/item/started', 'thread/realtime/item/transcript/delta', 'thread/realtime/item/completed',
  'thread/realtime/transcript/delta', 'thread/realtime/transcript/done', 'thread/realtime/outputAudio/delta',
  'thread/realtime/sdp', 'thread/realtime/error', 'thread/realtime/closed',
])
