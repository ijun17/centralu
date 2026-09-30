import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AppReview, ExternalAppInfo } from '@cc/protocol'
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
import { ensureDirInside } from './scaffold.js'
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
}

/** The staging area — inside the data folder, so moving it into the user folder is a rename on the same filesystem. Discovery never scans here */
export const STAGING_REL = 'app-staging'
const STAGING_MS = 30 * 60_000

type Staged = { home: string; appDir: string; review: AppReview; timer: NodeJS.Timeout }

const NOT_ENABLED = 'This app was imported and is not enabled yet. Review what it runs, then enable it'
const CHANGED = 'This app changed what it runs or what it uses since you enabled it. Review it and enable it again'

export class AppHandover {
  private book: ImportBook
  /** Versions of an app outside git (a user-folder app) (E-1) */
  private versions: AppVersions
  private staged = new Map<string, Staged>()
  private limits: ImportLimits
  private stagingRoot: string

  constructor(
    private host: HandoverHost,
    private opts: HandoverOptions = {},
  ) {
    this.book = new ImportBook(host.dataRoot)
    this.versions = new AppVersions(join(host.dataRoot, VERSIONS_REL, '_user'))
    this.limits = { ...IMPORT_LIMITS, ...opts.limits }
    this.stagingRoot = join(host.dataRoot, STAGING_REL)
    // The staging area a previous host left behind — never brought in, so it is discarded (it can be imported again)
    rmSync(this.stagingRoot, { recursive: true, force: true })
  }

  /**
   * Whether this app is waiting on the person's confirmation — the reason, or null. **On every
   * call**, the mark is checked against the current manifest: the moment the manifest's `server` or
   * `uses` changes (an editor, a building session, a restore), it is blocked starting from the next
   * call.
   */
  gate(appId: string, dir: string, manifest: AppManifest): string | null {
    const mark = this.book.get(appId, dir)
    if (!mark) return null
    if (mark.confirmed && mark.confirmed.key === reviewKey(manifest)) return null
    return mark.confirmed ? CHANGED : NOT_ENABLED
  }

  /** The mark shown in the list — absent if the app was not imported */
  imported(appId: string, dir: string): ExternalAppInfo['imported'] {
    const mark = this.book.get(appId, dir)
    return mark ? { source: mark.source, at: mark.importedAt, confirmedAt: mark.confirmed?.at ?? null } : undefined
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
      this.refuseTaken(manifest.id)
      const review = reviewOf(manifest, files, { source: source.label, warnings })
      const timer = setTimeout(() => this.cancel(token), this.opts.stagingMs ?? STAGING_MS)
      timer.unref()
      this.staged.set(token, { home, appDir, review, timer })
      return { token, review }
    } catch (e) {
      discard(home)
      throw e instanceof ImportRefused ? e : new ImportRefused(`Could not import from ${source.label}: ${(e as Error).message}`)
    } finally {
      if (tmp) discard(tmp)
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
    const dir = join(ensureDirInside(this.host.dataRoot, ['apps']), id)
    renameSync(s.appDir, dir)
    this.book.mark(id, dir, s.review.source)
    if (opts.enable) this.book.confirm(id, manifest)
    // Captures the state it arrived in as the first version (E-1) — so even if a building session breaks it while editing, it can be restored to the imported version
    this.snapshot(id, dir, 'imported')
    this.cancel(token)
    this.host.rescanUser()
    return id
  }

  /** Abandons it — cleans up the staging area. Silently does nothing if it is already gone */
  cancel(token: string): void {
    const s = this.staged.get(token)
    if (!s) return
    clearTimeout(s.timer)
    this.staged.delete(token)
    discard(s.home)
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
    if (!this.book.get(appId, app.dir)) throw new ImportRefused('This app was not imported, so it needs no enabling')
    if (reviewKey(app.manifest) !== key) throw new ImportRefused('This app changed since you reviewed it. Review it again')
    this.book.confirm(appId, app.manifest)
    this.host.changed()
  }

  // ── versions (E-1) ──────────────────────────────────────────────────────────────────

  /**
   * Captures a user-folder app's current code as a version — does nothing if a version with the same
   * fingerprint already exists. **Never throws on failure**: failing to capture a version must never
   * stop the app from starting. The reason is written to the host's log.
   */
  snapshot(appId: string, dir: string, reason: string, stamp?: string): Snapshot | null {
    try {
      return this.versions.capture(appId, dir, reason, stamp)
    } catch (e) {
      console.error(`[apps] could not keep a version of user/${appId}: ${(e as Error).message}`)
      return null
    }
  }

  /** An app's versions, most recent first — the version matching the folder's current fingerprint has `current` set */
  versionsOf(appId: string, dir: string): (Snapshot & { current: boolean })[] {
    const now = folderFingerprint(dir)
    return this.versions.list(appId).map((s) => ({ ...s, current: s.stamp === now }))
  }

  /**
   * Writes one version back into the app folder — before writing it back, captures the current
   * folder as a version too (so a restore can itself be undone). Restarting the app is the caller's
   * job (the runtime): that is where the rules for in-progress calls and reflecting changes live.
   */
  restore(appId: string, id: string, dir: string): Snapshot {
    this.snapshot(appId, dir, 'before restore')
    try {
      return this.versions.restore(appId, id, dir)
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
    if (this.host.userApp(id) || existsSync(join(this.host.dataRoot, 'apps', id))) {
      throw new ImportRefused(`An app with the id "${id}" is already in your apps. Remove it first, or change the id in its manifest`)
    }
  }
}
