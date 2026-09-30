import { useMemo } from 'react'
import type { ExternalAppInfo } from '@cc/protocol'
import type { AppModule } from '../apps/contract.js'
import { APPS } from '../apps/registry.js'
import { externalAppKey, useStore, type AppState } from './store.js'

/**
 * One app registry (M4 A-8) — built-in apps and external apps as a single list.
 *
 * The two live differently. A built-in app (`control`) is a compiled module, and the only thing
 * to do with it is turn it on or off. An external app is a folder and a process the host
 * discovered, so it has a scope (project or user folder) and a status (starting, stopped, why).
 * Even so, the screens (the app list in Settings, an app's row in the sidebar, a pinned screen)
 * all need to ask "what is this app, and how is it right now" in one place. If each screen read
 * the two sources separately and merged them, the rule for reading status (e.g. an app in an
 * untrusted project cannot be opened) would have to exist once per screen, and one of them would
 * eventually drift out of sync.
 *
 * Why this file lives outside the store: the store does not know about the built-in app registry
 * (registry → app → api → host must not cycle, #97). This file only reads both the registry and
 * the store.
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

export type BuiltinCatalogApp = {
  kind: 'builtin'
  key: string
  appId: string
  title: string
  module: AppModule
  enabled: boolean
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
  builtin: BuiltinCatalogApp[]
  external: ExternalCatalogApp[]
  /** project id → that project's apps (alphabetical) */
  byProject: Record<string, ExternalCatalogApp[]>
  /** The user folder's apps (alphabetical) */
  user: ExternalCatalogApp[]
}

export const UNTRUSTED_REASON = "This project isn't trusted, so its apps don't run."

export function appStatus(info: ExternalAppInfo): AppStatusView {
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
export function buildCatalog(
  builtins: readonly AppModule[],
  builtinState: AppState['apps'],
  external: readonly ExternalAppInfo[],
): AppCatalog {
  const ext: ExternalCatalogApp[] = external.map((info) => ({
    kind: 'external',
    key: externalAppKey(info.projectId, info.appId),
    appId: info.appId,
    projectId: info.projectId,
    title: info.name ?? info.appId,
    info,
    status: appStatus(info),
  }))
  ext.sort(byTitle)
  const byProject: Record<string, ExternalCatalogApp[]> = {}
  const user: ExternalCatalogApp[] = []
  for (const a of ext) {
    if (a.projectId === null) user.push(a)
    else (byProject[a.projectId] ??= []).push(a)
  }
  return {
    builtin: builtins.map((m) => ({
      kind: 'builtin',
      key: `builtin/${m.id}`,
      appId: m.id,
      title: m.title,
      module: m,
      enabled: builtinState[m.id]?.enabled ?? true,
    })),
    external: ext,
    byProject,
    user,
  }
}

export function useAppCatalog(): AppCatalog {
  const builtinState = useStore((s) => s.apps)
  const external = useStore((s) => s.externalApps)
  return useMemo(() => buildCatalog(APPS, builtinState, external), [builtinState, external])
}

const NONE: ExternalCatalogApp[] = []

/** A single project's apps — used by the project's block in the sidebar */
export function useProjectApps(projectId: string): ExternalCatalogApp[] {
  const external = useStore((s) => s.externalApps)
  return useMemo(() => buildCatalog([], {}, external).byProject[projectId] ?? NONE, [external, projectId])
}

/** The user folder's apps — since they do not belong to a project, they get their own group in the sidebar */
export function useUserApps(): ExternalCatalogApp[] {
  const external = useStore((s) => s.externalApps)
  return useMemo(() => buildCatalog([], {}, external).user, [external])
}

/** A single app — undefined if it is gone (the folder disappeared, the project was deleted) */
export function useExternalApp(projectId: string | null, appId: string): ExternalCatalogApp | undefined {
  const external = useStore((s) => s.externalApps)
  return useMemo(() => {
    const info = external.find((a) => a.appId === appId && a.projectId === projectId)
    return info ? buildCatalog([], {}, [info]).external[0] : undefined
  }, [external, projectId, appId])
}
