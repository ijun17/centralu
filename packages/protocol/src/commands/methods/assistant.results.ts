import { z } from 'zod'
import { SessionInfo } from '../sessions.js'

/** A Centralu tool's answer to the bridge; for the `app` tool, also the app's own result, which the bridge relays instead of the text */
const CentraluToolResult = z.object({
  text: z.string(),
  isError: z.boolean().optional(),
  content: z.array(z.unknown()).optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
})

/** Results of the `assistant` methods, read through `parseRpcResult`. Params and what each method does: ./assistant.params.ts */
export const assistantResults = {
  'assistant.get': SessionInfo,
  'assistant.peek': SessionInfo.nullable(),
  'assistant.configure': z.object({ ok: z.literal(true) }),
  'assistant.tools': z.array(
    z.object({ name: z.string(), description: z.string(), inputSchema: z.unknown() }),
  ),
  'assistant.tool': CentraluToolResult,
} as const
