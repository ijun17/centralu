import { randomUUID } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import type { ExternalAppInfo } from '@cc/protocol'
import { MANIFEST_FILE, type ExternalApps } from './apps/external/runtime.js'
import type { Store } from './dev-services/store.js'

/**
 * User-folder apps become projects (#1141, docs/plans/root-apps.md §4). Each `<data>/apps/<id>/` whose manifest is
 * valid and names its folder's id is registered as a project **in place**, and is that project's root app from then
 * on; what was kept under its old key (`_user/<id>`) is carried to the new one (`<project id>/<id>`): the files by the
 * app runtime (`ExternalApps.carryAppState`: data, logs, versions, secrets), the rest by the store, in the same
 * transaction that registers the project (`store.adoption.carry`: grants, runs, sessions, builder, attachments, grid
 * panels, view port, the window's span and open app).
 *
 * **When**: once the host is ready (main.ts, where the steps a swap left for later run). A host that fails before ready
 * hands back to the previous build without having moved anything, so the copies are taken from what that build last
 * wrote. The manager has loaded its sessions by then, so the ones moved are handed to it (`sessionsMoved`), which
 * updates them and tells the windows: the builder is found under the new key in this same run. It runs again whenever
 * the user folder gains an app (an MCP server the person approved is written there).
 *
 * Each folder once: the store records it, bound to the folder's file id, so a project the person later deletes is not
 * registered again, while a different folder made later under the same name is.
 *
 * Not adopted: a folder whose manifest does not pass, or names an id other than its folder (a backup copy such as
 * `notes-copy`): today it is listed `invalid` and never runs, and adopting it would make two runnable apps of one id.
 * It stays in the user folder with its reason, and the log says so once.
 *
 * Trust: the project is trusted, as the user folder was, except for an imported app the person never enabled (or
 * whose command or uses changed since): its project starts untrusted, and trusting it is enabling it. A folder that is
 * already a project keeps whatever trust the person gave it.
 */

export type AdoptionDeps = {
  rt: ExternalApps
  store: Store
  /** Sessions now in the project (its builder, its agents): the manager updates the ones it holds and tells the windows */
  sessionsMoved(sessionIds: readonly string[], projectId: string): void
  /** The project list changed — the windows re-read it */
  changed(): void
}

/** The folder's file id, exact (bigint), or null when it cannot be read */
export function folderFileId(dir: string): string | null {
  try {
    return statSync(dir, { bigint: true }).ino.toString()
  } catch {
    return null
  }
}

/** The runtime's `adoptedUserApp`: whether this folder is the very one recorded as registered in place */
export function adoptedUserApp(store: Pick<Store, 'adoption'>, appId: string, dir: string): boolean {
  const record = store.adoption.adopted()[appId]
  return !!record && record.ino === folderFileId(dir)
}

/** A path spelled as a registered project's is: resolved, with a capital drive letter (`ProjectCreation.addProject`) */
const spelled = (path: string) => resolve(path).replace(/^[a-z]:/, (drive) => drive.toUpperCase())

export class UserAppAdoption {
  private running: Promise<number> | null = null
  private again = false
  /** Apps whose adoption failed in this host's life — tried again at the next start, not on every list change */
  private failed = new Set<string>()
  /** Apps left in the user folder, by their reason — said once, not on every list change */
  private said = new Map<string, string>()
  private swept = false

  constructor(private readonly deps: AdoptionDeps) {}

  /** Adopts every user-folder app the runtime lists now; the number adopted. Runs one at a time; a call meanwhile runs once more after */
  run(): Promise<number> {
    if (this.running) {
      this.again = true
      return this.running
    }
    this.running = this.adoptAll().finally(() => {
      this.running = null
      if (this.again) {
        this.again = false
        void this.run()
      }
    })
    return this.running
  }

  /** Adopts what appears later (an approved MCP server written to the user folder). Returns the unsubscribe */
  watch(): () => void {
    return this.deps.rt.onAppsChanged(() => {
      if (this.waiting().length > 0) void this.run()
    })
  }

  private waiting(): ExternalAppInfo[] {
    return this.deps.rt.list().filter((a) => {
      if (a.projectId !== null || a.machine || this.failed.has(a.appId) || !existsSync(join(a.dir, MANIFEST_FILE))) return false
      if (a.status !== 'invalid') return true
      if (this.said.get(a.appId) !== a.error) {
        this.said.set(a.appId, a.error ?? '')
        console.error(`[apps] user-folder app ${a.appId} stays in the user folder, not made a project: ${a.error ?? 'its manifest is invalid'}`)
      }
      return false
    })
  }

  private async adoptAll(): Promise<number> {
    if (!this.swept) {
      this.swept = true
      try {
        this.deps.rt.sweepCarryLeftovers()
      } catch (e) {
        console.error(`[apps] could not sweep half copies an interrupted move left: ${(e as Error).message}`)
      }
    }
    let adopted = 0
    for (const app of this.waiting()) {
      try {
        this.adopt(app)
        adopted++
      } catch (e) {
        this.failed.add(app.appId)
        console.error(`[apps] could not make user-folder app ${app.appId} a project (${app.dir}); it stays in the user folder: ${(e as Error).message}`)
      }
    }
    if (adopted > 0) {
      this.deps.rt.refresh()
      this.deps.changed()
    }
    return adopted
  }

  private adopt(app: ExternalAppInfo): void {
    const ino = folderFileId(app.dir)
    if (ino === null) throw new Error('its folder cannot be read')
    const path = spelled(app.dir)
    // An import the person has not enabled stays off: its project starts untrusted, and trusting it is enabling it
    const held = app.status === 'unconfirmed' || (app.imported !== undefined && app.imported.confirmedAt === null)
    const known = this.deps.store.projects.findProjectByPath(path)?.id
    const projectId = known ?? randomUUID()
    // The files first: copies, made only where the new key has none, so an interrupted run repeats them harmlessly
    this.deps.rt.carryAppState({ projectId: null, appId: app.appId }, { projectId, appId: app.appId })
    const moved = this.deps.store.adoption.carry(app.appId, { path, name: basename(path), trusted: !held, newId: projectId }, ino)
    this.deps.sessionsMoved(moved.sessions, moved.projectId)
    console.error(`[apps] user-folder app ${app.appId} is now the app of project ${moved.projectId} (${path})${held ? ', untrusted until enabled' : ''}`)
  }
}
