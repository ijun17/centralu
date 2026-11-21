import { appKeyOf, sameApp } from '@cc/protocol/client'
import type { AppReview, AppVersions, ExternalAppInfo, ProjectInfo } from '@cc/protocol/client'
import type { MockClock } from './clock.js'
import type { AppRegistry } from './app-registry.js'
import type { Emit } from './event-bus.js'

/** Importing an app, enabling an imported one, and an app's versions */
export class AppImportsMock {
  /** Source → the review the host would return; the mock reads no folders or zips */
  readonly importSources = new Map<string, AppReview>()
  /** Source → the host's exact rejection wording */
  readonly importRefusals = new Map<string, string>()
  /** Token → review */
  private readonly stagedImports = new Map<string, AppReview>()
  /** Keyed `(project ?? _user)/app` */
  readonly appReviews = new Map<string, AppReview>()
  readonly importPrepares: string[] = []
  readonly importCommits: { token: string; enable: boolean; appId: string }[] = []
  readonly importCancels: string[] = []
  readonly enabledApps: string[] = []
  /** Keyed `(project ?? _user)/app`; a test fills it, since keeping versions is the runtime's job */
  readonly appVersions = new Map<string, AppVersions>()
  readonly restoredVersions: { appId: string; id: string }[] = []
  /** Wired by the mock platform: an import lands in a project of its own, as on the host (#1141) */
  makeProject: ((name: string, parent: string | undefined, trusted: boolean) => Promise<ProjectInfo>) | null = null
  readonly apps = {
    /** As `AppHandover`: preparing does not list the app yet; enabling accepts only the reviewed key */
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
    /** As the host (#1141): a project `<parent>/<id>` (~/Centralu), trusted only for "Import and enable" */
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
      const a = this.registry.externalAppList.find((x) => sameApp(x, { appId, projectId }))
      const r = this.appReviews.get(appKeyOf(projectId, appId))
      if (!a) throw new Error(`No app named "${appId}" in your apps`)
      if (!a.imported || !r) throw new Error('This app was not imported, so it needs no enabling')
      if (r.reviewKey !== reviewKey) throw new Error('This app changed since you reviewed it. Review it again')
      Object.assign(a, { status: 'stopped', error: null, imported: { ...a.imported, confirmedAt: this.clock.now() } })
      this.enabledApps.push(appId)
      this.emit({ type: 'external_apps_changed' })
      return structuredClone(a)
    },
    /** Unfilled, as on the host: no snapshots for a user-folder app, no commits for a project app */
    versions: async (appId: string, projectId: string | null): Promise<AppVersions> => {
      const v = this.appVersions.get(appKeyOf(projectId, appId))
      if (v) return structuredClone(v)
      return projectId === null ? { kind: 'snapshots', snapshots: [] } : { kind: 'git', repo: true, commits: [] }
    },
    restoreVersion: async (appId: string, projectId: string | null, id: string, machine?: string): Promise<ExternalAppInfo> => {
      if (projectId !== null) throw new Error("A project app's versions are its git history; restore it with git")
      const key = appKeyOf(null, appId)
      const v = this.appVersions.get(key)
      const a = this.registry.externalAppList.find((x) => sameApp(x, { appId, projectId: null, machine }))
      if (!a || !v || v.kind !== 'snapshots' || !v.snapshots.some((s) => s.id === id)) throw new Error('That version is no longer kept')
      // As the host's `capture`: the current files are kept first, unless a kept version already matches them
      if (!v.snapshots.some((s) => s.current)) {
        v.snapshots.unshift({ id: `before-restore-${this.restoredVersions.length}`, at: this.clock.now(), files: 4, bytes: 2048, reason: 'before restore', current: false })
      }
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
