import type { BackgroundTask, RebuildCause, SessionInfo } from '@cc/protocol'
import type { CreateSessionOpts, LaunchSettings } from '../adapters/contract.js'
import { parseJson } from '../dev-services/store/json.js'
import { isObj } from '../json-value.js'
import { inTurn } from '../idle.js'
import type { DelegationHost } from './delegation-flow.js'
import type { RestartHost } from './restart-policy.js'
import type { RoutedCardsHost } from './routed-cards.js'
import type { SessionTrashHost } from './session-trash.js'
import { residentCost } from './tool-cost.js'
import { codeIntelligenceKey } from './tool-profiles.js'

/**
 * What the launch records reach of the session manager (#428), typed as the manager declares each member. The manager
 * builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type LaunchRecordsHost = Pick<DelegationHost, 'adapters' | 'handles' | 'meta' | 'store'> &
  Pick<SessionTrashHost, 'restartPolicy'> &
  Pick<RestartHost, 'restartSession'> &
  Pick<RoutedCardsHost, 'toolProfileOf'> & {
    /** The settings files reachable from the session, by what it is and its project's trust now (decision 3, #92) */
    settingFilesFor: (m: Pick<SessionInfo, 'id' | 'kind' | 'projectId' | 'appId'>) => Pick<CreateSessionOpts, 'projectTrusted' | 'noSettingFiles'>
  }

/**
 * What a session's process was started with, kept beside the session in the store so a host that adopts the process
 * after a swap knows it (#648, #656): its running background tasks, the tool prefix it was served, its launch
 * settings and its code intelligence; and the restart that applies a change of the last two. Moved out of the session
 * manager as it was (#428); what it reaches of the manager is `LaunchRecordsHost`.
 */
export class LaunchRecords {
  constructor(private readonly host: LaunchRecordsHost) {}

  /**
   * The running background tasks of a session's process, kept in the store (#648) so the host that adopts the process
   * after a swap knows what it holds: the tool lists its level only when it changes, and `close()` on a process kills
   * its shells silently. Written on every change and when a process starts (empty). `null` when no host ever wrote it
   * for this session, which an adopted process reads as "unknown".
   */
  backgroundTasksKey(sessionId: string): string {
    return `background_tasks:${sessionId}`
  }

  /**
   * The list as kept, or null for "unknown". A record this build cannot read whole (#384: cut short, not a list, or a
   * task in a newer build's shape) is no record: read as "nothing running", it let the adopted process sleep, which
   * kills its shells silently. Only running tasks are ever written, so any other element is another build's.
   */
  keptBackgroundTasks(sessionId: string): BackgroundTask[] | null {
    const key = this.backgroundTasksKey(sessionId)
    const raw = this.host.store.settings.appSetting(key)
    if (raw === null) return null
    const list = parseJson(raw)
    const readable = (t: unknown) => isObj(t) && typeof t.id === 'string' && t.status === 'running'
    if (Array.isArray(list) && list.every(readable)) return list as BackgroundTask[]
    console.error(`[agent-host] app_settings.${key} holds ${JSON.stringify(raw.slice(0, 200))}, which this build cannot read; the session's background work reads as unknown`)
    return null
  }

  rememberBackgroundTasks(m: SessionInfo): void {
    this.host.store.settings.setAppSetting(this.backgroundTasksKey(m.id), JSON.stringify(m.backgroundTasks.filter((t) => t.status === 'running')))
  }

  /** The persisted prefix a process was started with. It is separate from SessionInfo: a screen never needs it. */
  toolPrefixKey(sessionId: string): string {
    return `tool_prefix:${sessionId}`
  }

  toolPrefixHash(sessionId: string): string | null {
    const profile = this.host.toolProfileOf(sessionId)
    const m = this.host.meta.get(sessionId)
    if (!profile || !m) return null
    const adapter = this.host.adapters.get(m.tool)
    if (!adapter) return null
    return residentCost(profile, adapter.capabilities).prefixHash
  }

  rememberToolPrefix(sessionId: string): void {
    const hash = this.toolPrefixHash(sessionId)
    if (hash) this.host.store.settings.setAppSetting(this.toolPrefixKey(sessionId), hash)
  }

  /** The stable inputs an adapter may use for its keeper-swap launch fingerprint. */
  launchSettingsFor(session: Pick<SessionInfo, 'id' | 'kind' | 'projectId' | 'appId' | 'model' | 'effort' | 'verbosity' | 'serviceTier' | 'permissionPreset' | 'roleAppend'>, cwd: string): LaunchSettings {
    return {
      cwd,
      model: session.model ?? undefined,
      effort: session.effort ?? undefined,
      verbosity: session.verbosity ?? undefined,
      serviceTier: session.serviceTier ?? undefined,
      permissionPreset: session.permissionPreset,
      ...this.host.settingFilesFor(session),
      toolProfile: this.host.toolProfileOf(session.id) ?? undefined,
      systemPromptAppend: session.roleAppend ?? undefined,
      ...(this.codeIntelligenceOffFor(session.id) ? { noCodeIntelligence: true } : {}),
    }
  }

  /** Whether this session was created without code intelligence (#686, `codeIntelligenceKey`) */
  codeIntelligenceOffFor(sessionId: string): boolean {
    return this.host.store.settings.appSetting(codeIntelligenceKey(sessionId)) === 'off'
  }

  launchSettingsKey(sessionId: string): string {
    return `launch_settings:${sessionId}`
  }

  launchSettingsFingerprint(session: SessionInfo, cwd: string): string | null {
    const adapter = this.host.adapters.get(session.tool)
    return adapter?.launchSettingsFingerprint?.(this.launchSettingsFor(session, cwd)) ?? null
  }

  rememberLaunchSettings(session: SessionInfo, cwd: string): void {
    const fingerprint = this.launchSettingsFingerprint(session, cwd)
    if (fingerprint) this.host.store.settings.setAppSetting(this.launchSettingsKey(session.id), fingerprint)
  }

  /**
   * A keeper preserves agent processes over a host swap. That also preserves the Centralu MCP
   * definitions they started with, so compare the exact served prefix rather than assuming a new
   * host means a new thread. Sleeping sessions have no process and therefore pick it up on wake;
   * live idle sessions restart now, while a turn or card finishes before its restart.
   */
  async refreshToolDefinitions(): Promise<void> {
    // Apply unknown/changed launch policy first: the same restart also refreshes tool definitions.
    await this.refreshLaunchSettings()
    for (const session of [...this.host.meta.values()]) {
      /*
       * Only a turn holds this restart (#648): the definitions are what the process may call, so an idle session takes
       * them now, background work or not, and the conversation says what stopped (`noticeBackgroundStopped`).
       */
      await this.applyWhenChanged(session, this.toolPrefixKey(session.id), this.toolPrefixHash(session.id), this.host.restartPolicy.definitionsRestartAfterTurn, 'instructions')
    }
  }

  /**
   * A kept CLI also retains settings derived at launch (sandbox roots, network policy, adapter
   * environment). The adapter owns the fingerprint; the host only gives it the same safe
   * boundary behaviour as changed tool definitions.
   */
  async refreshLaunchSettings(projectId?: string, trustChange = false): Promise<void> {
    for (const session of [...this.host.meta.values()]) {
      if (projectId !== undefined && session.projectId !== projectId) continue
      const cwd = this.host.store.sessions.sessionCwd(session.id)
      if (!cwd) continue
      // Earlier builds did not record launch settings: a kept process's policy is unknown.
      // A safety change too, so the same rule as the definitions above
      await this.applyWhenChanged(session, this.launchSettingsKey(session.id), this.launchSettingsFingerprint(session, cwd), this.host.restartPolicy.launchSettingsRestartAfterTurn, 'launch_settings', () => {
        if (trustChange) this.host.restartPolicy.trustRestartNotice.add(session.id)
      })
    }
  }

  /**
   * What a live process was started with, as stored under `key`, against what it would start with now (`next`): the
   * same, nothing; a session with no process takes `next` on its next start, so it is only written down; a process in
   * a turn restarts when the turn ends (`deferred` says why); an idle one restarts now. The rule both refreshes keep.
   */
  async applyWhenChanged(
    session: SessionInfo,
    key: string,
    next: string | null,
    deferred: Set<string>,
    cause: RebuildCause,
    beforeRestart?: () => void,
  ): Promise<void> {
    if (!next || this.host.store.settings.appSetting(key) === next) return
    if (!this.host.handles.has(session.id)) {
      this.host.store.settings.setAppSetting(key, next)
      return
    }
    beforeRestart?.()
    if (inTurn(session.state)) {
      this.host.restartPolicy.restartAfterTurn.add(session.id)
      deferred.add(session.id)
      return
    }
    await this.host.restartSession(session.id, cause).catch(() => {})
  }
}
