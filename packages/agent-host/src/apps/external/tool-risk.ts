import type { PermissionPreset } from '@cc/protocol'

/**
 * What an app says about the risk of a tool that changes something, and what the host does with it.
 *
 * `annotations.readOnlyHint: true` already lets a tool run with no card (decision 5). That left every other write,
 * from a note in the app's own data folder to a merge on GitHub, behind a card under `safe` and `normal`, and
 * "always" is not remembered for an app tool on Claude (`alwaysAllowKey` has no key for an `other` card), so a
 * session that worked through an app was asked again for each call. This adds two levels an app can declare in
 * the tool's `_meta`, and the host decides what each is worth. A declaration is a claim, like `readOnlyHint`:
 * it is read from the tool list of an app the person turned on (or trusted with its project), never from a
 * name, and an undeclared tool keeps asking.
 *
 *   `local`    the tool writes only this app's own data on this computer, and can be undone. No card under any
 *              preset, as for a read. Only honoured next to `destructiveHint: false` (the MCP default is true),
 *              so an app that says both "local" and "destructive" asks.
 *   `routine`  an ordinary write the app's own project would do anyway (a comment, a pull request, a merge
 *              that the app's own checks gate). No card under `normal`, **capped by project trust**: only for
 *              the app of the session's own project, which attaches only while the project is trusted. A user-folder
 *              app, an app another project shared and an app the session attached itself keep their cards,
 *              and so does `safe`, whose point is to ask.
 *
 * `centralu/askWhen` narrows a `routine` tool: when any argument it names holds the value named (`{ push: true }`), or is set
 * at all for the value "*" (`{ path: "*" }`), the call asks. `centralu/askUnless` is the other way round: the call asks
 * unless some argument it names holds that value (`{ skipPrePr: "*" }`), for a tool that is routine only in one form.
 * Both name arguments with a plain value (true, false, a string, a number) or "*". A declaration that cannot be read (not an
 * object, empty, a value that is itself an object or a list, which no argument could ever equal) asks too. Codex fixes a
 * tool's approval at thread start, before any arguments exist, so there a tool with either one always asks.
 */
export const RISK_META_KEY = 'centralu/risk'
export const ASK_WHEN_META_KEY = 'centralu/askWhen'
export const ASK_UNLESS_META_KEY = 'centralu/askUnless'

export type ToolRisk = 'local' | 'routine'

/** The parts of an MCP tool this judgment reads */
export type RiskTool = {
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } | undefined
  _meta?: Record<string, unknown> | undefined
}

/** The level a tool declares, or null when it declares none, an unknown one, or one its annotations contradict */
export function declaredRisk(tool: RiskTool): ToolRisk | null {
  const risk = tool._meta?.[RISK_META_KEY]
  if (risk !== 'local' && risk !== 'routine') return null
  if (tool.annotations?.readOnlyHint === true) return null // a read needs no level: it never asks
  if (risk === 'local' && tool.annotations?.destructiveHint !== false) return null
  return risk
}

/** The arguments an `askWhen` or `askUnless` declaration names: null when it names none, is not an object, or names a value no argument could equal */
function namedArguments(tool: RiskTool, key: string): Record<string, unknown> | null {
  const v = tool._meta?.[key]
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const named = Object.fromEntries(Object.entries(v))
  if (Object.keys(named).length === 0) return null
  // `{ push: [true] }` would never match, so the tool would never ask: not a licence, unreadable
  return Object.values(named).every((x) => typeof x === 'boolean' || typeof x === 'string' || typeof x === 'number') ? named : null
}

/** The arguments that make a `routine` tool ask */
export const askWhen = (tool: RiskTool): Record<string, unknown> | null => namedArguments(tool, ASK_WHEN_META_KEY)

/** The arguments of which a `routine` tool needs one, or it asks */
export const askUnless = (tool: RiskTool): Record<string, unknown> | null => namedArguments(tool, ASK_UNLESS_META_KEY)

/** What an `askWhen` entry of this value means: the argument is set at all (a path to another checkout, say), whatever it holds */
export const ANY_VALUE = '*'

/** Whether one argument of a call is what an `askWhen` entry names: the same value, or any value that is set for `ANY_VALUE` */
const matches = (given: unknown, named: unknown): boolean => (named === ANY_VALUE ? given !== undefined && given !== null && given !== '' : given === named)

export type RiskScope = {
  /** The app belongs to the session's own project (its project's session, not the orchestrator, not an app attached from elsewhere) */
  own: boolean
  preset: PermissionPreset
  /** The call's arguments; absent where they are not known yet (Codex fixes approval before the call) */
  args?: Record<string, unknown> | undefined
}

/** Whether a tool runs with no card, by what it declares and where it is called. Reads are decided before this (`readOnlyHint`). */
export function runsUnasked(tool: RiskTool, scope: RiskScope): boolean {
  const risk = declaredRisk(tool)
  if (risk === 'local') return true
  if (risk !== 'routine' || !scope.own || scope.preset !== 'normal') return false
  const when = askWhen(tool)
  const unless = askUnless(tool)
  // A declaration that is there but not readable is not a licence: ask
  if (!when && tool._meta?.[ASK_WHEN_META_KEY] !== undefined) return false
  if (!unless && tool._meta?.[ASK_UNLESS_META_KEY] !== undefined) return false
  if (!when && !unless) return true
  // The arguments are unknown (Codex): ask
  const args = scope.args
  if (args === undefined) return false
  // Any one argument that is what `askWhen` names asks; so does none being what `askUnless` names
  if (when && Object.entries(when).some(([k, v]) => matches(args[k], v))) return false
  return !unless || Object.entries(unless).some(([k, v]) => matches(args[k], v))
}
