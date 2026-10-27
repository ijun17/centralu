import { APP_SERVER_PREFIX, RESERVED_NAME_PREFIX } from './app-id.js'
import type { ToolSummary } from './entities/sessions.js'

/**
 * Centralu's own tool calls (#730): which server a call went to, read the same way by the adapters that mark a call
 * (`ToolSummary.centralu`) and by the screen reading a record an older host wrote without the mark.
 */

/** A Claude tool name's server and tool (`mcp__<server>__<tool>`); null for a tool that is not an MCP server's */
export function mcpNameParts(name: string): { server: string; tool: string } | null {
  const m = /^mcp__([^_]+(?:_(?!_)[^_]*)*)__(.+)$/.exec(name)
  const [, server, tool] = m ?? []
  return server !== undefined && tool !== undefined ? { server, tool } : null
}

/**
 * Whether a server's name is Centralu's: its own (`centralu`, which no other server may take: `serverNameProblem`) or
 * an app's (`app-<id>`, with the id). The second is only the name's shape: a proposed server may not take the `app-`
 * prefix, but a repository's own `.mcp.json` or the person's CLI config may name a server `app-notes`. So an adapter
 * keeps an app's mark only for a server the session has that app attached under (`keepAttachedAppMarks`), and the
 * screen reads an unmarked record's `mcp__app-<id>__…` name as an app's only for an app it knows.
 */
export function centraluServer(server: string): { app?: string } | null {
  if (server === RESERVED_NAME_PREFIX) return {}
  if (server.startsWith(APP_SERVER_PREFIX) && server.length > APP_SERVER_PREFIX.length)
    return { app: server.slice(APP_SERVER_PREFIX.length) }
  return null
}

/** The call as the screen draws it: the mark the host set, else what a Claude name says (an older host's records) */
export function centraluCallOf(
  s: Pick<ToolSummary, 'tool' | 'centralu'>,
): NonNullable<ToolSummary['centralu']> | null {
  if (s.centralu) return s.centralu
  const parts = mcpNameParts(s.tool)
  const origin = parts ? centraluServer(parts.server) : null
  return parts && origin ? { tool: parts.tool, ...origin } : null
}

/**
 * What a Centralu call does, in words (#730), for a record with no `label` (an older host's, a tool this build does not
 * name): the tool's name as words, an app's call prefixed by the app.
 */
export function centraluCallLabel(c: NonNullable<ToolSummary['centralu']>, appName?: string): string {
  if (c.label) return c.label
  const words = c.tool.replace(/[_-]+/g, ' ').trim()
  const tool = words ? words.charAt(0).toUpperCase() + words.slice(1) : c.tool
  return c.app ? `${appName ?? c.app}: ${words || c.tool}` : tool
}

/**
 * A call's title as the screen shows it beside what it did (#730): empty when it only repeats the words or the raw
 * name. Codex titles an MCP call `<server>: <tool> <arguments>`; the server and tool already show, so only the
 * arguments are left.
 */
export function centraluCallTitle(
  s: Pick<ToolSummary, 'tool' | 'title' | 'centralu'>,
  c: NonNullable<ToolSummary['centralu']>,
): string {
  if (s.title === s.tool || s.title === c.label) return ''
  const codexName = `${c.app ? `${APP_SERVER_PREFIX}${c.app}` : RESERVED_NAME_PREFIX}: ${c.tool}`
  return s.title.startsWith(codexName) ? s.title.slice(codexName.length).trim() : s.title
}

/** One line for a tool call (a session's preview, #730): a Centralu call says what it did, then its title */
export function toolCallLine(s: Pick<ToolSummary, 'tool' | 'title' | 'centralu'>): string {
  const c = centraluCallOf(s)
  if (!c) return s.title
  const title = centraluCallTitle(s, c)
  const label = centraluCallLabel(c)
  return title ? `${label}: ${title}` : label
}
