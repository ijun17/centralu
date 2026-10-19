import { hubAutoOf, type CreateSessionParams, type PermissionPreset, type UiPreferences } from '@cc/protocol'
import { presetWithin } from './start-agent.js'

/**
 * The preset a session another computer starts here runs under (#1273, `CreateSessionParams.fromHub`): start_agent
 * with a machine, from the computer this one is linked to as its hub. `auto` only when the hub carries it from an
 * `auto` caller and this computer's "Allow auto from a linked computer" switch is on (`UiPreferences.hubAuto`, read at
 * each start); anything else is the preset the hub gave, `normal` at most, as before (#838, #1038).
 *
 * The hub holds this computer's token, so the switch does not stand against a hub that is not Centralu's own: it is
 * the person's say over what Centralu's start_agent carries here. A start without `fromHub` (the person's window, an
 * older hub) is not read here at all.
 */
export function presetFromHub(
  params: Pick<CreateSessionParams, 'permissionPreset' | 'fromHub'>,
  prefs: Pick<UiPreferences, 'hubAuto'>,
): PermissionPreset {
  const given = params.permissionPreset ?? 'normal'
  if (!params.fromHub) return given
  if (params.fromHub.callerPreset === 'auto' && hubAutoOf(prefs)) return 'auto'
  return presetWithin(given, 'normal') ? given : 'normal'
}

/**
 * Where a session started from a linked computer is marked (#1273, `SessionInfo.startedFromHub`): an app setting per
 * session, as `agent_depth:<id>`, so an older build leaves it alone and nothing needs a migration; the trash's purge
 * deletes it with the session (`SESSION_SETTING_OF`).
 */
export const startedFromHubKey = (sessionId: string) => `started_from_hub:${sessionId}`

/**
 * A session read back from the store (at startup, out of the trash) with its mark put back (#1273 review): the row has
 * no column for it, so every place that builds a session from its row reads the mark beside it
 */
export function withHubMark<T extends { id: string; startedFromHub?: boolean }>(settings: { appSetting(key: string): string | null }, info: T): T {
  return settings.appSetting(startedFromHubKey(info.id)) === 'true' ? { ...info, startedFromHub: true } : info
}
