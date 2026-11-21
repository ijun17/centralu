import { z } from 'zod'
import { AppId } from './entities/ids.js'

// The answers about a project's app used across a link (docs/plans/remote-hub.md §13). Apart from their calls in
// machines-hub.ts because `host.*` methods return them too, so the window's bundle needs them (#1648).

/** Its MCP shape without `outputSchema` */
export const LinkedAppTool = z.object({
  name: z.string().min(1).max(200),
  title: z.string().max(500).optional(),
  description: z.string().max(20_000).optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  annotations: z
    .looseObject({
      title: z.string().optional(),
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .optional(),
})
export type LinkedAppTool = z.infer<typeof LinkedAppTool>

/** `projectId` is the answering host's own; `tools` is null until the app lists them after that host's start */
export const LinkedApp = z.object({
  projectId: z.string().min(1).max(200),
  project: z.string().max(500),
  appId: AppId,
  name: z.string().max(500),
  description: z.string().max(4000),
  /** The project's root app (#1141), reached without a card */
  root: z.boolean().optional(),
  tools: z.array(LinkedAppTool).max(500).nullable(),
})
export type LinkedApp = z.infer<typeof LinkedApp>

export const LinkedAppsResult = z.object({ apps: z.array(LinkedApp).max(500) })
export type LinkedAppsResult = z.infer<typeof LinkedAppsResult>

/** `running` with its run id once the caller's wait is up */
export const LinkedAppCallResult = z.object({
  status: z.enum(['ok', 'error', 'cancelled', 'rejected', 'running']),
  runId: z.string().max(200),
  result: z
    .object({
      content: z.array(z.looseObject({ type: z.string() })),
      structuredContent: z.record(z.string(), z.unknown()).optional(),
      isError: z.boolean().optional(),
    })
    .nullable(),
  error: z.string().max(20_000).nullable(),
  durationMs: z.number().min(0),
})
export type LinkedAppCallResult = z.infer<typeof LinkedAppCallResult>
