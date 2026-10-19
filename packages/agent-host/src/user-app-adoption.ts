import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'
import type { ExternalAppInfo } from '@cc/protocol'
import { MANIFEST_FILE, type ExternalApps } from './apps/external/runtime.js'
import type { Store } from './dev-services/store.js'
import type { AdoptedRecord } from './dev-services/store/user-app-adoption.js'

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
 * Each folder once: the store records it, bound to a mark written in the folder (`ADOPTION_MARK`), so a project the
 * person later deletes is not registered again, while a different folder made later under the same name is. Not the
 * folder's file id: Linux (ext4) gives a folder made where one was just removed the same inode, and the same birth
 * time too (a coarse clock), so the new folder read as the deleted project's (#1152, measured under WSL).
 *
 * Not adopted: a folder whose manifest does not pass, or names an id other than its folder (a backup copy such as
 * `notes-copy`): today it is listed `invalid` and never runs, and adopting it would make two runnable apps of one id.
 * It stays in the user folder with its reason, and the log says so once.
 *
 * **A project the person deletes gives its folder back** (#1204), once nothing in the trash could bring it back: no
 * session of it is left there (restoring one registers the project again, at the same path, under the same id) and no
 * project is registered at the folder (the person may have added it again). Until
 * then the folder stays where it is, adopted, so a restore finds it. After, it goes to `<data>/app-trash/` as a
 * removed user-folder app's does, what the project kept for it returns to the user-folder key, and the record goes: a
 * person who moves the folder back into the user folder gets it as a new project, with its data. Left in place, it was
 * listed nowhere and nothing could remove it. Checked at each run (so once the host is ready: a project deleted
 * before this build, or a move a stopped host left half done) and whenever a project is deleted or the trash loses
 * sessions (`settle`).
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
  /** How long a give-back that failed waits before it is tried again (tests shorten it) */
  retryMs?: number
}

/** A give-back that failed is tried again this many times while the host runs, then at the next start */
const GIVE_BACK_RETRIES = 5
const GIVE_BACK_RETRY_MS = 3000

/**
 * Where an adopted folder keeps its mark: in Centralu's own folder inside the project (`.centralu`, where a project's
 * apps live too). A random token, the same as the store's record, so only this very folder carries it; a folder made
 * later under the same name has none
 */
export const ADOPTION_MARK = ['.centralu', 'adopted'] as const

/** The mark in this folder, or null when it has none (or it cannot be read) */
export function adoptionMark(dir: string): string | null {
  try {
    return readFileSync(join(dir, ...ADOPTION_MARK), 'utf8').trim() || null
  } catch {
    return null
  }
}

/**
 * The runtime's `adoptedUserApp`: whether this folder is the very one recorded as registered in place. A record with
 * no mark (written before there was one) matches nothing: the folder is adopted again, in place, which keeps its
 * project (found by its path) and writes the mark
 */
export function adoptedUserApp(store: Pick<Store, 'adoption'>, appId: string, dir: string): boolean {
  const record = store.adoption.adopted()[appId]
  return !!record && adoptionMark(dir) === record.mark
}

/** The runtime's `adoptedProjectOf`: the project a user-folder app of this id became, for its old key */
export function adoptedProjectOf(store: Pick<Store, 'adoption'>, appId: string): string | undefined {
  return store.adoption.adopted()[appId]?.projectId
}

/** A path spelled as a registered project's is: resolved, with a capital drive letter (`ProjectCreation.addProject`) */
const spelled = (path: string) => resolve(path).replace(/^[a-z]:/, (drive) => drive.toUpperCase())

/**
 * Whether a kept path (a project's, a trashed session's) could name this folder (#1204), or null when the folder's own
 * real path cannot be told. It errs toward yes: a folder wrongly kept is only kept, while one wrongly moved is a live
 * project's. Both sides are compared by their real paths (`realFolder`), so a project added through a symbolic link, a
 * junction, a `subst` drive or a short name is the same folder, and with ASCII case folded on every system (a
 * case-sensitive disk may keep one folder too many). A project inside the folder counts too: the folder would move from
 * under it. A kept path whose real path cannot be told counts as this folder (a drive not there now, a link loop, no
 * access), and so does a UNC path, which is never resolved: a share may not answer
 */
function folderMatcher(dir: string): ((kept: string) => boolean) | null {
  const fold = (path: string) => path.replace(/[A-Z]/g, (c) => c.toLowerCase())
  const real = realFolder(dir)
  if (real === null) return null
  const near = [fold(resolve(dir)), fold(real)]
  /** The folder itself, or something inside it */
  const within = (path: string) => near.some((n) => path === n || path.startsWith(n.endsWith(sep) ? n : n + sep))
  return (kept) => {
    const k = resolve(kept)
    if (within(fold(k)) || k.startsWith('\\\\')) return true
    const r = realFolder(k)
    return r === null || within(fold(r))
  }
}

/**
 * A path's real path, through the nearest folder that exists (a project folder may be gone); null when it cannot be told:
 * any error but "not there" (no access, a link loop, a drive that does not answer)
 */
function realFolder(path: string): string | null {
  const full = resolve(path)
  try {
    return realpathSync.native(full)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') return null
    const parent = dirname(full)
    // A root that is not there (a drive unplugged, a `subst` gone since a restart) says nothing of where it pointed
    if (parent === full) return null
    const up = realFolder(parent)
    return up === null ? null : join(up, basename(full))
  }
}

export class UserAppAdoption {
  private running: Promise<number> | null = null
  private again = false
  /** Apps whose adoption failed in this host's life — tried again at the next start, not on every list change */
  private failed = new Set<string>()
  /** Apps left in the user folder, by their reason — said once, not on every list change */
  private said = new Map<string, string>()
  private swept = false
  /** Set by the first run, once the host is ready: `settle` does nothing before, as nothing may move while a swap can still hand back */
  private ready = false
  /** Give-backs that failed, by app id, and how many times */
  private readonly retries = new Map<string, number>()

  constructor(private readonly deps: AdoptionDeps) {}

  /** Adopts every user-folder app the runtime lists now; the number adopted. Runs one at a time; a call meanwhile runs once more after */
  run(): Promise<number> {
    this.ready = true
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

  /**
   * A project was deleted, or sessions left the trash for good (#1204): gives back the folders of deleted projects that
   * nothing in the trash can restore any more. Only once the host is ready (the first `run`); that run checks too
   */
  settle(): Promise<void> {
    if (!this.ready) return Promise.resolve()
    // A run under way may have read the trash before this change: a run of its own after it
    const prior = this.running
    return (prior ? prior.catch(() => 0).then(() => this.run()) : this.run()).then(
      () => undefined,
      (e: Error) => console.error(`[apps] giving back the folders of deleted projects failed: ${e.message}`),
    )
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
    await this.giveBack()
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

  /**
   * Whether the folder this record names is free to give back: its project is gone, no other project is registered at
   * the folder (the person may have added it again), and nothing in the trash would register one there
   */
  private released(record: AdoptedRecord, dir: string): boolean {
    const projects = this.deps.store.projects.listProjects()
    if (projects.some((p) => p.id === record.projectId) || this.deps.store.trash.holdsProject(record.projectId)) return false
    const here = folderMatcher(dir)
    if (!here) return false
    return !projects.some((p) => here(p.path)) && !this.deps.store.trash.trashedProjectPaths().some(here)
  }

  /** The folders of deleted projects that nothing in the trash can restore, given back (`ExternalApps.returnAdoptedApp`) */
  private async giveBack(): Promise<void> {
    let records: [string, AdoptedRecord][] = []
    try {
      records = Object.entries(this.deps.store.adoption.adopted())
    } catch (e) {
      console.error(`[apps] could not read which folders became projects: ${(e as Error).message}`)
      return
    }
    for (const [appId, record] of records) {
      const dir = this.deps.rt.userAppDir(appId)
      try {
        if (!this.released(record, dir)) continue
        await this.deps.rt.projectStopped(record.projectId)
        /*
         * Checked again with nothing awaited from here to the move: a session restored, or the folder added as a
         * project, while its apps stopped keeps it. A folder there that is not the one the project was made from
         * (no mark, or another) is someone else's: nothing of it is touched, and its own adoption follows
         */
        if (!this.released(record, dir)) continue
        if (existsSync(dir) && adoptionMark(dir) !== record.mark) continue
        const to = this.deps.rt.returnAdoptedApp(record.projectId, appId)
        this.deps.store.adoption.forget(appId, record.mark)
        this.retries.delete(appId)
        console.error(`[apps] deleted project ${record.projectId} gave back user-folder app ${appId}${to ? `: its folder is in ${to}` : ''}`)
      } catch (e) {
        // Kept as it was; tried again shortly (a folder a process still works in does not move on Windows), then at the next start
        const tries = (this.retries.get(appId) ?? 0) + 1
        this.retries.set(appId, tries)
        const again = tries <= GIVE_BACK_RETRIES
        console.error(`[apps] deleted project ${record.projectId} could not give back user-folder app ${appId} yet${again ? '' : ' (tried again at the next start)'}: ${(e as Error).message}`)
        if (again) setTimeout(() => void this.settle(), this.deps.retryMs ?? GIVE_BACK_RETRY_MS).unref()
      }
    }
  }

  private adopt(app: ExternalAppInfo): void {
    const path = spelled(app.dir)
    // An import the person has not enabled stays off: its project starts untrusted, and trusting it is enabling it
    const held = app.status === 'unconfirmed' || (app.imported !== undefined && app.imported.confirmedAt === null)
    const known = this.deps.store.projects.findProjectByPath(path)?.id
    const projectId = known ?? randomUUID()
    // The files first: copies, made only where the new key has none, so an interrupted run repeats them harmlessly
    this.deps.rt.carryAppState({ projectId: null, appId: app.appId }, { projectId, appId: app.appId })
    // The mark before the record: a mark the record never took (a failed transaction) is replaced by the next attempt
    const mark = randomUUID()
    mkdirSync(join(app.dir, ADOPTION_MARK[0]), { recursive: true })
    writeFileSync(join(app.dir, ...ADOPTION_MARK), `${mark}\n`)
    this.retries.delete(app.appId)
    const moved = this.deps.store.adoption.carry(app.appId, { path, name: basename(path), trusted: !held, newId: projectId }, mark)
    this.deps.sessionsMoved(moved.sessions, moved.projectId)
    console.error(`[apps] user-folder app ${app.appId} is now the app of project ${moved.projectId} (${path})${held ? ', untrusted until enabled' : ''}`)
  }
}
