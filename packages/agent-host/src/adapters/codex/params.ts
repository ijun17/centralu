import { asObj } from '../../json-value.js'
import type { AccountRateLimitsUpdatedNotification } from './generated/v2/AccountRateLimitsUpdatedNotification.js'
import type { AgentMessageDeltaNotification } from './generated/v2/AgentMessageDeltaNotification.js'
import type { CommandExecutionOutputDeltaNotification } from './generated/v2/CommandExecutionOutputDeltaNotification.js'
import type { ConfigWarningNotification } from './generated/v2/ConfigWarningNotification.js'
import type { ContextCompactedNotification } from './generated/v2/ContextCompactedNotification.js'
import type { DeprecationNoticeNotification } from './generated/v2/DeprecationNoticeNotification.js'
import type { ErrorNotification } from './generated/v2/ErrorNotification.js'
import type { GuardianWarningNotification } from './generated/v2/GuardianWarningNotification.js'
import type { ItemCompletedNotification } from './generated/v2/ItemCompletedNotification.js'
import type { ItemStartedNotification } from './generated/v2/ItemStartedNotification.js'
import type { McpServerStatusUpdatedNotification } from './generated/v2/McpServerStatusUpdatedNotification.js'
import type { ModelReroutedNotification } from './generated/v2/ModelReroutedNotification.js'
import type { ReasoningSummaryPartAddedNotification } from './generated/v2/ReasoningSummaryPartAddedNotification.js'
import type { ReasoningSummaryTextDeltaNotification } from './generated/v2/ReasoningSummaryTextDeltaNotification.js'
import type { ThreadGoalClearedNotification } from './generated/v2/ThreadGoalClearedNotification.js'
import type { ThreadGoalUpdatedNotification } from './generated/v2/ThreadGoalUpdatedNotification.js'
import type { ThreadNameUpdatedNotification } from './generated/v2/ThreadNameUpdatedNotification.js'
import type { ThreadTokenUsageUpdatedNotification } from './generated/v2/ThreadTokenUsageUpdatedNotification.js'
import type { TurnCompletedNotification } from './generated/v2/TurnCompletedNotification.js'
import type { TurnPlanUpdatedNotification } from './generated/v2/TurnPlanUpdatedNotification.js'
import type { TurnStartedNotification } from './generated/v2/TurnStartedNotification.js'
import type { WarningNotification } from './generated/v2/WarningNotification.js'
import type { CommandExecutionRequestApprovalParams } from './generated/v2/CommandExecutionRequestApprovalParams.js'
import type { FileChangePatchUpdatedNotification } from './generated/v2/FileChangePatchUpdatedNotification.js'
import type { FileChangeRequestApprovalParams } from './generated/v2/FileChangeRequestApprovalParams.js'
import type { McpServerElicitationRequestParams } from './generated/v2/McpServerElicitationRequestParams.js'
import type { ThreadSettingsUpdatedNotification } from './generated/v2/ThreadSettingsUpdatedNotification.js'

/**
 * The params of each notification and server request the adapter reads, as Codex's generated types name them (#1339): the types the
 * adapter is compiled against (codex-bindings.mjs writes them into generated/). A field the adapter reads that Codex
 * renames or drops then fails the build where it is read.
 */
export type NotificationParams = {
  'item/agentMessage/delta': AgentMessageDeltaNotification
  'item/reasoning/summaryTextDelta': ReasoningSummaryTextDeltaNotification
  'item/reasoning/summaryPartAdded': ReasoningSummaryPartAddedNotification
  'turn/plan/updated': TurnPlanUpdatedNotification
  'item/commandExecution/outputDelta': CommandExecutionOutputDeltaNotification
  'item/started': ItemStartedNotification
  'item/completed': ItemCompletedNotification
  'turn/completed': TurnCompletedNotification
  'turn/started': TurnStartedNotification
  'thread/tokenUsage/updated': ThreadTokenUsageUpdatedNotification
  'account/rateLimits/updated': AccountRateLimitsUpdatedNotification
  'thread/name/updated': ThreadNameUpdatedNotification
  'thread/compacted': ContextCompactedNotification
  'thread/goal/updated': ThreadGoalUpdatedNotification
  'thread/goal/cleared': ThreadGoalClearedNotification
  'warning': WarningNotification
  'configWarning': ConfigWarningNotification
  'deprecationNotice': DeprecationNoticeNotification
  'guardianWarning': GuardianWarningNotification
  'model/rerouted': ModelReroutedNotification
  'mcpServer/startupStatus/updated': McpServerStatusUpdatedNotification
  'error': ErrorNotification
  'item/fileChange/patchUpdated': FileChangePatchUpdatedNotification
  'thread/settings/updated': ThreadSettingsUpdatedNotification
  'item/commandExecution/requestApproval': CommandExecutionRequestApprovalParams
  'item/fileChange/requestApproval': FileChangeRequestApprovalParams
  'mcpServer/elicitation/request': McpServerElicitationRequestParams
}

/** `T`'s fields by Codex's names, each read as `unknown`: the names are checked at build, the values as they are read */
export type Loose<T> = { readonly [K in keyof T]?: unknown }

/**
 * A notification's params, typed by its method. The app-server is another process, maybe another version than the
 * types describe, so every value is still checked where it is read (`str`, `asObj`, `finite`); what this adds is that
 * only a field Codex has can be read.
 */
export const paramsOf = <M extends keyof NotificationParams>(n: { params?: unknown }, _method: M): Loose<NotificationParams[M]> => asObj(n.params)
