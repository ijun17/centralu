import type { CallToolResult } from '@modelcontextprotocol/client'
import type { AppRef, ExternalApps } from './apps/external/runtime.js'
import type { ViewHost } from './views/view-host.js'

/**
 * Opens the one fixed view (M4 B-2) — the body of the RPC `apps.openView`.
 *
 * Clicking an app in the sidebar makes the host call the `home` tool from the manifest, and opens
 * the view that tool declares. The host calling a tool is also within the spec. The view is still
 * born from a single tool call (the plan's "two places a view is born"). So the calling path is
 * the same **single path** as every other call (`ExternalApps.call`), and the caller is **the
 * view**. Scope (`app`) and the run record both happen there, once. The record shows "the view
 * called home." A person clicked it, but that is the same reason a view's own call is not
 * recorded as "the person."
 *
 * Order: check whether the view exists first (`homeView`), call it, and open the instance only
 * once the app has answered. A call that never reached the app (rejected, failed to start) has no
 * result to render, so it fails with a reason and no instance is left behind. A call the app
 * answered with a failure (`isError`) is opened — rendering that failure is also the view's job
 * (the spec's tool-result).
 *
 * There is no path here to impersonate another app's view. The instance belongs to the app that
 * was called, and ViewHost reads the document only from the instance's own app. Whatever the
 * result claims, the read happens against this app's process.
 *
 * main.ts (rpc.ts) and the tests share the same function (the same arrangement as
 * `app-view-source.ts`).
 */
export type HomeView = {
  instanceId: string
  tool: string
  resourceUri: string
  /** What to send the view as tool-input — the exact arguments the host called with */
  toolInput: Record<string, unknown>
  /** The app's answer as is — becomes the view's tool-result */
  toolResult: CallToolResult
  runId: string
}

/** `holder`: the connection that leases the view (ViewHost `LEASE_GRACE_MS`); none for a view that lives until closed */
export async function openHomeView(apps: ExternalApps, views: ViewHost, ref: AppRef, holder?: number): Promise<HomeView> {
  const home = await apps.homeView(ref)
  const toolInput: Record<string, unknown> = {}
  const out = await apps.call(ref, home.tool, toolInput, { kind: 'view' })
  if (!out.result) throw Object.assign(new Error(out.error ?? `The home tool "${home.tool}" did not answer`), { code: 'internal' })
  const { instanceId } = views.open(ref, home.resourceUri, holder)
  return { instanceId, tool: home.tool, resourceUri: home.resourceUri, toolInput, toolResult: out.result, runId: out.runId }
}
