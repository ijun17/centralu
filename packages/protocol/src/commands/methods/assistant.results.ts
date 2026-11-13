import { z } from 'zod'
import { SessionInfo } from '../sessions.js'

/**
 * What one of Centralu's tools answers the bridge: its text, and for the `app` tool an app's own result as the app gave it
 * (#2231), which the bridge relays in place of the text
 */
const CentraluToolResult = z.object({
  text: z.string(),
  isError: z.boolean().optional(),
  content: z.array(z.unknown()).optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
})

/** The results of the `assistant` methods, which a client reads through `parseRpcResult`. Their parameters, and what each method is for: ./assistant.params.ts */
export const assistantResults = {
  'orchestrator.get': SessionInfo,
  'orchestrator.peek': SessionInfo.nullable(),
  'orchestrator.configure': z.object({ ok: z.literal(true) }),
  'orchestrator.tools': z.array(
    z.object({ name: z.string(), description: z.string(), inputSchema: z.unknown() }),
  ),
  'orchestrator.tool': CentraluToolResult,
  // #2133 step 3: the same five under the new name (./assistant.params.ts)
  'assistant.get': SessionInfo,
  'assistant.peek': SessionInfo.nullable(),
  'assistant.configure': z.object({ ok: z.literal(true) }),
  'assistant.tools': z.array(
    z.object({ name: z.string(), description: z.string(), inputSchema: z.unknown() }),
  ),
  'assistant.tool': CentraluToolResult,
} as const
