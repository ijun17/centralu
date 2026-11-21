import type { ExternalApps } from './apps/external/runtime.js'

/**
 * Broadcasts that the external app list changed. The runtime's `onAppsChanged` only means "may have changed", so this compares what
 * the UI sees (`list()`) and emits on a difference: a notification with an unchanged list costs no round trip, a real change is never
 * dropped. main.ts and the tests share it. @returns unsubscribes
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
