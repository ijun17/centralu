import type { LaunchDemands, PermissionPreset, SessionInfo } from '@cc/protocol'
import type { CreateSessionOpts } from '../adapters/contract.js'
import { rpcError } from '../rpc-error.js'

/**
 * What a session asks of its tool (`launchRefusal`'s demands), as its next launch will: its preset, the setting files its
 * kind gets (`LaunchInputs.settingFilesFor`), and whether it carries role text (the orchestrator's, or a coordinator's or
 * builder's fixed `roleAppend`). The one reading of a session for every path that puts a tool and a preset on it: a
 * start or wake (from the launch options themselves, `startFit`), a tool switch, a preset change (#1562 review).
 */
export function sessionDemands(
  m: Pick<SessionInfo, 'kind' | 'roleAppend' | 'permissionPreset'>,
  files: Pick<CreateSessionOpts, 'projectTrusted' | 'noSettingFiles'>,
  preset: PermissionPreset = m.permissionPreset,
): LaunchDemands {
  return {
    permissionPreset: preset,
    ...(files.projectTrusted === undefined ? {} : { projectTrusted: files.projectTrusted }),
    ...(files.noSettingFiles ? { noSettingFiles: true } : {}),
    roleText: m.kind === 'orchestrator' || !!m.roleAppend,
  }
}

/** The error a refused tool is answered with, wherever it was asked (`tool_unfit`; not worth retrying) */
export function unfitError(reason: string): Error {
  return rpcError(reason, 'refused', { retryable: false, data: { reason: 'tool_unfit' } })
}
