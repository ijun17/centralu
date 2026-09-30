import type { ExternalApps } from './apps/external/runtime.js'
import type { ViewSource } from './views/view-host.js'

/**
 * The one-line join between app views (views/) and the external app runtime (apps/external/)
 * (M4 B-3 ↔ A).
 *
 * The two layers do not know about each other. The view side declares `ViewSource` as "reads the
 * document, reports the source method, and holds the app open while it is open," and the runtime
 * holds the function that actually does that. Here the two are put face to face. main.ts and the
 * tests share this same function, so the seam the tests run through is the same seam the host
 * uses (the same arrangement as `app-run-ledger.ts`).
 *
 * An app is identified by (project, id). The `AppRef` shape is the same on both layers, so it is
 * passed through as is.
 */
export function runtimeViewSource(apps: ExternalApps): ViewSource {
  return {
    readResource: (app, uri) => apps.readResource(app, uri),
    originMode: (app) => apps.viewOrigin(app),
    retain: (app) => apps.retainView(app),
  }
}
