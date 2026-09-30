/**
 * The rule for app ids (= the MCP server name attached to a session) (#93, M4 A-1, C-1) —
 * **there is exactly one copy of it.**
 *
 * The host uses it to judge manifests, proposed MCP servers and new apps; the UI uses it for
 * the "new app" window. It used to live only in the host (apps/contract.ts). The new-app window
 * derives an id from the name and shows it, and it has to say whether that id can be used before
 * the app is created, but the UI cannot import the host — this package is the only shelf both
 * halves can read. Writing the rule a second time in the UI would let the window pass an id the
 * host then rejects (the person hears the reason twice) or the other way around, and as learned
 * from #93, whichever copy is looser becomes the hole. So the **judgment** stays in this one
 * place, and the human-facing **wording** is attached separately where it belongs (the host
 * speaks to the agent and the logs, the UI speaks to the person in front of the window).
 *
 * Judgments this file does not make: the id of a built-in app (each half compiles its own
 * roster and the caller passes it in), whether an id already exists (only the host does
 * discovery), and trust (the store is the source of truth). Those are rejected by the host when
 * it creates something, and the window just displays that message as given.
 */

/**
 * A name starting with this prefix belongs to Centralu itself — the name of the in-process
 * orchestrator server. If an approved server took this name, it would replace the built-in
 * server entirely (measured in #93).
 */
export const RESERVED_NAME_PREFIX = 'centralu'

/**
 * The prefix for the server name an external app is attached to a session under (M4 A-5) — the
 * app `notes` is `app-notes` inside a session. A newly **proposed** name (an MCP server pending
 * approval, or a new app) may not start with this prefix: an approved `app-notes` server would
 * land in the same slot as the proxy server for the `notes` app.
 */
export const APP_SERVER_PREFIX = 'app-'

/**
 * The length limit for one id slot — the same number as the character rule below. This is where
 * an id derived from a name gets truncated.
 */
export const APP_ID_MAX_LENGTH = 32

/**
 * Leaving out the underscore is the important part: MCP tool names use `__` as a separator, so
 * allowing underscores would let one server append an extra segment behind someone else's name
 * (`centralu__pw` produced `mcp__centralu__pw__*`, which passed the prefix check, #93).
 */
const NAME_SHAPE = /^[a-z0-9][a-z0-9-]{0,31}$/

/** The reason a server name or app id failed the rule they share */
export type ServerNameProblem = 'reserved' | 'shape'

/**
 * The rule an MCP server name and an app id both follow (#93). Returns null when the name is fine.
 *
 * The reserved-word check runs **first** — so that even if the character rule is loosened later,
 * this judgment still holds. The reserved word is checked case-insensitively and after trimming
 * (`CENTRALU` can read as the same name in some places too).
 */
export function serverNameProblem(name: string): ServerNameProblem | null {
  if (name.trim().toLowerCase().startsWith(RESERVED_NAME_PREFIX)) return 'reserved'
  if (!NAME_SHAPE.test(name)) return 'shape'
  return null
}

/** The reason a newly created app's id was rejected */
export type NewAppIdProblem = ServerNameProblem | 'server-prefix' | 'builtin'

/**
 * The judgment for a newly **proposed** name — the rule above, plus a ban on the `app-` prefix,
 * plus the built-in app ids the caller passes in. Returns null when the name is fine.
 *
 * The `app-` prefix is not blocked during discovery (a hand-made `app-store` app is attached as
 * `app-app-store`, so it does not collide). What is blocked is the point where a new name comes
 * in — a new app has no reason to have the server name `app-app-notes`, and if an approved
 * server took that slot, it could skip approval under the app's read-only annotation.
 */
export function newAppIdProblem(id: string, builtinIds: readonly string[] = []): NewAppIdProblem | null {
  const base = serverNameProblem(id)
  if (base) return base
  if (id.startsWith(APP_SERVER_PREFIX)) return 'server-prefix'
  if (builtinIds.includes(id)) return 'builtin'
  return null
}
