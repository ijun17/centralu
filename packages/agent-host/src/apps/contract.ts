import { RESERVED_NAME_PREFIX, appIdProblemText, newAppIdProblem, serverNameProblem } from '@cc/protocol'

/*
 * The host's tool contract (#97): what a session's tools are and who called one. It sits under the adapters, the Centralu tools
 * and the app runtime that all stand on it, so no caller of it owns the definition.
 */

/**
 * The set of tools a session receives (#69). The Assistant gets all of them, a coordination session gets the three within its
 * scope, an app's building session (M4 C-3) gets exactly one, `check`, to check its own app. Every other session gets the light
 * `reader` set (#320): it reads its own project's sessions, and directs only the agents it started itself (#561).
 */
export type ToolProfile = 'assistant' | 'scoped' | 'builder' | 'reader'

/** Whoever called a tool — sessionId=null means a person (the UI) */
export type ToolCaller = { sessionId: string | null; profile: ToolProfile | 'human' }

/**
 * What a Centralu tool answers. `content` and `structuredContent` carry an app's own result through the `app` tool (#2231),
 * as the app gave it, so the agent reads it as it read an app tool's result before; `text` is its text blocks joined
 */
export type ToolOutput = { text: string; isError?: boolean; content?: unknown[]; structuredContent?: Record<string, unknown> }

/**
 * The name of the Assistant MCP server: both the name shown on screen and the key trust is checked against (a tool call card
 * shows `mcp__centralu__list_sessions`; the claude adapter's approval exception and codex's elicitation acceptance judge trust
 * by this same name). It lives once, here, because the manager has to validate a proposed server name and cannot import an
 * adapter (that drags its SDK along), and a fix to one of two copies of the key would be an accident waiting to happen (#93).
 * It sits in the app contract because an external app's id follows the same rule (the server attached to a session is
 * `app-<id>`) and the app runtime cannot import the sessions layer (M4 A-1, #97). The value and its validation are in
 * `app-id.ts` in `@cc/protocol` (M4 C-1), where the "new app" dialog can reach them; this file adds the host's name and the
 * reason text an agent or a log reads.
 */
export const CENTRALU_MCP_NAME = RESERVED_NAME_PREFIX

/**
 * Whether a proposed MCP server name is safe to use (#93): a reason a person can read if it is not, or null. **Blocked where
 * the name comes in.** An approved server's name becomes a tool prefix, which is what the approval exception judges. Two
 * holes found by measurement:
 *   centralu      **completely replaced** the in-process assistant server (an approved server expands after the
 *                 built-in entry, so the same key ends up belonging to someone else)
 *   centralu__pw  the tool name became `mcp__centralu__pw__*`, which passed the prefix check and skipped canUseTool entirely
 * Excluding underscores from the character rule makes `__` impossible to form (the second hole); the reserved-word check keeps
 * the name itself from being taken (the first). It runs first, so it survives a loosened character rule.
 */
export function mcpServerNameError(name: string): string | null {
  // Reserved words are checked first — the order of validation is enforced by protocol's serverNameProblem
  switch (serverNameProblem(name)) {
    case 'reserved':
      return `A name starting with "${CENTRALU_MCP_NAME}" is the name this app uses — suggest a different name`
    case 'shape':
      return 'A name must be lowercase letters, digits, and hyphens, 32 characters or fewer (underscores cannot be used — they separate parts of a tool name)'
    case null:
      return null
  }
}

/**
 * Validation for a MCP server name **as proposed** to a person: the rules above plus a ban on the `app-` prefix (M4 A-5). An
 * app's own id may start with it (`app-store` attaches as `app-app-store`, so it never collides); a proposed server may not: an
 * approved `app-notes` would land in the slot of app `notes`'s own proxy server, the adapter expands the app afterward so the
 * app wins, and the approved server silently disappears. A tool under an `app-` name can also skip approval through an app's
 * read-only annotation, so that slot must belong only to an app the runtime itself knows about.
 */
export function proposedMcpServerNameError(name: string): string | null {
  const base = mcpServerNameError(name)
  if (base) return base
  // Once approved, a server becomes the user-folder app `<name>` (M4 A-7): it can never take a reserved app id, nor an `app-` name
  const problem = newAppIdProblem(name)
  return problem === 'server-prefix' || problem === 'builtin' ? appIdProblemText(name, problem) : null
}

// What the host does with how risky an app says a write is (an app tool's approval, `tool-risk.ts`)
export { presetAsks, runsUnasked } from './external/tool-risk.js'
