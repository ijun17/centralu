import type { ExternalApps } from './apps/external/runtime.js'
import type { ViewSource } from './views/view-host.js'

/**
 * The join between app views (views/) and the external app runtime (apps/external/), which do not know each other: the view side declares
 * `ViewSource`, the runtime holds the function behind it. main.ts and the tests share it, so tests run through the host's own seam
 */
export function runtimeViewSource(apps: ExternalApps): ViewSource {
  return {
    readResource: (app, uri) => apps.readResource(app, uri),
    originMode: (app) => apps.viewOrigin(app),
    retain: (app) => apps.retainView(app),
    exists: (app) => apps.exists(app),
    onAppsChanged: (listener) => apps.onAppsChanged(listener),
  }
}
