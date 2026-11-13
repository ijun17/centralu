import { z } from 'zod'
import { AppId } from './entities/ids.js'

/**
 * A project's app used from another machine (#1938, docs/plans/remote-hub.md §13): what the app's host answers a linked
 * host with. The calls' parameters are in machines-hub.ts, which only the host reads; these answers are the results of
 * `host.*` methods too, so they stay where the window's bundle reaches them (#1648).
 */

/** One tool of the app as the app's host lists it to an agent: its MCP shape without `outputSchema` */
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

/**
 * An app the asking host's session may reach on the answering host (`host.apps`, `hub.apps`): its project by the answering
 * host's own id and name, and its model tools when the app has listed them since that host started (null: not yet)
 */
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

/**
 * What one call came to (`host.appCall`, `hub.appCall`): the app's outcome as the runtime records it, or `running` with
 * its run id once the caller's wait is up. The same call id asked again waits on the same run
 */
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
