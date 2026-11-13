import { isRecord } from '@cc/protocol'
import type { AppToolResult } from '../adapters/contract.js'
import type { AppCallOutcome } from '../apps/external/runtime.js'

/*
 * What an agent receives from an app call, for a session's apps here (session-apps.ts) and on a linked host
 * (linked-session-apps.ts), which share it without importing each other.
 */

/** A runtime outcome → the tool result an agent receives */
export function toResult(o: AppCallOutcome): AppToolResult {
  if (o.result) {
    return {
      content: o.result.content,
      isError: o.status !== 'ok',
      ...(isRecord(o.result.structuredContent) ? { structuredContent: o.result.structuredContent } : {}),
    }
  }
  const what = o.status === 'cancelled' ? 'was cancelled' : o.status === 'rejected' ? 'was refused' : 'failed'
  return failure(`The app call ${what} — ${o.error ?? 'no reason was given'}`)
}

/** A refusal or failure, said to the agent */
export function failure(text: string): AppToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}
