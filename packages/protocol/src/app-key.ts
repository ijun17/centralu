import { MACHINE_ID_RE } from './machines.js'

// One app as a single string, stored by the host and keyed on by the UI. An app is unique per (project, id); copies
// written by hand drifted (a null check against a truthiness check), so every place builds and reads it here (#288).

/** Also a segment of the host's data and log folders; never collides with a project id (a UUID) */
export const USER_APP_SCOPE = '_user'

/**
 * `<project id | _user>/<app id>`. A linked machine's user-folder app has no project to tell it apart, so its key is
 * `<machine>:_user/<app id>`; `machine` is ignored with a project, whose id names it already.
 */
export function appKeyOf(ref: AppIdent): string
export function appKeyOf(projectId: string | null | undefined, appId: string, machine?: string | null): string
export function appKeyOf(a: AppIdent | string | null | undefined, appId?: string, machine?: string | null): string {
  const ref: AppIdent = typeof a === 'object' && a !== null ? a : { projectId: a, appId: appId ?? '', machine }
  return ref.machine && ref.projectId == null
    ? `${ref.machine}:${USER_APP_SCOPE}/${ref.appId}`
    : `${ref.projectId ?? USER_APP_SCOPE}/${ref.appId}`
}

/** Neither id can hold `/`, so the first splits it; a project id never holds `:` (a UUID, or `<machine>.<uuid>`) */
export function parseAppKey(
  key: string,
): { projectId: string | null; appId: string; machine?: string } | null {
  const at = key.indexOf('/')
  if (at <= 0 || at === key.length - 1) return null
  const scope = key.slice(0, at)
  const appId = key.slice(at + 1)
  const colon = scope.indexOf(':')
  if (colon >= 0) {
    const machine = scope.slice(0, colon)
    return scope.slice(colon + 1) === USER_APP_SCOPE && MACHINE_ID_RE.test(machine)
      ? { projectId: null, appId, machine }
      : null
  }
  return { projectId: scope === USER_APP_SCOPE ? null : scope, appId }
}

/** `machine`: only the linked machine of a user-folder app; absent or null is this computer */
export type AppIdent = { projectId?: string | null; appId: string; machine?: string | null }

export function sameApp(a: AppIdent, b: AppIdent): boolean {
  if (a.appId !== b.appId || (a.projectId ?? null) !== (b.projectId ?? null)) return false
  return a.projectId != null || (a.machine ?? null) === (b.machine ?? null)
}

/** For a log line: not a key, as two projects can share the eight-character prefix */
export function appLabel(ref: { projectId: string | null; appId: string }): string {
  return `${ref.projectId === null ? 'user' : ref.projectId.slice(0, 8)}/${ref.appId}`
}

/** The whole project id, so the person can tell which project's app was meant */
export function noSuchAppText(ref: { projectId: string | null; appId: string }): string {
  return `There is no such app: ${ref.projectId ?? 'user'}/${ref.appId}`
}
