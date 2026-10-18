import { RpcMethods, parseTolerant } from '@cc/protocol'
import type { RemoteViews } from '../views/view-host.js'
import type { RpcHandler } from './router.js'
import { rpcError } from '../rpc-error.js'

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
          throw rpcError('This app view is on a machine whose Centralu cannot show its views here yet. Update Centralu there to open it.')
        }
        throw err
      }
      /*
       * Read as the window reads a newer host's answers (#384): a field or a word this hub does not know costs that
       * value only. An origin mode it cannot read is `opaque`, the one that shares nothing: a view on the wrong side
       * of that line could reach another app's storage. Without the app, the address or the document there is no view.
       */
      const d = parseTolerant(RpcMethods['apps.viewDocument'].result, answer)
      const projectId: unknown = d?.projectId
      if (typeof d?.appId !== 'string' || typeof d.uri !== 'string' || !(typeof projectId === 'string' || projectId === null) || !Array.isArray(d.resource?.contents)) {
        throw rpcError("The machine's answer for this app view could not be read. Update Centralu on both computers to the same version.")
      }
      return { app: { appId: d.appId, projectId: d.projectId }, uri: d.uri, origin: d.origin === 'app' ? 'app' : 'opaque', resource: d.resource }
    },
  }
}
