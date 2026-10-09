import { useMemo } from 'react'
import type { ExternalAppInfo } from '@cc/protocol'
import { externalAppKey, useStore } from './store.js'

/**
 * One app registry (M4 A-8) — the external apps the host discovered, as a single list.
 *
 * An external app is a folder and a process the host discovered, so it has a scope (project or
 * user folder) and a status (starting, stopped, why). The screens (the app list in Settings, an
 * app's row in the sidebar, a pinned screen, a grid panel) all need to ask "what is this app, and
 * how is it right now" in one place. If each screen read the host's list on its own, the rule for
 * reading status (e.g. an app in an untrusted project cannot be opened) would have to exist once
 * per screen, and one of them would eventually drift out of sync.
 *
 * There used to be a second kind in this list, the compiled built-in app (`control`, the rail).
 * It was removed in #97, so every entry here is an external app.
 */

/** Turns status into the shape shown to a person. The judgment lives in this one place */
export type AppStatusView = {
  /** One or two words — used by the list and the sidebar row */
  label: string
  /** Why it is this way. null for a status with no reason (floating, resting) */
  reason: string | null
  /** Can it be opened right now. If not, the reason and the action to take (trust it, restart it) are shown instead of the screen */
  runnable: boolean
  /** Brightness in the list — only something blocked that the person needs to see is bright (the palette rule) */
  tone: 'quiet' | 'busy' | 'alert'
}

export type ExternalCatalogApp = {
  kind: 'external'
  /** `externalAppKey` — an app is uniquely identified by (project, id) */
  key: string
  appId: string
  /** null means a user-folder app */
  projectId: string | null
  /** The name from the manifest, or the folder name if there is none (a broken manifest) */
  title: string
  info: ExternalAppInfo
  status: AppStatusView
}

export type AppCatalog = {
  external: ExternalCatalogApp[]
  /** project id → that project's apps (alphabetical) */
  byProject: Record<string, ExternalCatalogApp[]>
  /** The user folder's apps (alphabetical), this computer's only */
  user: ExternalCatalogApp[]
  /** Each linked machine's user-folder apps (#82), grouped under that machine in the sidebar */
  byMachine: Record<string, ExternalCatalogApp[]>
}

export const UNTRUSTED_REASON = "This project isn't trusted, so its apps don't run."

/**
 * A user-folder app on a linked machine (#82): listed, and its tools work for that machine's sessions, but its pinned
 * view cannot open here yet: everything that opens one names an app by project and id, and a user-folder app has no
 * project to say which machine (docs/plans/remote-hub.md §11). Its views inside that machine's conversations do open.
 * A project app on a linked machine opens like this computer's (§11). Said where the view would stand.
 */
export const REMOTE_APP_REASON =
  "Another machine's own apps open here in a later version of Centralu. Their tools already work for the sessions on that machine, and their views show in those conversations."

/** A user-folder app of a linked machine: listed, its pinned view not openable here yet */
export function isRemoteUserApp(info: ExternalAppInfo): boolean {
  return !!info.machine && info.projectId === null
}

export function appStatus(info: ExternalAppInfo): AppStatusView {
  // Before its own status: whatever state it is in there, its pinned view cannot open here yet
  if (isRemoteUserApp(info)) return { label: 'Later version', reason: REMOTE_APP_REASON, runnable: false, tone: 'quiet' }
  switch (info.status) {
    case 'running':
      return { label: 'Running', reason: null, runnable: true, tone: 'quiet' }
    case 'stopped':
      return { label: 'Stopped', reason: null, runnable: true, tone: 'quiet' }
    case 'starting':
      return { label: 'Starting', reason: null, runnable: true, tone: 'busy' }
    case 'crashed':
      // Comes back up on the next call (after backing off) — it can still be opened
      return { label: 'Crashed', reason: info.error, runnable: true, tone: 'alert' }
    case 'failed':
      return { label: 'Failed', reason: info.error ?? 'It failed to start several times in a row.', runnable: false, tone: 'alert' }
    case 'untrusted':
      return { label: 'Not trusted', reason: UNTRUSTED_REASON, runnable: false, tone: 'quiet' }
    case 'unconfirmed':
      /*
       * An imported app is waiting on the person's review (M4 E-3) — either it just arrived and
       * has not been enabled yet, or after being enabled, what it runs (server) or what it claims
       * to use (uses) changed. Both are resolved only once the person looks and enables it. The
       * reason is the host's own wording.
       */
      return {
        label: info.imported?.confirmedAt ? 'Needs review' : 'Not enabled',
        reason: info.error ?? 'This app was imported and is not enabled yet.',
        runnable: false,
        tone: 'alert',
      }
    case 'invalid':
      return { label: 'Invalid', reason: info.error ?? 'The app manifest could not be read.', runnable: false, tone: 'alert' }
  }
}

const byTitle = (a: ExternalCatalogApp, b: ExternalCatalogApp) => a.title.localeCompare(b.title) || a.appId.localeCompare(b.appId)

/**
 * A pure computation — shared by the hook and the tests.
 *
 * The order is alphabetical. There is no place yet to write a drag-to-reorder order on the host,
 * the way there is for sessions, and discovery order (the order folders were read in) differs by
 * filesystem, which could shuffle the sidebar's rows on every startup.
 */
export function buildCatalog(external: readonly ExternalAppInfo[]): AppCatalog {
  const ext: ExternalCatalogApp[] = external.map((info) => ({
    kind: 'external',
    /*
     * A linked machine's user-folder app has no project to tell it from this computer's app of the same id (both read
     * `_user/<id>`), so its key names the machine (#82). A project app's key already does: its project id is qualified.
     */
    key:
      info.machine && !info.projectId ? `${info.machine}:${externalAppKey(null, info.appId)}` : externalAppKey(info.projectId, info.appId),
    appId: info.appId,
    projectId: info.projectId,
    title: info.name ?? info.appId,
    info,
    status: appStatus(info),
  }))
  ext.sort(byTitle)
  const byProject: Record<string, ExternalCatalogApp[]> = {}
  const user: ExternalCatalogApp[] = []
  const byMachine: Record<string, ExternalCatalogApp[]> = {}
  for (const a of ext) {
    if (a.projectId !== null) (byProject[a.projectId] ??= []).push(a)
    else if (a.info.machine) (byMachine[a.info.machine] ??= []).push(a)
    else user.push(a)
  }
  return {
    external: ext,
    byProject,
    user,
    byMachine,
  }
}

export function useAppCatalog(): AppCatalog {
  const external = useStore((s) => s.externalApps)
  return useMemo(() => buildCatalog(external), [external])
}

const NONE: ExternalCatalogApp[] = []

/** A single project's apps — used by the project's block in the sidebar */
export function useProjectApps(projectId: string): ExternalCatalogApp[] {
  const external = useStore((s) => s.externalApps)
  return useMemo(() => buildCatalog(external).byProject[projectId] ?? NONE, [external, projectId])
}

/** The user folder's apps — since they do not belong to a project, they get their own group in the sidebar */
export function useUserApps(): ExternalCatalogApp[] {
  const external = useStore((s) => s.externalApps)
  return useMemo(() => buildCatalog(external).user, [external])
}

/** A linked machine's user-folder apps (#82) */
export function useMachineApps(machine: string): ExternalCatalogApp[] {
  const external = useStore((s) => s.externalApps)
  return useMemo(() => buildCatalog(external).byMachine[machine] ?? NONE, [external, machine])
}

/** A single app — undefined if it is gone (the folder disappeared, the project was deleted) */
export function useExternalApp(projectId: string | null, appId: string): ExternalCatalogApp | undefined {
  const external = useStore((s) => s.externalApps)
  return useMemo(() => {
    // This computer's, for a user-folder app: another machine's has no view to open here (#82)
    const info = external.find((a) => a.appId === appId && a.projectId === projectId && (projectId !== null || !a.machine))
    return info ? buildCatalog([info]).external[0] : undefined
  }, [external, projectId, appId])
}
