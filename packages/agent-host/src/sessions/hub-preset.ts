import { hubAutoOf, type CreateSessionParams, type PermissionPreset, type UiPreferences } from '@cc/protocol'
import { presetWithin } from './start-agent.js'

/**
 * The preset a session another computer starts here runs under (#1273, `CreateSessionParams.fromHub`): start_agent
 * with a machine, from the computer this one is linked to as its hub. `auto` only when the hub carries it from an
 * `auto` caller, this computer's "Allow auto from a linked computer" switch is on (`UiPreferences.hubAuto`, read at
 * each start) and the project here is trusted (an untrusted project stays `normal` at most, owner decision 2026-11-05);
 * anything else is the preset the hub gave, `normal` at most, as before (#838, #1038).
 *
 * The hub holds this computer's token, so the switch does not stand against a hub that is not Centralu's own: it is
 * the person's say over what Centralu's start_agent carries here. A start without `fromHub` (the person's window, an
 * older hub) is not read here at all.
 */
export function presetFromHub(
  params: Pick<CreateSessionParams, 'permissionPreset' | 'fromHub'>,
  prefs: Pick<UiPreferences, 'hubAuto'>,
  projectTrusted: boolean,
): PermissionPreset {
  const given = params.permissionPreset ?? 'normal'
  if (!params.fromHub) return given
  if (params.fromHub.callerPreset === 'auto' && hubAutoOf(prefs) && projectTrusted) return 'auto'
  return presetWithin(given, 'normal') ? given : 'normal'
}

/**
 * Where a session started from a linked computer is marked (#1273, `SessionInfo.startedFromHub`): an app setting per
 * session, as `agent_depth:<id>`, so an older build leaves it alone and nothing needs a migration; the session archive's purge
 * deletes it with the session (`SESSION_SETTING_OF`).
 */
export const startedFromHubKey = (sessionId: string) => `started_from_hub:${sessionId}`

/**
 * Which hub started a session here (#2067): the hub whose connection created it with `fromHub`, by its id and the name
 * it gave, as JSON. A key of its own beside `started_from_hub:` (add first, remove later): an older build reads only that
 * one, and the purge deletes both with the session. A session started by a build from before it has none
 */
export const startedByHubKey = (sessionId: string) => `started_from_hub_by:${sessionId}`

/** Records the hub that started a session here (`startedByHubKey`): at its creation, or when that hub offers after it (`LinkedHubs.awaitOffer`) */
export function recordStartingHub(settings: { setAppSetting(key: string, value: string): void }, sessionId: string, hub: { id: string; name: string }): void {
  settings.setAppSetting(startedByHubKey(sessionId), JSON.stringify({ id: hub.id, name: hub.name }))
}

/** The hub that started a session here (`startedByHubKey`), or null when none was recorded or the record does not read as one */
export function startingHub(settings: { appSetting(key: string): string | null }, sessionId: string): { id: string; name: string } | null {
  const raw = settings.appSetting(startedByHubKey(sessionId))
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (typeof v !== 'object' || v === null) return null
    const id: unknown = Reflect.get(v, 'id')
    const name: unknown = Reflect.get(v, 'name')
    return typeof id === 'string' && id && typeof name === 'string' ? { id, name } : null
  } catch {
    return null
  }
}

/**
 * A session read back from the store (at startup, out of the session archive) with its mark put back (#1273 review): the row has
 * no column for it, so every place that builds a session from its row reads the mark beside it
 */
export function withHubMark<T extends { id: string; startedFromHub?: boolean }>(settings: { appSetting(key: string): string | null }, info: T): T {
  return settings.appSetting(startedFromHubKey(info.id)) === 'true' ? { ...info, startedFromHub: true } : info
}
