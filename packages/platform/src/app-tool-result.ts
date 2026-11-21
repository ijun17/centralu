import { isRecord } from '@cc/protocol/client'
import type { AppToolResult } from './ports/index.js'

/** An MCP `tools/call` response as far as `AppToolResult` says; other keys pass through untouched */
export function isAppToolResult(v: unknown): v is AppToolResult {
  if (!isRecord(v) || !Array.isArray(v.content) || !v.content.every(isRecord)) return false
  const isOptionalRecord = (x: unknown) => x === undefined || isRecord(x)
  return isOptionalRecord(v.structuredContent) && isOptionalRecord(v._meta) && (v.isError === undefined || typeof v.isError === 'boolean')
}
