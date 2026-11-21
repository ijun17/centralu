import { sameApp, type ExternalAppInfo } from '@cc/protocol/client'
import { appKeyOf } from '@cc/core'

// `machine` matters only for a user-folder app (#82): absent or null is this computer's.
export function isApp(a: ExternalAppInfo, projectId: string | null | undefined, appId: string, machine?: string | null): boolean {
  return sameApp(a, { projectId, appId, machine })
}

/**
 * An app's grid view is a pinned view keyed apart from the project screen's (#288, owner 2026-10-04): × on one must
 * not tear down the other; the process is shared. `grid:` cannot begin an app key (a project id or `_user`).
 */
export function gridAppViewKey(projectId: string | null, appId: string, machine?: string | null): string {
  return `grid:${appKeyOf(projectId, appId, machine)}`
}
