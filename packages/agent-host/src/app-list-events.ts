import type { ExternalApps } from './apps/external/runtime.js'

/**
 * Broadcasts that the external app list has changed (M4 A-8) — filters the runtime's notification
 * (`onAppsChanged`) through a list comparison.
 *
 * The runtime's notification means "may have changed." It fires at every place that mutates
 * state, and the judgment call is left to the receiver. The session side compares the attached
 * apps and tools; here, everything the UI sees (`list()`) is compared. If it is the same, nothing
 * is broadcast. That way a notification where the list stayed the same (only an agent tool
 * changed) does not create a round trip to the screen, and a notification where the list actually
 * changed is never dropped.
 *
 * main.ts and the tests share this same function (the same arrangement as `app-view-source.ts`).
 * The seam the tests run through is the same seam the host uses.
 *
 * @returns unsubscribes
 */
export function onExternalAppListChanged(apps: ExternalApps, emit: () => void): () => void {
  let seen = JSON.stringify(apps.list())
  return apps.onAppsChanged(() => {
    const now = JSON.stringify(apps.list())
    if (now === seen) return
    seen = now
    emit()
  })
}
