import { randomUUID } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { appKeyOf, type AppReview, type ExternalAppInfo } from '@cc/protocol'
import { canonicalJson } from './runs.js'
import { ImportBook, reviewKey } from './import-book.js'
import {
  IMPORT_LIMITS,
  ImportRefused,
  classifySource,
  discard,
  downloadZip,
  isZip,
  listAppFiles,
  readStagedManifest,
  reviewOf,
  stageLocal,
  stageZip,
  type ImportLimits,
  type StagedFiles,
} from './imports.js'
import type { AppManifest } from './manifest.js'
import { appFolderTaken, appsFolderOf, nameTaken } from './placement.js'
import { folderFingerprint } from './fingerprint.js'
import { AppVersions, VERSIONS_REL, type Snapshot } from './versions.js'

/**
 * The host side of handover (M4 E) — the staging area for an externally imported app, and the
 * person's confirmation of it.
 *
 * The runtime holds an app's lifecycle and the single path a call takes; this file holds "may this
 * app be brought in, may it run." These are kept separate because the runtime is already a file
 * where the broker (D), reflecting changes (C-4), and the lifecycle all live together — scattering
 * handover's rules through that too would make it hard to find which check lives where. The runtime
 * asks this file only two things: whether this app is waiting on confirmation (`gate`), and the mark
 * on an imported app (`imported`).
 *
 * The sequence: prepare (`prepare`: stage the files, validate, and build what the person will see) →
 * the person reviews it → bring it in (`commit`: move it into the user folder and record it as
 * disabled, or confirm it right there if requested) → later, if `server` or `uses` changes, ask again
 * (`review` → `enable`).
 */

export type HandoverHost = {
  dataRoot: string
  reservedIds: readonly string[]
  /** Rescans the user folder right now — so an app just brought in shows up in the list immediately */
  rescanUser(): void
  /** The current state of one user-folder app — null if it does not exist. If the manifest is invalid, manifest is null */
  userApp(appId: string): { dir: string; manifest: AppManifest | null } | null
  /** The list may have changed (status, mark) */
  changed(): void
}

export type HandoverOptions = {
  /** Limits (reduced by tests) */
  limits?: Partial<ImportLimits>
  /** Download (a test plugs in a fake — this exercises transfer, size, and content without starting an https server) */
  fetch?: typeof fetch
  /** How long until the staging area cleans itself up */
  stagingMs?: number
  /** Removes a folder (tests inject one that fails); the default retries a busy file */
  remove?: (path: string) => void
}

/** The staging area — inside the data folder, so moving it into the user folder is a rename on the same filesystem. Discovery never scans here */
export const STAGING_REL = 'app-staging'
const STAGING_MS = 30 * 60_000

type Staged = { home: string; appDir: string; review: AppReview; timer: NodeJS.Timeout }

const NOT_ENABLED = 'This app was imported and is not enabled yet. Review what it runs, then enable it'
const CHANGED = 'This app changed what it runs or what it uses since you enabled it. Review it and enable it again'

export class AppHandover {
  private book: ImportBook
  /**
   * Versions of an app outside git (E-1): a user-folder app, and a root app whose project is not a repository (#1141).
   * Kept per app key (`<project id | _user>/<app id>`), so a user-folder app's stay where they always were
   */
  private versions: AppVersions
  private staged = new Map<string, Staged>()
  private limits: ImportLimits
  private stagingRoot: string

  constructor(
    private host: HandoverHost,
    private opts: HandoverOptions = {},
  ) {
    this.book = new ImportBook(host.dataRoot)
    this.versions = new AppVersions(join(host.dataRoot, VERSIONS_REL), opts.remove)
    this.limits = { ...IMPORT_LIMITS, ...opts.limits }
    this.stagingRoot = join(host.dataRoot, STAGING_REL)
    // The staging area a previous host left behind — never brought in, so it is discarded (it can be imported again)
    discard(this.stagingRoot, opts.remove)
  }

  /**
   * Whether this app is waiting on the person's confirmation — the reason, or null. **On every
   * call**, the mark is checked against the current manifest: the moment the manifest's `server` or
   * `uses` changes (an editor, a building session, a restore), it is blocked starting from the next
   * call.
   */
  gate(appId: string, dir: string, manifest: AppManifest): string | null {
    const mark = this.book.get(appId, dir)
    // No mark is the person's own app only while the marks can be trusted to be complete (#1172)
    if (!mark) return this.book.doubt()
    if (mark.confirmed && mark.confirmed.key === reviewKey(manifest)) return null
    if (mark.confirmed) return CHANGED
    return mark.lost !== undefined ? this.book.lostReason(mark.lost) : NOT_ENABLED
  }

  /**
   * The mark shown in the list — absent if the app was not imported. A mark written because the marks were lost
   * (`ImportMark.lost`, #1172) is not shown: the app may be the person's own, so the list does not call it imported
   */
  imported(appId: string, dir: string): ExternalAppInfo['imported'] {
    const mark = this.book.get(appId, dir)
    return mark && mark.lost === undefined ? { source: mark.source, at: mark.importedAt, confirmedAt: mark.confirmed?.at ?? null } : undefined
  }

  /**
   * Prepares an import — stages the files, validates it, and builds what the person reviews. A
   * download is received into a temp folder on this machine, unpacked, and then deleted. On failure,
   * the staging area is cleaned up and the reason is thrown (the reason is exactly the text that
   * shows up in the dialog).
   */
  async prepare(raw: string): Promise<{ token: string; review: AppReview }> {
    const source = classifySource(raw)
    const token = randomUUID()
    const home = join(this.stagingRoot, token)
    mkdirSync(home, { recursive: true })
    const appDir = join(home, 'app')
    let tmp: string | null = null
    try {
      let files: StagedFiles
      if (source.kind === 'https') {
        tmp = mkdtempSync(join(tmpdir(), 'centralu-import-'))
        const buf = await downloadZip(source.url, tmp, this.limits, this.opts.fetch)
        if (!isZip(buf)) throw new ImportRefused(`${source.label} did not send a .zip file`)
        files = stageZip(buf, appDir, this.limits)
      } else {
        files = stageLocal(source.path, appDir, this.limits)
      }
      const { manifest, warnings } = readStagedManifest(appDir, this.host.reservedIds)
      /*
       * An import lands as a project of its own now (#1141, `commitTo`), whose folder is checked where it goes; an id
       * the user folder holds is no reason to refuse it (a folder registered as a project in place stays there)
       */
      const review = reviewOf(manifest, files, { source: source.label, warnings })
      const timer = setTimeout(() => this.cancel(token), this.opts.stagingMs ?? STAGING_MS)
      timer.unref()
      this.staged.set(token, { home, appDir, review, timer })
      return { token, review }
    } catch (e) {
      discard(home, this.opts.remove)
      throw e instanceof ImportRefused ? e : new ImportRefused(`Could not import from ${source.label}: ${(e as Error).message}`)
    } finally {
      if (tmp) discard(tmp, this.opts.remove)
    }
  }

  /**
   * Brings a staged app into the user folder — **disabled.** With `enable`, the confirmation is
   * recorded right there, but the key must be the same one shown to the person during preparation.
   * Right before bringing it in, the staged manifest is read again and checked against that key (the
   * thing validated is the thing brought in).
   * @returns the id of the app brought in
   */
  commit(token: string, opts: { enable: boolean; reviewKey?: string }): string {
    const s = this.staged.get(token)
    if (!s) throw new ImportRefused('This import is no longer waiting (it was cancelled, or 30 minutes passed). Review it again')
    const id = s.review.appId
    if (opts.enable && opts.reviewKey !== s.review.reviewKey) throw new ImportRefused('What would be enabled is not what you reviewed. Review it again')
    const { manifest } = readStagedManifest(s.appDir, this.host.reservedIds)
    if (reviewKey(manifest) !== s.review.reviewKey) throw new ImportRefused('The app changed while it was waiting. Review it again')
    this.refuseTaken(id)
    const dir = join(appsFolderOf(this.host.dataRoot, null), id)
    /*
     * The mark is written before the folder appears (#838). A rename first left a window, and on a failed mark a
     * folder for good, in which the app sat in the user folder with no mark: the person's own app, run without the
     * review. Staging is in the data folder, so the rename keeps the folder's inode the mark is tied to.
     */
    this.book.mark(id, s.appDir, s.review.source)
    try {
      renameSync(s.appDir, dir)
    } catch (e) {
      this.book.drop(id)
      throw e
    }
    if (opts.enable) this.book.confirm(id, dir, manifest)
    // Captures the state it arrived in as the first version (E-1) — so even if a building session breaks it while editing, it can be restored to the imported version
    this.snapshot(appKeyOf(null, id), dir, 'imported')
    this.cancel(token)
    this.host.rescanUser()
    return id
  }

  /** The id of the app staged under this token, or null once it is gone */
  stagedId(token: string): string | null {
    return this.staged.get(token)?.review.appId ?? null
  }

  /**
   * Brings a staged app in as a new project's folder (#1141): `target.path`, checked free by the caller and checked again
   * here. The same checks as `commit` first (the key the person reviewed, the staged manifest read again). No import mark
   * is written: the project's trust is what enables it, and the host registers it trusted only for "Import and enable".
   * The staging area is in the data folder, so a parent on another volume gets a copy, not a rename.
   * @returns the id of the app brought in
   */
  commitTo(token: string, opts: { enable: boolean; reviewKey?: string }, target: { path: string; isDefault: boolean }): string {
    const s = this.staged.get(token)
    if (!s) throw new ImportRefused('This import is no longer waiting (it was cancelled, or 30 minutes passed). Review it again')
    if (opts.enable && opts.reviewKey !== s.review.reviewKey) throw new ImportRefused('What would be enabled is not what you reviewed. Review it again')
    const { manifest } = readStagedManifest(s.appDir, this.host.reservedIds)
    if (reviewKey(manifest) !== s.review.reviewKey) throw new ImportRefused('The app changed while it was waiting. Review it again')
    if (target.isDefault) mkdirSync(dirname(target.path), { recursive: true })
    if (nameTaken(target.path)) throw new ImportRefused(`Something is already at ${target.path}. Choose another folder`)
    try {
      renameSync(s.appDir, target.path)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
      // Another volume: copied beside its place and renamed in, so it never stands half there
      const tmp = join(dirname(target.path), `.${s.review.appId}.${randomUUID()}`)
      try {
        cpSync(s.appDir, tmp, { recursive: true, preserveTimestamps: true })
        renameSync(tmp, target.path)
      } catch (err) {
        discard(tmp, this.opts.remove)
        throw err
      }
    }
    const id = s.review.appId
    this.cancel(token)
    return id
  }

  /** Abandons it — cleans up the staging area. Silently does nothing if it is already gone */
  cancel(token: string): void {
    const s = this.staged.get(token)
    if (!s) return
    clearTimeout(s.timer)
    this.staged.delete(token)
    discard(s.home, this.opts.remove)
  }

  /**
   * Reviews an app already brought in — an imported app not yet enabled, or one whose `server` or
   * `uses` changed after it was enabled. When asking again, this carries along the declaration seen
   * at the time it was enabled: "what changed" is the reason it is being asked again.
   */
  review(appId: string): AppReview {
    this.host.rescanUser()
    const app = this.host.userApp(appId)
    if (!app) throw new ImportRefused(`No app named "${appId}" in your apps`)
    if (!app.manifest) throw new ImportRefused("This app's manifest is invalid, so there is nothing to review")
    const m = app.manifest
    const mark = this.book.get(appId, app.dir)
    const was = mark?.confirmed ?? null
    const changed =
      was && was.key !== reviewKey(m)
        ? {
            server: canonicalJson(was.server) !== canonicalJson({ command: m.server.command, args: m.server.args }),
            uses: canonicalJson(was.uses) !== canonicalJson(m.uses),
            was: { server: { command: was.server.command, args: was.server.args }, uses: was.uses },
          }
        : null
    return reviewOf(m, listAppFiles(app.dir, this.limits), { source: mark?.source ?? app.dir, warnings: [], changed })
  }

  /**
   * Enables an imported app — only if the key from the dialog the person saw matches the current
   * manifest. If it changed in the meantime, this refuses: a command the person never saw is never
   * recorded as "enabled".
   */
  enable(appId: string, key: string): void {
    this.host.rescanUser()
    const app = this.host.userApp(appId)
    if (!app) throw new ImportRefused(`No app named "${appId}" in your apps`)
    if (!app.manifest) throw new ImportRefused("This app's manifest is invalid; fix it before enabling it")
    if (!this.book.get(appId, app.dir) && !this.book.doubt()) throw new ImportRefused('This app was not imported, so it needs no enabling')
    if (reviewKey(app.manifest) !== key) throw new ImportRefused('This app changed since you reviewed it. Review it again')
    this.book.confirm(appId, app.dir, app.manifest)
    this.host.changed()
  }

  // ── versions (E-1) ──────────────────────────────────────────────────────────────────

  /**
   * Captures an app's current code as a version, under its app key (`appKeyOf`) — does nothing if a version with the
   * same fingerprint already exists. **Never throws on failure**: failing to capture a version must never stop the app
   * from starting. The reason is written to the host's log.
   */
  snapshot(key: string, dir: string, reason: string, stamp?: string): Snapshot | null {
    try {
      return this.versions.capture(key, dir, reason, stamp)
    } catch (e) {
      console.error(`[apps] could not keep a version of ${key}: ${(e as Error).message}`)
      return null
    }
  }

  /** An app's versions by app key, most recent first — the version matching the folder's current fingerprint has `current` set */
  versionsOf(key: string, dir: string): (Snapshot & { current: boolean })[] {
    const now = folderFingerprint(dir)
    return this.versions.list(key).map((s) => ({ ...s, current: s.stamp === now }))
  }

  /**
   * Writes one version back into the app folder — before writing it back, captures the current
   * folder as a version too (so a restore can itself be undone). Restarting the app is the caller's
   * job (the runtime): that is where the rules for in-progress calls and reflecting changes live.
   */
  restore(key: string, id: string, dir: string, opts: { root?: boolean } = {}): Snapshot {
    if (opts.root) {
      /*
       * A root app's folder is the person's whole project (#1141): the copy of the current files is the only way back
       * from a restore, so a restore without it is refused rather than run. And nothing the version lacks is deleted
       */
      try {
        this.versions.capture(key, dir, 'before restore')
      } catch (e) {
        throw new ImportRefused(`Could not keep a copy of the current files first (${(e as Error).message}), so nothing was restored`)
      }
    } else this.snapshot(key, dir, 'before restore')
    try {
      return this.versions.restore(key, id, dir, { keepOthers: opts.root === true })
    } catch (e) {
      throw new ImportRefused((e as Error).message)
    }
  }

  /** The app was removed from the user folder — its mark is dropped too */
  forget(appId: string): void {
    this.book.drop(appId)
  }

  dispose(): void {
    for (const token of [...this.staged.keys()]) this.cancel(token)
  }

  /** An id that already exists — even a folder standing there with an invalid manifest belongs to the person. Never overwritten (the same rule as a new app) */
  private refuseTaken(id: string): void {
    this.host.rescanUser()
    if (this.host.userApp(id) || appFolderTaken(this.host.dataRoot, null, id)) {
      throw new ImportRefused(`An app with the id "${id}" is already in your apps. Remove it first, or change the id in its manifest`)
    }
  }
}
