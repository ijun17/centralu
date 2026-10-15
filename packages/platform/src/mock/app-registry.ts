import type { AppErrorBundle, AppRun, ExternalAppInfo, NormalizedEvent } from '@cc/protocol'
import type { AppToolResult } from '../ports/index.js'
import type { Emit } from './event-bus.js'

/**
 * What the mock knows per app, keyed `(project ?? _user)/app`: the discovered apps, builders, error bundles, run history,
 * and the screens that are open. The app modules each read and change it.
 */
export class AppRegistry {
  /** An app's error bundles (M4 C-6) — the key is `(project ?? _user)/app`, most recent first. A test fills this in: making a bundle is the runtime's job */
  readonly appErrors = new Map<string, Omit<AppErrorBundle, 'sentAt'>[]>()
  /**
   * As if the host just picked up a new error bundle — puts it in front and broadcasts the
   * list (the list's `lastErrorAt` changes). The same thing the real runtime does when it
   * records a bundle: a read-only tool's failure does not emit "changed," so this is the
   * screen's only signal.
   */
  recordAppError(appId: string, projectId: string | null, bundle: Omit<AppErrorBundle, 'sentAt'>): void {
    const key = `${projectId ?? '_user'}/${appId}`
    this.appErrors.set(key, [bundle, ...(this.appErrors.get(key) ?? [])])
    this.emit({ type: 'external_apps_changed' })
  }
  /** A pinned screen's instance → its app and screen (recorded by `openView`). Same as what the host's ViewHost knows as an instance */
  readonly pinnedInstances = new Map<string, { appId: string; projectId: string | null; uri: string }>()
  /** App → builder session (M4 C-2). The key is `(project ?? _user)/app` — the same shape as the real registry (APP_BUILDERS_KEY) */
  readonly appBuilders = new Map<string, string>()
  /**
   * Run history (M4 B-7) — the key is `(project ?? _user)/app`. A test fills this in (most
   * recent first). Like the host, this only reads and never creates: making a record is the
   * runtime's one and only path, and its test lives in agent-host.
   */
  readonly appRuns = new Map<string, AppRun[]>()
  /** An in-conversation screen's instance → its conversation and app (M4 B-1) — recorded when broadcasting `app_view`'s open */
  readonly inlineInstances = new Map<string, { sessionId: string; appId: string; projectId: string | null }>()
  /** An in-conversation screen's input and outcome — held like the host, and returned when reopened. The key is the `session callId` pair */
  readonly inlineRecords = new Map<
    string,
    {
      appId: string
      projectId: string | null
      tool: string
      toolInput: Record<string, unknown>
      toolResult?: AppToolResult
      cancelled?: string
      /** The open instance — null once closed (the record stays) */
      instanceId: string | null
    }
  >()
  /** External apps discovered (M4 A-8) — a test fills this in with `setExternalApps`. The mock's discovery is this array */
  externalAppList: ExternalAppInfo[] = []
  /** Like the host: changes the list and broadcasts `external_apps_changed` */
  setExternalApps(list: ExternalAppInfo[]): void {
    this.externalAppList = structuredClone(list)
    this.emit({ type: 'external_apps_changed' })
  }

  /** Remembers an in-conversation screen's instance and its held outcome as `app_view` events pass (see `MockPlatform.emit`) */
  recordInlineView(event: NormalizedEvent): void {
    /*
     * An in-conversation screen (M4 B-1). Like the host: remembers the instance as belonging
     * to that conversation (apps.viewMessage), and holds onto the input and outcome to return
     * when reopened (apps.inlineReopen). If the outcome arrives as `kept: false`, the host
     * discarded it — the mock discards it too.
     */
    if (event.type === 'app_view') {
      const key = `${event.sessionId} ${event.callId}`
      const rec = this.inlineRecords.get(key)
      if (event.phase === 'open' && event.instanceId) {
        this.inlineInstances.set(event.instanceId, { sessionId: event.sessionId, appId: event.appId, projectId: event.projectId })
        this.inlineRecords.set(key, {
          appId: event.appId,
          projectId: event.projectId,
          tool: event.tool,
          toolInput: event.toolInput ?? {},
          instanceId: event.instanceId,
        })
      } else if (event.phase === 'closed' && rec) {
        rec.instanceId = null
      } else if (event.phase === 'result' && rec) {
        if (event.kept === false) this.inlineRecords.delete(key)
        else rec.toolResult = event.toolResult as AppToolResult
      } else if (event.phase === 'cancelled' && rec) {
        if (event.kept === false) this.inlineRecords.delete(key)
        else rec.cancelled = event.reason ?? ''
      } else if (event.phase === 'rejected') {
        this.inlineRecords.delete(key)
      }
    }
  }

  constructor(
    private readonly emit: Emit,
  ) {}
}
