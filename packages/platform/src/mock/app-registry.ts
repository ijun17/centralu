import { appKeyOf } from '@cc/protocol/client'
import type { AppErrorBundle, AppRun, ExternalAppInfo, NormalizedEvent } from '@cc/protocol/client'
import type { AppToolResult } from '../ports/index.js'
import { isAppToolResult } from '../app-tool-result.js'
import type { Emit } from './event-bus.js'

/** What the mock knows per app, keyed `(project ?? _user)/app`; the app modules each read and change it */
export class AppRegistry {
  /** Most recent first; a test fills it in, as making a bundle is the runtime's job */
  readonly appErrors = new Map<string, Omit<AppErrorBundle, 'sentAt'>[]>()
  /** Broadcasts the list as the runtime does: a read-only tool's failure emits no "changed", so this is the only signal */
  recordAppError(appId: string, projectId: string | null, bundle: Omit<AppErrorBundle, 'sentAt'>): void {
    const key = appKeyOf(projectId, appId)
    this.appErrors.set(key, [bundle, ...(this.appErrors.get(key) ?? [])])
    this.emit({ type: 'external_apps_changed' })
  }
  /** Recorded by `openView`, as the host's ViewHost knows an instance */
  readonly pinnedInstances = new Map<string, { appId: string; projectId: string | null; uri: string }>()
  /** App → builder session, the shape of the host's APP_BUILDERS_KEY */
  readonly appBuilders = new Map<string, string>()
  /** Most recent first; a test fills it in. Only the runtime makes a record (tested in agent-host) */
  readonly appRuns = new Map<string, AppRun[]>()
  /** Recorded when `app_view`'s open is broadcast */
  readonly inlineInstances = new Map<string, { sessionId: string; appId: string; projectId: string | null }>()
  /** Held like the host and returned when reopened; keyed by `session callId` */
  readonly inlineRecords = new Map<
    string,
    {
      appId: string
      projectId: string | null
      tool: string
      toolInput: Record<string, unknown>
      toolResult?: AppToolResult
      cancelled?: string
      /** Null once closed; the record stays */
      instanceId: string | null
    }
  >()
  /** The mock's discovery; a test fills it with `setExternalApps` */
  externalAppList: ExternalAppInfo[] = []
  setExternalApps(list: ExternalAppInfo[]): void {
    this.externalAppList = structuredClone(list)
    this.emit({ type: 'external_apps_changed' })
  }

  recordInlineView(event: NormalizedEvent): void {
    // As the host (apps.viewMessage, apps.inlineReopen); `kept: false` means the host discarded the outcome
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
        else if (isAppToolResult(event.toolResult)) rec.toolResult = event.toolResult
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
