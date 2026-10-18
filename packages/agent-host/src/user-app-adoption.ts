import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ExternalAppInfo, ProjectInfo } from '@cc/protocol'
import { MANIFEST_FILE, type ExternalApps } from './apps/external/runtime.js'
import type { Store } from './dev-services/store.js'

/**
 * User-folder apps become projects (#1141, docs/plans/root-apps.md §4). Each `<data>/apps/<id>/` that holds a
 * manifest is registered as a project **in place**, and is that project's root app from then on; what was kept under
 * its old key (`_user/<id>`) is carried to the new one (`<project id>/<id>`): the files by the app runtime
 * (`ExternalApps.carryAppState`: data, logs, versions, secrets), the rest by the store (`store.adoption.carry`:
 * grants, runs, sessions, builder, attachments, grid panels, view port, the window's span and open app).
 *
 * Runs when the host starts, and again whenever the user folder gains an app (an MCP server the person approved is
 * written there). Each folder once: the store records it, bound to the folder's file id, so a project the person later
 * deletes is not registered again, while a different folder made later under the same name is.
 *
 * Trust: the project is trusted, as the user folder was, except for an imported app the person never enabled (or
 * whose command or uses changed since): its project starts untrusted, and trusting it is enabling it. A folder that is
 * already a project keeps whatever trust the person gave it.
 */

export type AdoptionDeps = {
  rt: ExternalApps
  store: Store
  /** Registers a folder as a project (`ProjectCreation.addProject`); a folder already registered is returned as it is */
  addProject(path: string, opts: { trusted?: boolean }): Promise<ProjectInfo>
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

export class UserAppAdoption {
  private running: Promise<number> | null = null
  private again = false
  /** Apps whose adoption failed in this host's life — tried again at the next start, not on every list change */
  private failed = new Set<string>()

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
    return this.deps.rt.list().filter((a) => a.projectId === null && !a.machine && !this.failed.has(a.appId) && existsSync(join(a.dir, MANIFEST_FILE)))
  }

  private async adoptAll(): Promise<number> {
    let adopted = 0
    for (const app of this.waiting()) {
      try {
        await this.adopt(app)
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

  private async adopt(app: ExternalAppInfo): Promise<void> {
    const ino = folderFileId(app.dir)
    if (ino === null) throw new Error('its folder cannot be read')
    // An import the person has not enabled stays off: its project starts untrusted, and trusting it is enabling it
    const held = app.status === 'unconfirmed' || (app.imported !== undefined && app.imported.confirmedAt === null)
    const project = await this.deps.addProject(app.dir, held ? {} : { trusted: true })
    this.deps.rt.carryAppState({ projectId: null, appId: app.appId }, { projectId: project.id, appId: app.appId })
    this.deps.store.adoption.carry(app.appId, project.id, ino)
    console.error(`[apps] user-folder app ${app.appId} is now the app of project ${project.id} (${app.dir})${held ? ', untrusted until enabled' : ''}`)
  }
}
