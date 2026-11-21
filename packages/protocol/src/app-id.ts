// The one rule for app ids, which are MCP server names in a session (#93): the host and the new-app window both judge
// with it, since whichever copy is looser becomes the hole. Wording stays with each side; existence and trust are the
// host's to judge.

/** Centralu's own in-process server: an approved server under this name would replace it (measured, #93) */
export const RESERVED_NAME_PREFIX = 'centralu'

/** App `notes` is server `app-notes` in a session, so a proposed name may not take the prefix and land in its slot */
export const APP_SERVER_PREFIX = 'app-'

export const appServerName = (appId: string): string => `${APP_SERVER_PREFIX}${appId}`

/**
 * `control`: app_settings rows (`app:control:*`) and coordinator sessions stamped `appId: 'control'` remain, and an
 * external app of that id would inherit them as its own (#97, #372)
 */
export const RESERVED_APP_IDS: readonly string[] = ['control']

/** Matches `NAME_SHAPE`; an id derived from a name is cut here */
export const APP_ID_MAX_LENGTH = 32

/**
 * No underscore: MCP tool names use `__` as a separator, so `centralu__pw` gave `mcp__centralu__pw__*`, past the prefix
 * check (#93)
 */
const NAME_SHAPE = /^[a-z0-9][a-z0-9-]{0,31}$/

export type ServerNameProblem = 'reserved' | 'shape'

/** The reserved check runs first, trimmed and case-insensitive, so it holds whatever the shape rule allows */
export function serverNameProblem(name: string): ServerNameProblem | null {
  if (name.trim().toLowerCase().startsWith(RESERVED_NAME_PREFIX)) return 'reserved'
  if (!NAME_SHAPE.test(name)) return 'shape'
  return null
}

export type NewAppIdProblem = ServerNameProblem | 'server-prefix' | 'builtin'

/**
 * For a newly proposed name. `app-` is refused only here, not in discovery (a hand-made `app-store` attaches as
 * `app-app-store`): an approved server in an app's slot could skip approval under the app's read-only annotation.
 * `builtin` covers every reserved id.
 */
export function newAppIdProblem(
  id: string,
  reservedIds: readonly string[] = RESERVED_APP_IDS,
): NewAppIdProblem | null {
  const base = serverNameProblem(id)
  if (base) return base
  if (id.startsWith(APP_SERVER_PREFIX)) return 'server-prefix'
  if (reservedIds.includes(id)) return 'builtin'
  return null
}

/** Worded once for every door that takes an id; the new-app dialog words it its own way */
export function appIdProblemText(id: string, problem: NewAppIdProblem): string {
  if (problem === 'builtin') return `"${id}" is reserved. Pick another app id.`
  const why: Record<Exclude<NewAppIdProblem, 'builtin'>, string> = {
    shape: `an app id is lowercase letters, digits and hyphens (up to ${APP_ID_MAX_LENGTH}), starting with a letter or digit, with no underscores ("__" separates names in a session's tool names)`,
    reserved: `ids starting with "${RESERVED_NAME_PREFIX}" belong to Centralu itself`,
    'server-prefix': `ids starting with "${APP_SERVER_PREFIX}" are how apps attach to sessions`,
  }
  return `"${id}" cannot be an app id: ${why[problem]}. Pick another.`
}
