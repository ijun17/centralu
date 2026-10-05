import { APP_SERVER_PREFIX, RESERVED_NAME_PREFIX, newAppIdProblem, serverNameProblem } from '@cc/protocol'

/*
 * The host's tool contract (#97) — what a session's tools are and who called one.
 *
 * These used to be defined in sessions/orchestrator-tools.ts, which left the source of truth for
 * "what can be called, by whom" with one of its callers (the orchestrator) instead of with the
 * layer the adapters, the orchestrator tools and the app runtime all stand on. They were moved
 * here, and stayed here when the built-in app framework that also used them (HostAppModule, the
 * control app) was removed in #97.
 */

/**
 * The set of tools a session receives (#69). The orchestrator gets all of them, the worktree manager
 * gets a subset, a coordination session gets the three within its scope, and an app's building
 * session (M4 C-3) gets exactly one, `check`, to check its own app. Every other session gets the
 * light, read-only `reader` set (#320): it sees its own project's sessions and directs none of them.
 */
export type ToolProfile = 'orchestrator' | 'manager' | 'scoped' | 'builder' | 'reader'

/** Whoever called a tool — sessionId=null means a person (the UI) */
export type ToolCaller = { sessionId: string | null; profile: ToolProfile | 'human' }

export type ToolOutput = { text: string; isError?: boolean }

/**
 * The name of the orchestrator MCP server.
 *
 * **This is both the name shown on screen and the key trust is checked against** — it shows up on a
 * tool call card as `mcp__centralu__list_sessions`, and both the claude adapter's approval exception
 * and codex's elicitation acceptance judge trust by this same name.
 *
 * Why this lives in exactly one place: there used to be one literal copy each in the claude and codex
 * adapters, and the manager, which is precisely the thing that needs to validate a proposed server
 * name, could import neither (importing an adapter drags its SDK along). With the key duplicated, a
 * fix to only one copy is an accident waiting to happen — it is written once here, and everything
 * else imports it (#93).
 *
 * **Why it lives here, in the app contract (M4 A-1)**: it used to sit next to the orchestrator's tool
 * definitions. An external app's id has to follow the same rule (the server name attached to a
 * session is `app-<id>`), but the app runtime cannot import the sessions layer — if the rule stayed
 * with a passenger (the orchestrator), the runtime would end up with two copies of it. This is the
 * same direction #97 moved the central types in, into this file.
 *
 * **The value and its validation moved once more, into `app-id.ts` in `@cc/protocol` (M4 C-1).** The
 * "new app" dialog has to validate the id it builds from the name before creating it, and that
 * package is the only place the UI can reach. This file only attaches the host's name and the reason
 * text an agent or a log reads — validation travels together with the dialog.
 */
export const ORCHESTRATOR_MCP_NAME = RESERVED_NAME_PREFIX

/**
 * Whether a proposed MCP server name is safe to use (#93). Returns a reason a person can read if it
 * is not, or null if it is fine.
 *
 * **This is blocked at the point where the name comes in.** An approved server's name becomes a tool
 * prefix, and that tool prefix is what the approval exception judges. Two holes found by measurement:
 *
 *   centralu      **completely replaced** the in-process orchestrator server (the approved server
 *                 expands after the built-in entry — the same key ends up belonging to someone else)
 *   centralu__pw  the tool name became `mcp__centralu__pw__*`, which passed the prefix check →
 *                 skipped canUseTool entirely
 *
 * So there are two layers of defense here. Excluding underscores from the character rule makes `__`
 * impossible to form (closing the second hole), and the reserved-word check keeps the name itself
 * from being taken (closing the first). Checking reserved words first means that even if the
 * character rule is loosened later, this particular check still survives.
 */
/**
 * The prefix for the server name an external app attaches to a session (M4 A-5) — app `notes` is
 * `app-notes` in a session, and its tools show up as `mcp__app-notes__<tool>`.
 *
 * Why the prefix is kept separate: an app's id and a proposed MCP server name follow the same
 * character rule (below), so attaching an app as bare `notes` would fight over the same slot as a
 * `notes` server the person has already approved.
 */
export const APP_MCP_PREFIX = APP_SERVER_PREFIX

export const appMcpServerName = (appId: string): string => `${APP_MCP_PREFIX}${appId}`

export function mcpServerNameError(name: string): string | null {
  // Reserved words are checked first — the order of validation is enforced by protocol's serverNameProblem
  switch (serverNameProblem(name)) {
    case 'reserved':
      return `A name starting with "${ORCHESTRATOR_MCP_NAME}" is the name this app uses — suggest a different name`
    case 'shape':
      return 'A name must be lowercase letters, digits, and hyphens, 32 characters or fewer (underscores cannot be used — they separate parts of a tool name)'
    case null:
      return null
  }
}

/**
 * Validation for a MCP server name **as proposed** to a person — adds a ban on the `app-` prefix to
 * the rules above (M4 A-5).
 *
 * This does not ban the prefix from an app's own id (an app called `app-store` attaches as
 * `app-app-store`, so it never collides). What is banned is a proposed server: an approved `app-notes`
 * server would land in the same slot as app `notes`'s own proxy server. An adapter expands the app
 * afterward so the app wins, but that means a server the person approved silently disappears. And a
 * tool under an `app-` name is a slot that can skip approval through an app's read-only annotation —
 * that slot must belong only to an app the runtime itself knows about. So this is blocked at the
 * point where the name comes in.
 */
export function proposedMcpServerNameError(name: string): string | null {
  const base = mcpServerNameError(name)
  if (base) return base
  if (newAppIdProblem(name) === 'server-prefix') {
    return `A name starting with "${APP_MCP_PREFIX}" is the name an external app attaches to a session — suggest a different name`
  }
  return null
}

