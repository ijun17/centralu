import { RpcMethods } from '@cc/protocol'
import type { RemoteViews } from '../views/view-host.js'
import type { RpcHandler } from './router.js'

/**
 * The views of linked machines, as the hub's ViewHost reads them (docs/plans/remote-hub.md §11).
 *
 * `call` is the router: `apps.viewDocument` with a qualified instance id goes to the machine the id names, stripped,
 * and comes back with the app's project qualified (`routes.ts`). An id whose prefix names no linked machine reaches the
 * hub's own handler, where it is never open, so a machine removed since the window got the id is "not open" rather
 * than another machine's view.
 */
export function linkedViews(call: RpcHandler): RemoteViews {
  return {
    async document(instanceId) {
      let answer: unknown
      try {
        answer = await call('apps.viewDocument', { instanceId })
      } catch (err) {
        // A machine on a Centralu from before phase 2 (connected anyway, on one protocol): say what would fix it
        if (err instanceof Error && err.message.startsWith('Unknown method: apps.viewDocument')) {
          throw Object.assign(
            new Error('This app view is on a machine whose Centralu cannot show its views here yet. Update Centralu there to open it.'),
            { code: 'internal' },
          )
        }
        throw err
      }
      const d = RpcMethods['apps.viewDocument'].result.parse(answer)
      return { app: { appId: d.appId, projectId: d.projectId }, uri: d.uri, origin: d.origin, resource: d.resource }
    },
  }
}
