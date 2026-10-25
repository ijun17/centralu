import { appKeyOf } from '@cc/protocol'
import type { AppReview, AppVersions, ExternalAppInfo, ProjectInfo } from '@cc/protocol'
import type { MockClock } from './clock.js'
import type { AppRegistry } from './app-registry.js'
import type { Emit } from './event-bus.js'

/** Importing an app, enabling an imported one, and an app's versions (M4 E) */
export class AppImportsMock {
  /** Import source → the review window the host would return (M4 E-3). A test plugs this in — the mock does not read folders or zips */
  readonly importSources = new Map<string, AppReview>()
  /** Source → the host's rejection wording (M4 E-3) — tests check whether the window shows that wording as-is */
  readonly importRefusals = new Map<string, string>()
  /** A prepared import (token → review window), and an admitted app's review window (`(project ?? _user)/app`) */
  private readonly stagedImports = new Map<string, AppReview>()
  readonly appReviews = new Map<string, AppReview>()
  /** What reached the host — sources prepared, admissions (whether enabled), cancellations, apps enabled */
  readonly importPrepares: string[] = []
  readonly importCommits: { token: string; enable: boolean; appId: string }[] = []
  readonly importCancels: string[] = []
  readonly enabledApps: string[] = []
  /** An app's versions (M4 E-1) — the key is `(project ?? _user)/app`. A test fills this in: keeping a version is the runtime's job */
  readonly appVersions = new Map<string, AppVersions>()
  /** Restores that reached the host — tests check they only arrive after confirmation */
  readonly restoredVersions: { appId: string; id: string }[] = []
  /**
   * Makes and registers a new project folder with the trust given (wired by the mock platform): where an import lands,
   * as the host's does (#1141)
   */
  makeProject: ((name: string, parent: string | undefined, trusted: boolean) => Promise<ProjectInfo>) | null = null
  readonly apps = {
    /**
     * Import (M4 E-3). The mock has no filesystem — for each source, a test plugs in the
     * review window the host would return (`importSources`) or a rejection wording
     * (`importRefusals`). Like the real thing (`AppHandover`): preparing does not admit it (it
     * is not in the list yet); admitting it stands it up disabled (`unconfirmed`); and
     * "admit and enable" or enabling only accepts the key from the window the person reviewed.
     * The rejection wording is exactly the host's.
     */
    importPrepare: async (source: string): Promise<{ token: string; review: AppReview }> => {
      this.importPrepares.push(source)
      const refusal = this.importRefusals.get(source)
      if (refusal) throw new Error(refusal)
      const review = this.importSources.get(source)
      if (!review) throw new Error(`Nothing to import at ${source}`)
      const token = `mock-import-${this.clock.next()}`
      this.stagedImports.set(token, structuredClone(review))
      return { token, review: structuredClone(review) }
    },
    /**
     * Like the host (#1141): the app lands as a project of its own, a folder `<parent>/<id>` (~/Centralu), registered
     * untrusted, or trusted for "Import and enable"; trusting it later is enabling it
     */
    importCommit: async (token: string, opts: { enable: boolean; reviewKey?: string; parent?: string }): Promise<ExternalAppInfo> => {
      const review = this.stagedImports.get(token)
      if (!review) throw new Error('This import is no longer waiting (it was cancelled, or 30 minutes passed). Review it again')
      if (opts.enable && opts.reviewKey !== review.reviewKey) throw new Error('What would be enabled is not what you reviewed. Review it again')
      if (!this.makeProject) throw new Error('This mock cannot make a project')
      const project = await this.makeProject(review.appId, opts.parent, opts.enable)
      this.stagedImports.delete(token)
      const app: ExternalAppInfo = {
        appId: review.appId,
        projectId: project.id,
        dir: project.path,
        name: review.name,
        version: review.version,
        description: review.description,
        home: review.home,
        trusted: opts.enable,
        status: opts.enable ? 'stopped' : 'untrusted',
        error: null,
        warnings: [],
        root: true,
        ...(review.secrets.length ? { secrets: review.secrets.map((name) => ({ name, set: false })) } : {}),
      }
      this.registry.externalAppList.push(app)
      this.importCommits.push({ token, enable: opts.enable, appId: review.appId })
      this.emit({ type: 'external_apps_changed' })
      return structuredClone(app)
    },
    importCancel: async (token: string): Promise<void> => {
      this.stagedImports.delete(token)
      this.importCancels.push(token)
    },
    review: async (appId: string, projectId: string | null): Promise<AppReview> => {
      const r = this.appReviews.get(appKeyOf(projectId, appId))
      if (!r) throw new Error(`No app named "${appId}" in your apps`)
      return structuredClone(r)
    },
    enable: async (appId: string, projectId: string | null, reviewKey: string): Promise<ExternalAppInfo> => {
      const a = this.registry.externalAppList.find((x) => x.appId === appId && x.projectId === projectId)
      const r = this.appReviews.get(appKeyOf(projectId, appId))
      if (!a) throw new Error(`No app named "${appId}" in your apps`)
      if (!a.imported || !r) throw new Error('This app was not imported, so it needs no enabling')
      if (r.reviewKey !== reviewKey) throw new Error('This app changed since you reviewed it. Review it again')
      Object.assign(a, { status: 'stopped', error: null, imported: { ...a.imported, confirmedAt: this.clock.now() } })
      this.enabledApps.push(appId)
      this.emit({ type: 'external_apps_changed' })
      return structuredClone(a)
    },
    /**
     * An app's versions (M4 E-1) — a test fills `appVersions`. If not filled, like the host: an
     * empty snapshot list for a user-folder app, an empty commit list for a project app.
     * Restoring rejects a project app like the real thing, and makes the chosen version the
     * current one, then broadcasts the list.
     */
    versions: async (appId: string, projectId: string | null): Promise<AppVersions> => {
      const v = this.appVersions.get(appKeyOf(projectId, appId))
      if (v) return structuredClone(v)
      return projectId === null ? { kind: 'snapshots', snapshots: [] } : { kind: 'git', repo: true, commits: [] }
    },
    restoreVersion: async (appId: string, projectId: string | null, id: string): Promise<ExternalAppInfo> => {
      if (projectId !== null) throw new Error("A project app's versions are its git history; restore it with git")
      const key = appKeyOf(null, appId)
      const v = this.appVersions.get(key)
      const a = this.registry.externalAppList.find((x) => x.appId === appId && x.projectId === null)
      if (!a || !v || v.kind !== 'snapshots' || !v.snapshots.some((s) => s.id === id)) throw new Error('That version is no longer kept')
      for (const s of v.snapshots) s.current = s.id === id
      this.restoredVersions.push({ appId, id })
      this.emit({ type: 'external_apps_changed' })
      return structuredClone(a)
    },
  }

  constructor(
    private readonly clock: MockClock,
    private readonly emit: Emit,
    private readonly registry: AppRegistry,
  ) {}
}
