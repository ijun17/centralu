import type { HomeView } from './views/home-view.js'
import type { AppRef, ExternalApps } from './apps/external/runtime.js'
import type { ViewHost } from './views/view-host.js'
import { rpcError } from './rpc-error.js'

/**
 * Opens the one fixed view, the body of `apps.openView`: the host calls the manifest's `home` tool through the one call path
 * (`ExternalApps.call`) with the view as caller, so scope and the run record ("the view called home") happen there once. It checks the
 * view exists (`homeView`), calls it, and opens the instance only once the app answered: a call that never reached the app (rejected,
 * failed to start) leaves no instance, while an `isError` answer is opened, since rendering that failure is the view's job. The instance
 * belongs to the app that was called and ViewHost reads the document only from that app's process, so a result cannot impersonate another
 * app's view. main.ts (rpc.ts) and the tests share it
 */
export type { HomeView } from './views/home-view.js'

/** `holder`: the connection that leases the view (ViewHost `LEASE_GRACE_MS`); none for a view that lives until closed */
export async function openHomeView(apps: ExternalApps, views: ViewHost, ref: AppRef, holder?: number, openKey?: string): Promise<HomeView> {
  const prior = openKey ? views.homeOpen(ref, openKey, holder) : null
  if (prior) return prior
  const home = await apps.homeView(ref)
  // Two calls may have checked the metadata concurrently
  const concurrent = openKey ? views.homeOpen(ref, openKey, holder) : null
  if (concurrent) return concurrent
  const toolInput: Record<string, unknown> = {}
  const invoke = async () => {
    const out = await apps.call(ref, home.tool, toolInput, { kind: 'view' })
    if (!out.result) throw rpcError(out.error ?? `The home tool "${home.tool}" did not answer`)
    return { tool: home.tool, resourceUri: home.resourceUri, toolInput, toolResult: out.result, runId: out.runId }
  }
  if (openKey) {
    const { instanceId } = views.open(ref, home.resourceUri, holder)
    return views.rememberHome(instanceId, openKey, async () => ({ instanceId, ...await invoke() }))
  }
  const outcome = await invoke()
  return { ...views.open(ref, home.resourceUri, holder), ...outcome }
}
