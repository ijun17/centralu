import { isRecord } from '@cc/protocol/client'
import type { AppToolResult } from './ports/index.js'

/**
 * Whether a value is the shape of an MCP `tools/call` response, as far as `AppToolResult` says it: a `content` list of
 * objects, and `structuredContent` and `_meta` objects and `isError` a boolean when present. Anything else an app
 * (or an older host) sent is no result this layer can carry. Other keys pass through untouched.
 */
export function isAppToolResult(v: unknown): v is AppToolResult {
  if (!isRecord(v) || !Array.isArray(v.content) || !v.content.every(isRecord)) return false
  const isOptionalRecord = (x: unknown) => x === undefined || isRecord(x)
  return isOptionalRecord(v.structuredContent) && isOptionalRecord(v._meta) && (v.isError === undefined || typeof v.isError === 'boolean')
}
