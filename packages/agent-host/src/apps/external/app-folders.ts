import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { removeDataQuietly } from '../../dev-services/data-folder.js'
import { APP_ID_MAX_LENGTH, APP_SERVER_PREFIX, RESERVED_NAME_PREFIX, USER_APP_SCOPE, newAppIdProblem, type ExternalAppInfo, type NewAppIdProblem } from '@cc/protocol'
import type { AppLifecycle } from './app-lifecycle.js'
import type { AppEntry } from './app-entry.js'
import { PROJECT_APPS_PARTS, USER_APPS_PARTS } from './discovery.js'
import { MANIFEST_FILE, MANIFEST_VERSION, parseManifest } from './manifest.js'
import { placeAppFolder } from './placement.js'
import type { AppRef } from './ref.js'
import type { ExternalAppsDeps } from './runtime-types.js'
import { appTemplateDir, oneLine, scaffoldApp } from './scaffold.js'
import { AppUnavailableError } from './unavailable.js'

/**
 * Making and removing an app folder (M4 A-7, C-1b) — an approved MCP server turned into an app, a
 * new app from the template, and a user-folder app moved to the trash. The bodies of the runtime's
 * doors (`ExternalApps.installUserApp`, `createApp`, `removeUserApp`); where a folder goes and how
 * it is written is `placement.ts`.
 */

const USER_SCOPE = USER_APP_SCOPE

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
  holdKey(ref: AppRef): string
  /** Apps being removed, by `holdKey` — none of them starts again while its folder moves (`blocker`) */
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
 * The reason a new app id is rejected, worded for an agent and a person to read (C-1b). Validation is
 * one single function (`newAppIdProblem`, @cc/protocol) — only the wording is attached here. The new
 * app dialog attaches its own wording to the same validation result (`appIdHint`), while the
 * orchestrator's `create_app` reads this wording as-is.
 */
const APP_ID_PROBLEM: Record<NewAppIdProblem, string> = {
  shape: `an app id is lowercase letters, digits and hyphens (up to ${APP_ID_MAX_LENGTH}), starting with a letter or digit — no underscores: "__" separates names in a session's tool names`,
  reserved: `ids starting with "${RESERVED_NAME_PREFIX}" belong to Centralu itself`,
  'server-prefix': `ids starting with "${APP_SERVER_PREFIX}" are how apps attach to sessions — pick another`,
  builtin: 'that id is reserved — pick another',
}

/**
 * Creates a screen-less app in the user folder (M4 A-7, decision 8) — where an MCP server a person
 * approved turns into an app.
 *
 * If an approved server lived in a separate registry (app_settings), the approval flow and the
 * attach path would both be duplicated. That server's calls never went through the broker, were
 * never recorded, and could not even be removed from a list. Becoming an app puts it on the same one
 * path every other app takes (audience, the run ledger, starting only when first needed, stopping
 * when idle). Since it is a user-folder app, it attaches to the orchestrator (decision 4 — the same
 * place a previously approved server used to attach).
 *
 * Validation is the same single set discovery uses: a manifest is built and passed through
 * `parseManifest` before it is written (the id rule from #93 lives there too). A reserved id
 * cannot be taken. **If an app with the same id already exists** — if it is the same server, that
 * app is returned as-is (calling this again produces the same result: when a move was interrupted
 * partway and runs again), and if different, this refuses (a person-made app is never overwritten).
 *
 * How it is written: through `placeAppFolder` — to a temp folder starting with a dot (skipped by
 * discovery), then renamed, so there is never a moment where discovery could read a half-written
 * manifest as "a broken app"; the parent is created through the path guard, so an `apps/` that is
 * a link pointing outside the data folder stops it. The data folder is also created right away.
 * Rescanned immediately after writing: on the user side, nothing is watched while `apps/` does not
 * exist yet (watching the data folder itself would wake up on every write to store.db), so watching
 * never catches the very first app. **This never starts it** — it starts the first time it is
 * needed.
 */
export function installUserApp(host: FoldersHost, spec: UserAppSpec): ExternalAppInfo {
  if (host.disposed()) throw new AppUnavailableError('The app runtime has shut down')
  if (host.deps.reservedIds.includes(spec.id)) throw new AppUnavailableError(`"${spec.id}" is a reserved app id — use another name`)
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
  const dir = join(host.deps.dataRoot, ...USER_APPS_PARTS, spec.id)
  const held = host.find(ref)
  if (held || existsSync(dir)) {
    const same =
      held?.manifest?.server.command === spec.server.command &&
      JSON.stringify(held.manifest.server.args) === JSON.stringify(spec.server.args)
    if (held && same) return host.info(held)
    throw new AppUnavailableError(`Your user folder already has an app "${spec.id}" — use another name, or remove that app first`)
  }

  try {
    placeAppFolder(host.deps.dataRoot, null, spec.id, (staging) => {
      mkdirSync(staging)
      writeFileSync(join(staging, MANIFEST_FILE), text + '\n')
    })
  } catch (err) {
    throw new AppUnavailableError(`Could not write the app folder: ${(err as Error).message}`)
  }
  mkdirSync(host.dataDirOf(ref), { recursive: true })
  host.rescanUser()
  const made = host.find(ref)
  if (!made) throw new AppUnavailableError(`The app folder was written, but discovery did not find it: ${dir}`)
  return host.info(made)
}

/**
 * Creates a new app from the template (M4 C-1b) — "New app" (`apps.create`) and the orchestrator's
 * `create_app` use the same door.
 *
 *   project app     `<project>/.centralu/apps/<id>/` — committed to the repository and shared with
 *                   the team (decision 1's default)
 *   user-folder app `<data folder>/apps/<id>/` — for something used across several projects
 *                   (`projectId: null`)
 *
 * Three things refused, all before the folder is created:
 *   - **the name**: the same rule as a proposed MCP server (`newAppIdProblem` — #93's characters and
 *     the `centralu` reservation, plus a ban on the `app-` prefix). Discovery still reads an id with
 *     the `app-` prefix (a hand-made app), but there is no reason for a newly created app to have a
 *     server name like `app-app-notes`. A reserved id is also refused.
 *   - **an untrusted project**: a created app is code that runs on this machine, and an app in an
 *     untrusted project never starts (decision 3). An app that can be created but never runs would
 *     leave the building session spinning its wheels.
 *   - **an id that already exists**: even a folder standing there with an invalid manifest belongs
 *     to a person or an agent — never overwritten.
 *
 * Writing follows the same method as `installUserApp` (`placeAppFolder`): expanded into a temp
 * folder starting with a dot, then renamed (so discovery never sees a half-written app). The parent folder is created one
 * segment at a time through the path guard (`ensureDirInside` — stops if `.centralu` is a link
 * pointing outside). The data folder is also created right away. Rescanned immediately after
 * writing — watching might not be looking at that location yet. **This never starts it** — it
 * starts the first time it is needed.
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
  const key = spec.projectId ?? USER_SCOPE
  if (host.hasScope(key)) host.rescan(key)
  else host.refresh()

  const ref: AppRef = { projectId: spec.projectId, appId: spec.id }
  const parts = spec.projectId === null ? USER_APPS_PARTS : PROJECT_APPS_PARTS
  const dir = join(root, ...parts, spec.id)
  if (host.find(ref) || existsSync(dir)) {
    throw new AppUnavailableError(`An app "${spec.id}" already exists (${dir}) — use another id`)
  }

  try {
    placeAppFolder(root, spec.projectId, spec.id, (staging) => {
      scaffoldApp(host.deps.templateDir ?? appTemplateDir(), staging, { id: spec.id, name, description })
    })
  } catch (err) {
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
  const idProblem = newAppIdProblem(spec.id, host.deps.reservedIds)
  if (idProblem) throw new AppUnavailableError(`"${spec.id}" cannot be an app id — ${APP_ID_PROBLEM[idProblem]}`)
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
  if (taken(target.path)) throw new AppUnavailableError(`Something is already at ${target.path} — choose another id or folder`)
  const staging = join(parent, `.${spec.id}.${randomUUID()}`)
  try {
    scaffoldApp(host.deps.templateDir ?? appTemplateDir(), staging, { id: spec.id, name, description })
    if (taken(target.path)) throw new Error(`something appeared at ${target.path} meanwhile`)
    renameSync(staging, target.path)
  } catch (err) {
    removeDataQuietly(staging, '[apps]')
    throw new AppUnavailableError(`Could not make the app folder: ${(err as Error).message}`)
  }
}

/** lstat, not exists: a broken link of that name is still a name taken */
function taken(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

/**
 * Removes a user-folder app (M4 A-7) — the path for withdrawing an approved MCP server from the
 * list (a path that did not exist in the old registry).
 *
 * The folder is not deleted, only moved to `app-trash/` in the data folder: it could be a hand-made
 * app, and it is better to have a way to bring it back. The run ledger, data folder, and secrets
 * survive (a removed app's records are still readable — `runs`). **This never removes a project
 * app** — that is a file in a repository, and the place to withdraw it is git.
 *
 * A running app is stopped, and waited for, **before** the folder moves (#14). Windows refuses to
 * move a folder that a process has as its working directory, and an app runs in its own folder:
 * moving first failed with EBUSY and left the app in place and running. Nothing starts it again
 * meanwhile (`removing`). Rescanned after moving: an attached session detaches (appsChanged). A
 * Claude session drops it from its server set without restarting, and a Codex thread keeps the
 * tool name until its next thread, but calling it is refused with "not an attached app"
 * (attaching to a session re-checks on every call).
 */
export async function removeUserApp(host: FoldersHost, ref: AppRef): Promise<void> {
  if (ref.projectId !== null) {
    throw new AppUnavailableError("A project app is part of the project's repository — remove it there")
  }
  host.rescanUser()
  const e = host.require(ref)
  const key = host.holdKey(ref)
  host.removing.add(key)
  try {
    await host.lifecycle.halt(e, 'app removed', { awaitTree: true })
    const trash = join(host.deps.dataRoot, 'app-trash')
    mkdirSync(trash, { recursive: true })
    renameSync(e.dir, join(trash, `${ref.appId}-${Date.now()}`))
  } finally {
    host.removing.delete(key)
  }
  // Also drops the imported-app mark (E-3) — a folder restored from the trash is one a person moved back by hand (decision 3: a user-folder app is trusted)
  host.forgetImport(ref.appId)
  host.rescanUser()
}
