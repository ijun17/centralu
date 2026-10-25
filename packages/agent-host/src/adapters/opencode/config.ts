import type { PermissionPreset } from '@cc/protocol'
import { asObj, jsonObject } from '../../json-value.js'

/**
 * The OpenCode configuration a session's preset adds (docs/plans/acp-adapter.md §5.3), passed inline as
 * `OPENCODE_CONFIG_CONTENT`. Measured on 1.19.4: the inline config wins over the project's own `opencode.json` (a project
 * that allows `edit` and `bash` still asks under it), and OpenCode then asks for each edit and command through
 * `session/request_permission`.
 *
 * - `safe` asks before every change: edits and commands.
 * - `normal` and `edits` follow the person's own OpenCode settings, as Normal follows the person's policy for Codex
 *   (#382); `edits` differs only in the edits inside the folder that the adapter answers itself, so the two start the
 *   same process (`launchPreset`).
 * - `auto` leaves the settings too, and the adapter answers whatever OpenCode asks.
 */
export function presetConfig(preset: PermissionPreset): Record<string, unknown> | null {
  return preset === 'safe' ? { permission: { edit: 'ask', bash: 'ask' } } : null
}

/**
 * The environment that carries it, merged over the host's. A config the person passes the same way (`current`, their own
 * `OPENCODE_CONFIG_CONTENT`) is kept, with the preset's permissions over its own.
 */
export function presetEnv(preset: PermissionPreset, current?: string): Record<string, string> {
  const config = presetConfig(preset)
  if (!config) return {}
  const theirs = jsonObject(current ?? '')
  // Their `permission` may be one word for all (`"allow"`): the preset's keys then replace it, as asked
  const permission = { ...asObj(theirs.permission), ...asObj(config.permission) }
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...theirs, ...config, permission }) }
}

