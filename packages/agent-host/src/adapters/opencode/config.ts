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

/**
 * Normal's base, under each tool's own key (`bash*`, see `safeEnv`): ask, then every rule of the person's for that tool in
 * the order OpenCode reads them, so each of theirs still decides the calls it names (`git *`). A tool whose every call
 * a rule of theirs decides (`bash: allow`, `*`, a one-word `permission`, `tools`) gets none.
 */
function normalEnv(theirs: Obj, all: Obj[]): Record<string, string> {
  const rules = all.flatMap(rulesOf)
  const base = NORMAL_ASKS.flatMap((tool) => {
    const named = rules.flatMap((p) => Object.entries(p).filter(([key]) => matches(tool, key)).map(([, v]) => v))
    if (named.some((v) => !isObj(v) || '*' in v)) return []
    return [[ownKey(tool), { '*': 'ask', ...Object.assign({}, ...named) }]]
  })
  if (base.length === 0) return {}
  return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...theirs, permission: { ...withoutOwnKeys(permissionOf(theirs.permission)), ...Object.fromEntries(base) } }) }
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
  const globalRules = all.flatMap(rulesOf)
  const rulesFor = (name: string) => [...globalRules, ...all.flatMap((c) => [...rulesOf(asObj(asObj(c.agent)[name])), ...rulesOf(asObj(asObj(c.mode)[name]))])]
  const hold = (own: unknown, rules: Obj[]) => ({ ...withoutOwnKeys(permissionOf(own)), ...safeRules(rules, held) })
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

/**
 * Safe's rules, each under its own key: ask, then the person's denies for that tool; `task` lets the held agents run,
 * unless the person denies every `task`
 */
function safeRules(rules: Obj[], held: string[]): Obj {
  const denies = (tool: string) => Object.fromEntries(rules.flatMap((p) => denied(p, tool)).map((pattern) => [pattern, 'deny']))
  const taskDenies = denies('task')
  return {
    ...Object.fromEntries(SAFE_ASKS.map((tool) => [ownKey(tool), { '*': 'ask', ...denies(tool) }])),
    [ownKey('task')]: { '*': 'ask', ...('*' in taskDenies ? {} : Object.fromEntries(held.map((n) => [n, 'allow']))), ...taskDenies },
  }
}

/** Centralu's key for a tool's rules: new to every permission object it joins (`safeEnv`) */
const ownKey = (tool: string) => `${tool}*`
const OWN_KEYS = new Set([...SAFE_ASKS, 'task'].map(ownKey))
const withoutOwnKeys = (p: Obj): Obj => Object.fromEntries(Object.entries(p).filter(([k]) => !OWN_KEYS.has(k)))

/** A permission as OpenCode reads it: one word is that word for every tool */
const permissionOf = (p: unknown): Obj => (typeof p === 'string' ? { '*': p } : asObj(p))

/**
 * A config's (or an agent's) rules as OpenCode reads them, in its order: the legacy `tools` switches (`false` a deny,
 * `write` and `patch` under `edit`), then `permission`
 */
function rulesOf(c: Obj): Obj[] {
  const tools = Object.entries(asObj(c.tools)).map(([t, on]) => [['write', 'patch'].includes(t) ? 'edit' : t, on ? 'allow' : 'deny'])
  return [...(tools.length ? [Object.fromEntries(tools)] : []), ...(c.permission === undefined ? [] : [permissionOf(c.permission)])]
}

/** The patterns a permission denies for a tool, under any key that names it */
function denied(p: Obj, tool: string): string[] {
  return Object.entries(p)
    .filter(([key]) => matches(tool, key))
    .flatMap(([, v]) => (v === 'deny' ? ['*'] : isObj(v) ? Object.entries(v).filter(([, a]) => a === 'deny').map(([pattern]) => pattern) : []))
}

/** OpenCode's match of a permission name or pattern (1.19.4, `Wildcard.match`): `*` any run, `?` one character, any case */
function matches(value: string, pattern: string): boolean {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${re.endsWith(' .*') ? `${re.slice(0, -3)}( .*)?` : re}$`, 'si').test(value)
}
