import type { PermissionPreset } from '@cc/protocol'
import { asObj, isObj, jsonObject, type Obj } from '../../json-value.js'

/**
 * What the person's OpenCode reads besides Centralu's inline config (`config-files.ts` finds it): every config object
 * of theirs, in no particular order, and the names of the agents their markdown files define
 */
export type OpenCodeConfigs = { layers: Obj[]; agentFiles: string[] }

export const NO_CONFIGS: OpenCodeConfigs = { layers: [], agentFiles: [] }

/**
 * How a session's preset reaches OpenCode (docs/plans/acp-adapter.md §0.7): an inline config, `OPENCODE_CONFIG_CONTENT`,
 * merged by OpenCode after the person's global and project files, so it is read last but for a managed config.
 *
 * - `safe` asks before every edit (OpenCode's `edit` covers `write` and `patch`), command and web fetch, under every
 *   agent, and before handing work to an agent it cannot see.
 * - `normal` asks before edits and commands, as Claude and Codex do, under whatever the person's own rules say:
 *   OpenCode's own default asks nothing.
 * - `edits` starts as `normal`; the adapter allows the edits inside the folder itself (`launchPreset`).
 * - `auto` adds nothing, and the adapter answers whatever OpenCode asks.
 */
export function presetEnv(preset: PermissionPreset, env: Readonly<Record<string, string | undefined>>, configs: OpenCodeConfigs): Record<string, string> {
  if (preset === 'auto') return {}
  const theirs = jsonObject(env.OPENCODE_CONFIG_CONTENT ?? '')
  const all = [...configs.layers, theirs, ...(env.OPENCODE_PERMISSION === undefined ? [] : [{ permission: jsonObject(env.OPENCODE_PERMISSION) }])]
  return preset === 'safe' ? safeEnv(theirs, all, configs.agentFiles, env.OPENCODE_PERMISSION) : normalEnv(theirs, all)
}

/** What Normal asks before where the person decided nothing: OpenCode lets every rule of theirs win over it */
const NORMAL_ASKS = ['edit', 'bash']

/** What Safe asks before whatever the person's rules say: every change, and a fetch from the web */
const SAFE_ASKS = ['edit', 'bash', 'webfetch', 'websearch']

/** OpenCode's own agents that run tools (1.19.4; `compaction`, `title` and `summary` run none) */
const NATIVE_AGENTS = ['build', 'plan', 'general', 'explore']

function normalEnv(theirs: Obj, all: Obj[]): Record<string, string> {
  const base = NORMAL_ASKS.filter((tool) => !all.some((c) => keysOf(c.permission).some((k) => matches(tool, k)) || toolKeys(c.tools).some((k) => matches(tool, k))))
  if (base.length === 0) return {}
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...theirs, permission: { ...Object.fromEntries(base.map((t) => [t, 'ask'])), ...permissionOf(theirs.permission) } }) }
}

/**
 * OpenCode reads an agent's rules as the defaults, the config's `permission`, then the agent's own, and the last rule
 * that matches decides; within one object a key keeps the place it had in the first config that named it. So Safe's
 * rules sit under keys of their own (`bash*` for `bash`), new to every object they join and so read after the person's
 * rules there, under each agent: its own in `agent`, or in `mode` for one the person lists there, since OpenCode copies
 * `mode` over `agent` last (and an agent named there becomes primary, so no other is). After each ask comes every deny
 * of the person's for that tool, so Safe asks more and never less.
 */
function safeEnv(theirs: Obj, all: Obj[], agentFiles: string[], permissionEnv: string | undefined): Record<string, string> {
  const named = (group: 'agent' | 'mode') => all.flatMap((c) => Object.keys(asObj(c[group])))
  const modes = new Set(named('mode'))
  const held = [...new Set([...NATIVE_AGENTS, ...named('agent'), ...agentFiles, ...modes])]
  const globalRules = all.map((c) => c.permission)
  const rulesFor = (name: string) => [...globalRules, ...all.flatMap((c) => [asObj(asObj(c.agent)[name]).permission, asObj(asObj(c.mode)[name]).permission])]
  const hold = (own: unknown, rules: unknown[]) => ({ ...withoutSafeKeys(permissionOf(own)), ...safeRules(rules, held) })
  const entries = (group: 'agent' | 'mode', names: string[]) =>
    Object.fromEntries(names.map((name) => [name, { ...asObj(asObj(theirs[group])[name]), permission: hold(asObj(asObj(theirs[group])[name]).permission, rulesFor(name)) }]))
  const config = {
    ...theirs,
    permission: hold(theirs.permission, globalRules),
    agent: { ...asObj(theirs.agent), ...entries('agent', held.filter((n) => !modes.has(n))) },
    ...(modes.size ? { mode: { ...asObj(theirs.mode), ...entries('mode', [...modes]) } } : {}),
    default_agent: 'build',
  }
  const out: Record<string, string> = { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }
  if (permissionEnv !== undefined) out.OPENCODE_PERMISSION = JSON.stringify(hold(jsonObject(permissionEnv), globalRules))
  return out
}

/** Safe's rules, each under its own key: ask, then the person's denies for that tool; `task` lets the held agents run */
function safeRules(rules: unknown[], held: string[]): Obj {
  const denies = (tool: string) => Object.fromEntries(rules.flatMap((p) => denied(p, tool)).map((pattern) => [pattern, 'deny']))
  return {
    ...Object.fromEntries(SAFE_ASKS.map((tool) => [safeKey(tool), { '*': 'ask', ...denies(tool) }])),
    [safeKey('task')]: { '*': 'ask', ...Object.fromEntries(held.map((n) => [n, 'allow'])), ...denies('task') },
  }
}

const safeKey = (tool: string) => `${tool}*`
const SAFE_KEYS = new Set([...SAFE_ASKS, 'task'].map(safeKey))
const withoutSafeKeys = (p: Obj): Obj => Object.fromEntries(Object.entries(p).filter(([k]) => !SAFE_KEYS.has(k)))

/** A permission as OpenCode reads it: one word is that word for every tool */
const permissionOf = (p: unknown): Obj => (typeof p === 'string' ? { '*': p } : asObj(p))
const keysOf = (p: unknown): string[] => (p === undefined ? [] : Object.keys(permissionOf(p)))

/** The legacy `tools` switches, as the permission names OpenCode turns them into */
const toolKeys = (tools: unknown): string[] => Object.keys(asObj(tools)).map((t) => (['write', 'patch'].includes(t) ? 'edit' : t))

/** The patterns a permission denies for a tool, under any key that names it */
function denied(p: unknown, tool: string): string[] {
  return Object.entries(permissionOf(p))
    .filter(([key]) => matches(tool, key))
    .flatMap(([, v]) => (v === 'deny' ? ['*'] : isObj(v) ? Object.entries(v).filter(([, a]) => a === 'deny').map(([pattern]) => pattern) : []))
}

/** OpenCode's match of a permission name or pattern (1.19.4, `Wildcard.match`): `*` any run, `?` one character, any case */
function matches(value: string, pattern: string): boolean {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${re.endsWith(' .*') ? `${re.slice(0, -3)}( .*)?` : re}$`, 'si').test(value)
}
