import { MACHINE_ID_RE } from './machines.js'

/**
 * One app as a single string (#82, #288) — what the host stores an app's permissions, builder, origin port and grid
 * panel under, and what the UI keys its catalog, spans and drags by. An app is unique per (project, id): the `notes`
 * app of two projects is two apps. Written out by hand in a dozen places, the copies had drifted between a null check
 * and a truthiness check of the project; every place builds and reads it here.
 */

/**
 * The scope name of a user-folder app — a key in memory and a stored key, and also one segment of the host's data
 * and log folders. It matches the UI's `externalAppKey`, and never collides with a project id (a UUID).
 */
export const USER_APP_SCOPE = '_user'

/**
 * One app as a single string: `<project id | _user>/<app id>` — the UI's `externalAppKey`.
 *
 * A linked machine's user-folder app (#82) has no project to tell it from this computer's app of the same id, so its
 * key names the machine: `<machine>:_user/<app id>`. `machine` is ignored with a project, whose id already names it.
 */
export function appKeyOf(projectId: string | null | undefined, appId: string, machine?: string | null): string {
  return machine && projectId == null ? `${machine}:${USER_APP_SCOPE}/${appId}` : `${projectId ?? USER_APP_SCOPE}/${appId}`
}

/**
 * The (project, app) an app key stands for, with the machine of a linked machine's user-folder app, or null for a
 * string that is not one. Neither a project id nor an app id can contain `/`, so the first one splits it; a project
 * id never contains `:` (a UUID, or `<machine>.<uuid>`), so `<machine>:_user` is a machine's user folder.
 */
export function parseAppKey(key: string): { projectId: string | null; appId: string; machine?: string } | null {
  const at = key.indexOf('/')
  if (at <= 0 || at === key.length - 1) return null
  const scope = key.slice(0, at)
  const appId = key.slice(at + 1)
  const colon = scope.indexOf(':')
  if (colon >= 0) {
    const machine = scope.slice(0, colon)
    return scope.slice(colon + 1) === USER_APP_SCOPE && MACHINE_ID_RE.test(machine) ? { projectId: null, appId, machine } : null
  }
  return { projectId: scope === USER_APP_SCOPE ? null : scope, appId }
}

/**
 * An app as a person reads it in a log line or a check report: `user/<app id>` for the user folder, or the project
 * id's first eight characters — enough to tell projects apart, short enough for one line. Not a key: two projects can
 * share a prefix.
 */
export function appLabel(ref: { projectId: string | null; appId: string }): string {
  return `${ref.projectId === null ? 'user' : ref.projectId.slice(0, 8)}/${ref.appId}`
}
