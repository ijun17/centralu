import { useMemo } from 'react'
import { appKeyOf } from '@cc/core'
import type { ExternalAppInfo } from '@cc/protocol/client'
import { isApp, useStore } from './store.js'
import { appTitleOf, machineNameOf } from './names.js'

// The one app registry every screen reads (M4 A-8), so the rule for reading an app's status exists once.

export type AppStatusView = {
  label: string
  reason: string | null
  /** If not, the reason and its action (trust it, restart it) show instead of the screen */
  runnable: boolean
  /** Only something blocked that the person needs to see is bright */
  tone: 'quiet' | 'busy' | 'alert'
}

export type ExternalCatalogApp = {
  kind: 'external'
  key: string
  appId: string
  /** null: a user-folder app */
  projectId: string | null
  title: string
  info: ExternalAppInfo
  status: AppStatusView
}

export type AppCatalog = {
  external: ExternalCatalogApp[]
  byProject: Record<string, ExternalCatalogApp[]>
  /** This computer's only */
  user: ExternalCatalogApp[]
  /** Linked machines' user-folder apps (#82) */
  byMachine: Record<string, ExternalCatalogApp[]>
}

export const UNTRUSTED_REASON = "This project isn't trusted, so its apps don't run."

/**
 * It has no project to name its machine, so whatever opens it names the machine too (`openApp`'s `machine`); a project
 * app's qualified project id already does (docs/plans/remote-hub.md §11).
 */
export function isRemoteUserApp(info: ExternalAppInfo): boolean {
  return !!info.machine && info.projectId === null
}

// The `machine` an app's own calls name (runs, secrets, versions, the builder, Restart)
export function userAppMachine(info: ExternalAppInfo): string | undefined {
  return isRemoteUserApp(info) ? (info.machine ?? undefined) : undefined
}

type MachineNames = Readonly<Record<string, { name: string }>>

export function appStatus(info: ExternalAppInfo, machines: MachineNames = {}): AppStatusView {
  /*
   * Turned off on its computer (#1938) reads `stopped` only when off is what stops it; invalid, untrusted or not
   * enabled reads first, in the host's `blocker` order, so the row names what turning it on would not fix.
   */
  if (info.off === true && info.status === 'stopped') {
    const where = info.machine ? `${machineNameOf(machines, info.machine)}, so it does not start there` : 'this computer, so it does not start here'
    return { label: 'Off', reason: `It is turned off on ${where}. Turn it on in Settings → Apps.`, runnable: false, tone: 'quiet' }
  }
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
       * An imported app waits on review (M4 E-3): new, or its `server` or `uses` changed since it was enabled. One
       * without an import mark (#1172: the import record could not be read) may have been enabled: "Needs review".
       */
      return {
        label: !info.imported || info.imported.confirmedAt ? 'Needs review' : 'Not enabled',
        reason: info.error ?? 'This app was imported and is not enabled yet.',
        runnable: false,
        tone: 'alert',
      }
    case 'invalid':
      return { label: 'Invalid', reason: info.error ?? 'The app manifest could not be read.', runnable: false, tone: 'alert' }
  }
}

const byTitle = (a: ExternalCatalogApp, b: ExternalCatalogApp) => a.title.localeCompare(b.title) || a.appId.localeCompare(b.appId)

// Alphabetical: the host stores no app order, and discovery order differs by filesystem
export function buildCatalog(external: readonly ExternalAppInfo[], machines: MachineNames = {}): AppCatalog {
  const ext: ExternalCatalogApp[] = external.map((info) => ({
    kind: 'external',
    // Both machines' user-folder apps read `_user/<id>`, so a linked machine's key names it (#82)
    key:
      info.machine && !info.projectId ? `${info.machine}:${appKeyOf(null, info.appId)}` : appKeyOf(info.projectId, info.appId),
    appId: info.appId,
    projectId: info.projectId,
    title: appTitleOf(info),
    info,
    status: appStatus(info, machines),
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

// By the key a sidebar row and so a dragged panel carries: a grid drop is looked up here
export function catalogByKey(external: readonly ExternalAppInfo[]): Map<string, ExternalCatalogApp> {
  return new Map(buildCatalog(external).external.map((a) => [a.key, a] as const))
}

export function useAppCatalog(): AppCatalog {
  const external = useStore((s) => s.externalApps)
  const machines = useStore((s) => s.machines)
  return useMemo(() => buildCatalog(external, machines), [external, machines])
}

const NONE: ExternalCatalogApp[] = []

export function useProjectApps(projectId: string): ExternalCatalogApp[] {
  const external = useStore((s) => s.externalApps)
  const machines = useStore((s) => s.machines)
  return useMemo(() => buildCatalog(external, machines).byProject[projectId] ?? NONE, [external, machines, projectId])
}

// Every machine's (#734): a linked machine's stand among this computer's, by title
export function useUserApps(): ExternalCatalogApp[] {
  const external = useStore((s) => s.externalApps)
  const machines = useStore((s) => s.machines)
  return useMemo(() => buildCatalog(external, machines).external.filter((a) => a.projectId === null), [external, machines])
}

export function useExternalApp(projectId: string | null, appId: string, machine?: string | null): ExternalCatalogApp | undefined {
  const external = useStore((s) => s.externalApps)
  const machines = useStore((s) => s.machines)
  return useMemo(() => {
    const info = external.find((a) => isApp(a, projectId, appId, machine))
    return info ? buildCatalog([info], machines).external[0] : undefined
  }, [external, machines, projectId, appId, machine])
}

/**
 * A view's HTML is the app's code, so it comes down when the app is untrusted, invalid, back in review or turned off
 * (B-2, #1938). A failed or crashed app's view stays: its Restart is there. The host's `unavailable` is the same list.
 */
export function viewMustClose(info: ExternalAppInfo): boolean {
  return info.status === 'untrusted' || info.status === 'invalid' || info.status === 'unconfirmed' || info.off === true
}

// `uses-lines.ts` imports nothing of the store
export { appCanLines, usesLines } from './uses-lines.js'
