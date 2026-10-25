import type { PermissionPreset } from '@cc/protocol'
import { asObj, jsonObject } from '../../json-value.js'

/**
 * The OpenCode configuration a session's preset adds (docs/plans/acp-adapter.md §0.7, §5.3), passed inline as
 * `OPENCODE_CONFIG_CONTENT`. Measured on 1.19.4: the inline config wins over the project's own `opencode.json` (a project
 * that allows `edit` and `bash` still asks under it), and OpenCode then asks for each edit and command through
 * `session/request_permission`. Its `edit` covers every tool that writes a file (`write`, `patch`, read in its binary).
 *
 * - `safe` asks before every change: edits and commands.
 * - `normal` and `edits` follow the person's own OpenCode settings, as Normal follows the person's policy for Codex
 *   (#382); `edits` differs only in the edits inside the folder that the adapter answers itself, so the two start the
 *   same process (`launchPreset`).
 * - `auto` leaves the settings too, and the adapter answers whatever OpenCode asks.
 */
export function presetConfig(preset: PermissionPreset): Record<string, unknown> | null {
  return preset === 'safe' ? { permission: SAFE } : null
}

const SAFE = { edit: 'ask', bash: 'ask' }

/**
 * The agents OpenCode has of its own that run tools (1.19.4, read in its binary; `compaction`, `title` and `summary` run
 * none). An agent's own `permission` is applied over the global one, so each is held to Safe by name
 */
const NATIVE_AGENTS = ['build', 'plan', 'general', 'explore']

/**
 * The environment that carries it, merged over the host's (`env`: the host's own). What the person passes the same way is
 * kept with Safe's permissions over its own, wherever OpenCode would let it win (read in its binary, 1.19.4):
 * `OPENCODE_PERMISSION` is applied over the config's `permission`, and an agent's own `permission` over both, so Safe is
 * set in all three, for the native agents and every agent their inline config names, and the default agent is `build`.
 * An agent the person defines only in a file of theirs is not seen here (§0.7).
 */
export function presetEnv(preset: PermissionPreset, env: Readonly<Record<string, string | undefined>> = {}): Record<string, string> {
  const config = presetConfig(preset)
  if (!config) return {}
  const theirs = jsonObject(env.OPENCODE_CONFIG_CONTENT ?? '')
  // Their `permission` may be one word for all (`"allow"`): the preset's keys then replace it, as asked
  const permission = { ...asObj(theirs.permission), ...SAFE }
  const agents = asObj(theirs.agent)
  const agent = Object.fromEntries(
    [...new Set([...NATIVE_AGENTS, ...Object.keys(agents)])].map((name) => {
      const own = asObj(agents[name])
      return [name, { ...own, permission: { ...asObj(own.permission), ...SAFE } }]
    }),
  )
  const out: Record<string, string> = { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...theirs, ...config, permission, agent, default_agent: 'build' }) }
  if (env.OPENCODE_PERMISSION !== undefined) out.OPENCODE_PERMISSION = JSON.stringify({ ...jsonObject(env.OPENCODE_PERMISSION), ...SAFE })
  return out
}
