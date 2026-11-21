import { APP_SERVER_PREFIX, RESERVED_NAME_PREFIX, appServerName } from './app-id.js'
import type { ToolSummary } from './entities/sessions.js'
import { sentenceStart } from './plain-line.js'

// Centralu's own tool calls (#730), read alike by the adapters that mark a call (`ToolSummary.centralu`) and by the
// screen reading an unmarked record of an older host.

/** A Claude tool name (`mcp__<server>__<tool>`); null for a tool that is not an MCP server's */
export function mcpNameParts(name: string): { server: string; tool: string } | null {
  const m = /^mcp__([^_]+(?:_(?!_)[^_]*)*)__(.+)$/.exec(name)
  const [, server, tool] = m ?? []
  return server !== undefined && tool !== undefined ? { server, tool } : null
}

/**
 * `app-<id>` is only a name's shape: a repository's `.mcp.json` or the person's CLI config may name a server
 * `app-notes`. So an adapter keeps an app's mark only for an attached app (`keepAttachedAppMarks`), and the screen
 * reads an unmarked `mcp__app-<id>__…` as an app's only for an app it knows.
 */
export function centraluServer(server: string): { app?: string } | null {
  if (server === RESERVED_NAME_PREFIX) return {}
  if (server.startsWith(APP_SERVER_PREFIX) && server.length > APP_SERVER_PREFIX.length)
    return { app: server.slice(APP_SERVER_PREFIX.length) }
  return null
}

/** The host's mark, else what a Claude name says (an older host's records) */
export function centraluCallOf(
  s: Pick<ToolSummary, 'tool' | 'centralu'>,
): NonNullable<ToolSummary['centralu']> | null {
  if (s.centralu) return s.centralu
  const parts = mcpNameParts(s.tool)
  const origin = parts ? centraluServer(parts.server) : null
  return parts && origin ? { tool: parts.tool, ...origin } : null
}

/** For a record with no `label` (an older host's, or a tool this build does not name) */
export function centraluCallLabel(c: NonNullable<ToolSummary['centralu']>, appName?: string): string {
  if (c.label) return c.label
  const words = c.tool.replace(/[_-]+/g, ' ').trim()
  const tool = words ? sentenceStart(words) : c.tool
  return c.app ? `${appName ?? c.app}: ${words || c.tool}` : tool
}

/**
 * Empty when it only repeats the label or the raw name. Codex titles an MCP call `<server>: <tool> <arguments>`, so
 * only the arguments are left.
 */
export function centraluCallTitle(
  s: Pick<ToolSummary, 'tool' | 'title' | 'centralu'>,
  c: NonNullable<ToolSummary['centralu']>,
): string {
  if (s.title === s.tool || s.title === c.label) return ''
  const codexName = `${c.app ? appServerName(c.app) : RESERVED_NAME_PREFIX}: ${c.tool}`
  return s.title.startsWith(codexName) ? s.title.slice(codexName.length).trim() : s.title
}

/** For a session's preview */
export function toolCallLine(s: Pick<ToolSummary, 'tool' | 'title' | 'centralu'>): string {
  const c = centraluCallOf(s)
  if (!c) return s.title
  const title = centraluCallTitle(s, c)
  const label = centraluCallLabel(c)
  return title ? `${label}: ${title}` : label
}
