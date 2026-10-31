import type { ExternalAppInfo } from '@cc/protocol/client'
import { appKeyOf } from '@cc/core'

/**
 * How the store names an external app and its views: the app's key (`appKeyOf`), whether a
 * listed app is the one named (`isApp`), and the key of its view on the grid (`gridAppViewKey`).
 */

/**
 * Whether an app in the list is the one (project, id, machine) names. `machine` matters only for a user-folder app
 * (#82): absent or null is this computer's, a machine id is that linked machine's.
 */
export function isApp(a: ExternalAppInfo, projectId: string | null | undefined, appId: string, machine?: string | null): boolean {
  if (a.appId !== appId || a.projectId !== (projectId ?? null)) return false
  return projectId ? true : (a.machine ?? null) === (machine ?? null)
}

/**
 * The key of an app's view on the grid (#288) — a pinned view of its own, apart from the app's
 * pinned view (`appKeyOf`) that the app view and its project screen share.
 *
 * Owner decision (2026-10-04): the same app can stand in more than one place at once, and each
 * place is its own view while the app's process is shared. The grid and the project screen are
 * different screens with different lives — × on the grid must not tear down the view a person left
 * on the project screen, and the other way round — so the grid's entry is keyed apart. Everything
 * else about it is a pinned view's: opened by `home`, laid over its panel (`pinned-app/slots.ts`),
 * hidden rather than unloaded while another screen is looked at, followed to new code, and torn
 * down first whenever it goes. `grid:` cannot begin an app key, whose first segment is a project
 * id or `_user`.
 */
export function gridAppViewKey(projectId: string | null, appId: string, machine?: string | null): string {
  return `grid:${appKeyOf(projectId, appId, machine)}`
}
