import type { PermissionPreset } from '@cc/protocol'
import { asObj, isObj, jsonObject, type Obj } from '../../json-value.js'

/**
 * What the person's OpenCode reads besides Centralu's inline config (`config-files.ts` finds it): every config object
 * of theirs, in the order OpenCode reads them, and the names of the agents their markdown files define
 */
export type OpenCodeConfigs = { layers: Obj[]; agentFiles: string[] }

export const NO_CONFIGS: OpenCodeConfigs = { layers: [], agentFiles: [] }

/**
 * How a session's preset reaches OpenCode (docs/plans/acp-adapter.md §0.7): an inline config, `OPENCODE_CONFIG_CONTENT`,
 * merged by OpenCode after the person's global and project files, so it is read last but for a managed config.
 *
 * - `safe` asks before every edit (OpenCode's `edit` covers `write` and `patch`), command and web fetch, and before
 *   handing work to an agent it cannot see.
 * - `normal` asks before edits and commands, as Claude and Codex do, under whatever the person's own rules say:
 *   OpenCode's own default asks nothing.
 * - `edits` starts as `normal`; the adapter allows the edits inside the folder itself (`launchPreset`).
 * - `auto` adds nothing, and the adapter answers whatever OpenCode asks.
 *
 * Only the agent Centralu runs can ask: OpenCode 1.19.4 drops an ask from a subagent's session (one `task` started)
 * without a word over ACP, since its ACP side knows only the sessions it opened, and the subagent then waits on it until
 * the turn is stopped (#1565 Mac re-check, case E). So under `safe` and `normal`, what would ask under any other agent
 * is denied: the subagent is told so and its turn ends, and the agent Centralu runs, which can ask, may try itself.
 */
export function presetEnv(preset: PermissionPreset, env: Readonly<Record<string, string | undefined>>, configs: OpenCodeConfigs): Record<string, string> {
  if (preset === 'auto') return {}
  const theirs = jsonObject(env.OPENCODE_CONFIG_CONTENT ?? '')
  const all = [...configs.layers, theirs, ...(env.OPENCODE_PERMISSION === undefined ? [] : [{ permission: jsonObject(env.OPENCODE_PERMISSION) }])]
  return holdEnv(preset === 'safe' ? 'safe' : 'normal', theirs, all, configs.agentFiles, env.OPENCODE_PERMISSION)
}

/** What Normal asks before where the person decided nothing: OpenCode lets every rule of theirs win over it */
const NORMAL_ASKS = ['edit', 'bash']

/** What Safe asks before whatever the person's rules say: every change, and a fetch from the web */
const SAFE_ASKS = ['edit', 'bash', 'webfetch', 'websearch']

/** OpenCode's own agents that run tools (1.19.4; `compaction`, `title` and `summary` run none) */
const NATIVE_AGENTS = ['build', 'plan', 'general', 'explore']

/**
 * What OpenCode 1.19.4 itself asks before under every agent (`Agent.state`, read in its binary), besides a folder
 * outside the project (`external_directory`, whose allowed folders are its own): a `.env` file read, and a loop
 */
const DEFAULT_ASKS: Record<string, Rules> = {
  read: [['*', 'allow'], ['*.env', 'ask'], ['*.env.*', 'ask'], ['*.env.example', 'allow']],
  doom_loop: [['*', 'ask']],
}

type Hold = 'safe' | 'normal'

/** A tool's rules as OpenCode reads them, in order, the last that matches deciding: pattern, then allow, ask or deny */
type Rules = Array<[string, string]>

/**
 * OpenCode reads an agent's rules as the defaults, the config's `permission`, then the agent's own, and the last rule
 * that matches decides; within one object a key keeps the place it had in the first config that named it. So Centralu's
 * rules sit under keys of their own (`BASH` for `bash`), new to every object they join and so read after the person's
 * rules there: in the config's `permission` (for an agent Centralu cannot see), and under each agent, its own in
 * `agent`, or in `mode` for one the person lists there, since OpenCode copies `mode` over `agent` last (and an agent
 * named there becomes primary, so no other is). The agent Centralu runs gets the preset's asks; every other only runs
 * as a subagent, where an ask is never answered, so each ask there is a deny.
 */
function holdEnv(hold: Hold, theirs: Obj, all: Obj[], agentFiles: string[], permissionEnv: string | undefined): Record<string, string> {
  const named = (group: 'agent' | 'mode') => all.flatMap((c) => Object.keys(asObj(c[group])))
  const modes = new Set(named('mode'))
  const configured = [...new Set([...named('agent'), ...modes])]
  const held = [...new Set([...NATIVE_AGENTS, ...configured, ...agentFiles])]
  const primary = hold === 'safe' ? 'build' : ([...all].reverse().map((c) => c.default_agent).find((a): a is string => typeof a === 'string') ?? 'build')
  // Normal leaves an agent of a markdown file (whose own rules Centralu does not read) to the config's rules, so that its
  // own come after them; but for the agent Centralu runs, whose asks are set under its own name
  const entered = hold === 'safe' ? held : [...new Set([primary, ...NATIVE_AGENTS, ...configured])]
  const globalLevel = level(all)
  const levelOf = (name: string) => level([...all.map((c) => asObj(asObj(c.agent)[name])), ...all.map((c) => asObj(asObj(c.mode)[name]))])
  const rulesFor = (levels: Obj[], asks: boolean) => ({ ...ownRules(hold, levels, asks), ...taskRules(hold, levels, held, primary, asks) })
  const globalRules = rulesFor([globalLevel], false)
  const entries = (group: 'agent' | 'mode', names: string[]) =>
    Object.fromEntries(
      names.map((name) => {
        const entry = asObj(asObj(theirs[group])[name])
        return [name, { ...entry, permission: withRules(entry.permission, rulesFor([globalLevel, levelOf(name)], name === primary)) }]
      }),
    )
  const config = {
    ...theirs,
    permission: withRules(theirs.permission, globalRules),
    agent: { ...asObj(theirs.agent), ...entries('agent', entered.filter((n) => !modes.has(n))) },
    ...(entered.some((n) => modes.has(n)) ? { mode: { ...asObj(theirs.mode), ...entries('mode', entered.filter((n) => modes.has(n))) } } : {}),
    ...(hold === 'safe' ? { default_agent: 'build' } : {}),
  }
  const out: Record<string, string> = { OPENCODE_CONFIG_CONTENT: JSON.stringify(config) }
  // OpenCode merges OPENCODE_PERMISSION over the config's `permission`, so a key of Centralu's there would take its value
  if (permissionEnv !== undefined && hold === 'safe') out.OPENCODE_PERMISSION = JSON.stringify(withRules(jsonObject(permissionEnv), globalRules))
  return out
}

/**
 * Centralu's rules for one agent (or, with no agent's level, for one it cannot see), each tool's under its own key:
 * the preset's tools, OpenCode's own asks (`DEFAULT_ASKS`) and every tool the person's rules there ask before. Where
 * the agent can ask (`asks`), Safe's tools ask but where the person denies, and Normal's ask but where a rule of the
 * person's decides; every other tool keeps what its rules decide. Where it cannot, each of those asks is a deny.
 */
function ownRules(hold: Hold, levels: Obj[], asks: boolean): Obj {
  const presetTools = hold === 'safe' ? SAFE_ASKS : NORMAL_ASKS
  const askedHere = levels.flatMap((l) => Object.entries(l).filter(([key, v]) => !/[*?]/.test(key) && key !== 'task' && rulesOfValue(v).some(([, a]) => a === 'ask')).map(([key]) => key))
  const tools = [...new Set([...Object.keys(DEFAULT_ASKS), ...askedHere, ...presetTools])]
  return Object.fromEntries(
    tools.map((tool) => {
      const theirs = levels.flatMap((l) => toolRules(l, tool))
      const rules =
        hold === 'safe' && SAFE_ASKS.includes(tool)
          ? [['*', asks ? 'ask' : 'deny'] as [string, string], ...theirs.filter(([, a]) => a === 'deny')]
          : [...(DEFAULT_ASKS[tool] ?? (presetTools.includes(tool) ? [['*', 'ask'] as [string, string]] : [])), ...theirs]
      return [ownKey(tool), inOrder(asks ? rules : rules.map(([p, a]) => [p, a === 'ask' ? 'deny' : a]))]
    }),
  )
}

/**
 * Handing work to an agent (`task`): under Safe, asks before one it cannot see and lets the held agents run, unless the
 * person denies; under both, never hands work to the agent Centralu runs, as a subagent, where it could not ask; and
 * where the agent cannot ask (`asks`), each ask is a deny, as in `ownRules`
 */
function taskRules(hold: Hold, levels: Obj[], held: string[], primary: string, asks: boolean): Obj {
  const theirs = levels.flatMap((l) => toolRules(l, 'task'))
  const denies = theirs.filter(([, a]) => a === 'deny')
  const base: Rules = hold === 'safe' ? [['*', 'ask'], ...(denies.some(([p]) => p === '*') ? [] : held.map((n): [string, string] => [n, 'allow']))] : theirs
  const rules: Rules = [...base, [primary, 'deny'], ...denies]
  return { [ownKey('task')]: inOrder(asks ? rules : rules.map(([p, a]) => [p, a === 'ask' ? 'deny' : a])) }
}

/**
 * Centralu's key for a tool's rules: the tool's name in capitals, new to every permission object it joins (`holdEnv`),
 * and matched by OpenCode to that tool alone, since its match ignores case (1.19.4, `Wildcard.match`, `si`)
 */
const ownKey = (tool: string) => tool.toUpperCase()

/** A permission with Centralu's rules after the person's, a key of theirs Centralu also sets moved to the end */
const withRules = (p: unknown, rules: Obj): Obj => ({ ...Object.fromEntries(Object.entries(permissionOf(p)).filter(([k]) => !(k in rules))), ...rules })

/** A permission as OpenCode reads it: one word is that word for every tool */
const permissionOf = (p: unknown): Obj => (typeof p === 'string' ? { '*': p } : asObj(p))

/** OpenCode's merge (`mergeDeep`): the later object's keys win, and a key keeps the place it had first */
function merge(a: unknown, b: unknown): unknown {
  if (!isObj(a) || !isObj(b)) return b
  const out: Obj = { ...a, ...b }
  for (const k of Object.keys(b)) if (k in a && isObj(a[k]) && isObj(b[k])) out[k] = merge(a[k], b[k])
  return out
}

/**
 * One level's permission (the config's, or an agent's) as OpenCode reads it from the configs that set it, merged in
 * order: the legacy `tools` switches (`false` a deny, `write` and `patch` under `edit`) under `permission`
 */
function level(cs: Obj[]): Obj {
  const tools = cs.map((c) => c.tools).filter(isObj).reduce<unknown>(merge, {})
  const fromTools = Object.fromEntries(Object.entries(asObj(tools)).map(([t, on]) => [['write', 'patch'].includes(t) ? 'edit' : t, on ? 'allow' : 'deny']))
  const permission = cs.flatMap((c) => (c.permission === undefined ? [] : [permissionOf(c.permission)])).reduce<unknown>(merge, {})
  return asObj(merge(fromTools, permission))
}

/** One key's value as rules: one word decides every call */
const rulesOfValue = (v: unknown): Rules =>
  typeof v === 'string' ? [['*', v]] : Object.entries(asObj(v)).flatMap(([p, a]): Rules => (typeof a === 'string' ? [[p, a]] : []))

/** A level's rules for a tool, under any key that names it, in the level's key order */
const toolRules = (l: Obj, tool: string): Rules => Object.entries(l).filter(([key]) => matches(tool, key)).flatMap(([, v]) => rulesOfValue(v))

/**
 * Rules as one object OpenCode reads in the same order: a later rule for a pattern moves to the end, and a later `*`
 * leaves nothing before it that could still decide
 */
function inOrder(rules: Rules): Obj {
  const out = new Map<string, string>()
  for (const [pattern, action] of rules) {
    if (pattern === '*') out.clear()
    out.delete(pattern)
    out.set(pattern, action)
  }
  return Object.fromEntries(out)
}

/** OpenCode's match of a permission name or pattern (1.19.4, `Wildcard.match`): `*` any run, `?` one character, any case */
function matches(value: string, pattern: string): boolean {
  const re = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${re.endsWith(' .*') ? `${re.slice(0, -3)}( .*)?` : re}$`, 'si').test(value)
}
