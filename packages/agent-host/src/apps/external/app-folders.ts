import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { removeDataQuietly } from '../../dev-services/data-folder.js'
import { USER_APP_SCOPE, appKeyOf, type ExternalAppInfo } from '@cc/protocol'
import type { AppLifecycle } from './app-lifecycle.js'
import type { AppEntry } from './app-entry.js'
import { MANIFEST_FILE, MANIFEST_VERSION, appIdRefusal, parseManifest } from './manifest.js'
import { AppFolderTaken, nameTaken, placeAppFolder } from './placement.js'
import type { AppRef } from './ref.js'
import type { ExternalAppsDeps } from './runtime-types.js'
import { appTemplateDir, oneLine, scaffoldApp } from './scaffold.js'
import { AppUnavailableError } from './unavailable.js'
import { realOs } from '../../os/real.js'

/**
 * Making and removing an app folder (M4 A-7, C-1b) — an approved MCP server turned into an app, a
 * new app from the template, and a user-folder app moved to the trash. The bodies of the runtime's
 * doors (`ExternalApps.installUserApp`, `createApp`, `removeUserApp`); where a folder goes and how
 * it is written is `placement.ts`.
 */

/** What these doors reach in the runtime (`ExternalApps.folderHost`) */
export type FoldersHost = {
  disposed(): boolean
  readonly deps: Pick<ExternalAppsDeps, 'dataRoot' | 'reservedIds' | 'projects' | 'templateDir'>
  hasScope(key: string): boolean
  rescan(key: string): void
  refresh(): void
  /** Rescans the user folder right now — scans everything if it has never scanned before */
  rescanUser(): void
  find(ref: AppRef): AppEntry | undefined
  require(ref: AppRef): AppEntry
  info(e: AppEntry): ExternalAppInfo
  dataDirOf(ref: AppRef): string
  /** Apps being removed, by `appKeyOf` — none of them starts again while its folder moves (`blocker`) */
  readonly removing: Set<string>
  readonly lifecycle: AppLifecycle
  /** Drops the imported-app mark (E-3) */
  forgetImport(appId: string): void
}

export type UserAppSpec = { id: string; name: string; description: string; server: { command: string; args: string[] } }
export type NewAppSpec = { projectId: string | null; id: string; name: string; description?: string }
/** Where a new app project goes (#1141): its folder, checked free by the caller, and whether its parent is the default one to make */
export type AppProjectTarget = { path: string; isDefault: boolean }

/**
 * Creates a screen-less app in the user folder (M4 A-7, decision 8): where an MCP server a person approved turns into an app,
 * so it takes the one path every other app takes instead of a separate registry whose calls skip the broker and the run ledger;
 * as a user-folder app it attaches to the Assistant (decision 4). The manifest is built and passed through `parseManifest`
 * before it is written (the id rule of #93 lives there; a reserved id cannot be taken). **An app with the same id:** the same
 * server returns it as-is (an interrupted move can run again), a different one is refused (a person-made app is never
 * overwritten). Written through `placeAppFolder`: a dot-named temp folder, then renamed, so discovery never reads a
 * half-written manifest; the parent goes through the path guard, so an `apps/` that is a link out of the data folder stops it.
 * Rescanned right after writing, as nothing is watched while `apps/` does not exist (watching the data folder wakes on every
 * write to store.db). **This never starts it.**
 */
export function installUserApp(host: FoldersHost, spec: UserAppSpec): ExternalAppInfo {
  if (host.disposed()) throw new AppUnavailableError('The app runtime has shut down')
  const refusal = appIdRefusal(spec.id, host.deps.reservedIds)
  if (refusal) throw new AppUnavailableError(refusal)
  const text = JSON.stringify(
    {
      manifestVersion: MANIFEST_VERSION,
      id: spec.id,
      name: spec.name,
      version: '1.0.0',
      description: spec.description,
      server: { command: spec.server.command, args: spec.server.args },
    },
    null,
    2,
  )
  const parsed = parseManifest(text)
  if (!parsed.ok) throw new AppUnavailableError(`This cannot become an app — ${parsed.error}`)

  host.rescanUser()
  const ref: AppRef = { projectId: null, appId: spec.id }
  const alreadyThere = () => new AppUnavailableError(`Your user folder already has an app "${spec.id}" — use another name, or remove that app first`)
  const held = host.find(ref)
  if (held) {
    const same =
      held.manifest?.server.command === spec.server.command &&
      JSON.stringify(held.manifest.server.args) === JSON.stringify(spec.server.args)
    if (same) return host.info(held)
    throw alreadyThere()
  }

  let dir: string
  try {
    dir = placeAppFolder(host.deps.dataRoot, null, spec.id, (staging) => {
      mkdirSync(staging)
      writeFileSync(join(staging, MANIFEST_FILE), text + '\n')
    })
  } catch (err) {
    // A folder of that id the scan did not take for an app (a broken manifest) belongs to someone too
    if (err instanceof AppFolderTaken) throw alreadyThere()
    throw new AppUnavailableError(`Could not write the app folder: ${(err as Error).message}`)
  }
  mkdirSync(host.dataDirOf(ref), { recursive: true })
  host.rescanUser()
  const made = host.find(ref)
  if (!made) throw new AppUnavailableError(`The app folder was written, but discovery did not find it: ${dir}`)
  return host.info(made)
}

/**
 * Creates a new app from the template (M4 C-1b): "New app" (`apps.create`) and the Assistant's `create_app` use this door. A project app
 * goes to `<project>/.centralu/apps/<id>/` (committed, shared with the team: decision 1's default), a user-folder app (`projectId: null`)
 * to `<data folder>/apps/<id>/`. Refused before the folder is created:
 *   - **the name** (`newAppIdProblem`: #93's characters, the `centralu` reservation and a ban on the `app-` prefix: discovery still reads it in a hand-made app, a new one has no reason to carry it)
 *   - **an untrusted project**: an app there never starts (decision 3), and a building session would spin its wheels on one it can create but never run
 *   - **an id that already exists**: even a folder with an invalid manifest belongs to a person or an agent
 * Written like `installUserApp` (`placeAppFolder`); the parent is created one segment at a time through the path guard (`ensureDirInside`,
 * which stops at a `.centralu` link out of the project). Rescanned right after writing, as watching might not look at that location yet.
 * **This never starts it.**
 */
export function createApp(host: FoldersHost, spec: NewAppSpec): ExternalAppInfo {
  if (host.disposed()) throw new AppUnavailableError('The app runtime has shut down')
  const { name, description } = newAppText(host, spec)

  // Trust is read from the single source of truth (the store) every time this is called — never from the runtime's own copy of scope
  let root = host.deps.dataRoot
  if (spec.projectId !== null) {
    const project = host.deps.projects().find((p) => p.id === spec.projectId)
    if (!project) throw new AppUnavailableError(`There is no such project: ${spec.projectId}`)
    if (!project.trusted) {
      throw new AppUnavailableError('Centralu does not make apps in a project it does not trust — an app is code that runs on this machine, so trust the project first')
    }
    root = project.path
  }
  const key = spec.projectId ?? USER_APP_SCOPE
  if (host.hasScope(key)) host.rescan(key)
  else host.refresh()

  const ref: AppRef = { projectId: spec.projectId, appId: spec.id }
  const exists = (dir: string) => new AppUnavailableError(`An app "${spec.id}" already exists (${dir}) — use another id`)
  const held = host.find(ref)
  if (held) throw exists(held.dir)

  let dir: string
  try {
    dir = placeAppFolder(root, spec.projectId, spec.id, (staging) => {
      scaffoldApp(host.deps.templateDir ?? appTemplateDir(), staging, { id: spec.id, name, description })
    })
  } catch (err) {
    // Even a folder with an invalid manifest belongs to a person or an agent: never overwritten
    if (err instanceof AppFolderTaken) throw exists(err.dir)
    throw new AppUnavailableError(`Could not make the app folder: ${(err as Error).message}`)
  }
  mkdirSync(host.dataDirOf(ref), { recursive: true })
  host.rescan(key)
  const made = host.find(ref)
  if (!made) throw new AppUnavailableError(`The app folder was made, but discovery did not find it: ${dir}`)
  return host.info(made)
}

/** The checks every new app passes before anything is written (C-1b): its id, its name; and the one-line texts it gets */
function newAppText(host: Pick<FoldersHost, 'deps'>, spec: { id: string; name: string; description?: string }): { name: string; description: string } {
  const refusal = appIdRefusal(spec.id, host.deps.reservedIds, { newName: true })
  if (refusal) throw new AppUnavailableError(refusal)
  const name = oneLine(spec.name)
  if (!name) throw new AppUnavailableError('The app needs a name')
  return { name, description: oneLine(spec.description ?? '') || `${name} (a Centralu app)` }
}

/**
 * Writes a new app project's folder (#1141): the template expanded at `target.path`, whose root is then the app. The
 * caller registers it as a project afterwards; until then no scan reads it, and it is written in a dot-named sibling
 * first and renamed into place anyway, so the folder never stands half made. The id and name are refused the same as
 * any new app's, before anything is written; the default parent (`~/Centralu`) is made when missing, a parent the
 * person chose is not. A name taken since the caller checked is refused, never written over. **This starts nothing.**
 */
export function writeAppProject(host: Pick<FoldersHost, 'deps' | 'disposed'>, target: AppProjectTarget, spec: { id: string; name: string; description?: string }): void {
  if (host.disposed()) throw new AppUnavailableError('The app runtime has shut down')
  const { name, description } = newAppText(host, spec)
  const parent = dirname(target.path)
  if (target.isDefault) mkdirSync(parent, { recursive: true })
  if (nameTaken(target.path)) throw new AppUnavailableError(`Something is already at ${target.path} — choose another id or folder`)
  const staging = join(parent, `.${spec.id}.${randomUUID()}`)
  try {
    scaffoldApp(host.deps.templateDir ?? appTemplateDir(), staging, { id: spec.id, name, description })
    if (nameTaken(target.path)) throw new Error(`something appeared at ${target.path} meanwhile`)
    realOs().files.renameSync(staging, target.path)
  } catch (err) {
    removeDataQuietly(staging, '[apps]')
    throw new AppUnavailableError(`Could not make the app folder: ${(err as Error).message}`)
  }
}

/** Where a user-folder app's folder goes in `app-trash/` at this moment (`<id>-<ms>`) */
export function appTrashEntry(dataRoot: string, appId: string, at: number): string {
  return join(dataRoot, 'app-trash', `${appId}-${at}`)
}

/**
 * Where a user-folder app's folder goes when it leaves (`<data folder>/app-trash/<id>-<ms>`): removed from Settings, or
 * given back by a deleted project it had become (#1204). Moved, never deleted: it may be a hand-made app, and a person
 * brings it back by moving it into the user folder again. Returns where it went
 */
export function moveToAppTrash(dataRoot: string, dir: string, appId: string, at = Date.now()): string {
  const trash = join(dataRoot, 'app-trash')
  mkdirSync(trash, { recursive: true })
  const to = appTrashEntry(dataRoot, appId, at)
  realOs().files.renameSync(dir, to)
  return to
}

/**
 * Removes a user-folder app (M4 A-7): the path for withdrawing an approved MCP server from the list. The folder is moved to
 * `app-trash/` in the data folder, not deleted: it could be a hand-made app. The run ledger, data folder and secrets survive
 * (`runs` still reads a removed app's records). **This never removes a project app**: that is a file in a repository, and the
 * place to withdraw it is git. A running app is stopped and waited for **before** the folder moves (#14): Windows refuses to
 * move a folder a process has as its working directory, and an app runs in its own folder, so moving first failed with EBUSY
 * and left the app running. Nothing starts it again meanwhile (`removing`). Rescanned after moving: an attached session
 * detaches (appsChanged); a Claude session drops it from its server set without restarting, a Codex thread keeps the tool name
 * until its next thread, but calling it is refused with "not an attached app" (attaching to a session re-checks on every call).
 */
export async function removeUserApp(host: FoldersHost, ref: AppRef): Promise<void> {
  if (ref.projectId !== null) {
    throw new AppUnavailableError("A project app is part of the project's repository — remove it there")
  }
  host.rescanUser()
  const e = host.require(ref)
  const key = appKeyOf(ref)
  host.removing.add(key)
  try {
    await host.lifecycle.halt(e, 'app removed', { awaitTree: true })
    moveToAppTrash(host.deps.dataRoot, e.dir, ref.appId)
  } finally {
    host.removing.delete(key)
  }
  // Also drops the imported-app mark (E-3) — a folder restored from the trash is one a person moved back by hand (decision 3: a user-folder app is trusted)
  host.forgetImport(ref.appId)
  host.rescanUser()
}
