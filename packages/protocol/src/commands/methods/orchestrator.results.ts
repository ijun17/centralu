import { z } from 'zod'
import { SessionInfo } from '../sessions.js'

/** The results of the `orchestrator` methods, which a client reads through `parseRpcResult`. Their parameters, and what each method is for: ./orchestrator.params.ts */
export const orchestratorResults = {
  'orchestrator.get': SessionInfo,
  'orchestrator.peek': SessionInfo.nullable(),
  'orchestrator.configure': z.object({ ok: z.literal(true) }),
  'orchestrator.tools': z.array(
    z.object({ name: z.string(), description: z.string(), inputSchema: z.unknown() }),
  ),
  'orchestrator.tool': z.object({ text: z.string(), isError: z.boolean().optional() }),
} as const
