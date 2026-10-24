import type { ChildOwnership } from './child-ownership.js'
import type {
  RebuildCause,
  NormalizedEvent,
  PermissionPreset,
  SessionInfo,
} from '@cc/protocol'
import {
  liveBackgroundTasks,
} from '@cc/protocol'
import type { SessionHandle } from '../adapters/contract.js'
import { launchPreset } from '../adapters/edit-grant.js'
import type { Store } from '../dev-services/store.js'
import { inTurn } from '../idle.js'

/**
 * How long an adopted session whose background work is unknown (#648, no record from the previous host) may stay quiet
 * before it is taken as holding nothing: until then it is never put to sleep. Two hours is past any quiet a person
 * leaves a running dev server in while still at the machine, and short of keeping a forgotten session awake all night.
 */
const BACKGROUND_UNKNOWN_MAX_MS = 2 * 60 * 60 * 1000

/**
 * How long a restart that changes nothing about safety (a model, an app set) waits for the session's background work
 * to end before it is applied anyway (#648). A safety change does not wait at all (`applyDeferredRestart`).
 */
const BACKGROUND_HOLD_MAX_MS = 60 * 60 * 1000

/**
 * What the restart policy reaches of the session manager (#428), typed as the manager declares each member. The
 * manager builds it with getters for its fields, so each is read when used, never kept.
 */
export type RestartHost = {
  backgroundTasksKey: (sessionId: string) => string
  readonly children: ChildOwnership
  readonly handles: Map<string, SessionHandle>
  inputsHeld: (sessionId: string) => boolean
  /** The host is quitting or handing over (#839): no process is replaced then */
  readonly lettingGo: boolean
  readonly meta: Map<string, SessionInfo>
  onEvent: (raw: NormalizedEvent, from?: SessionHandle | null) => void
  rememberBackgroundTasks: (m: SessionInfo) => void
  restartSession: (sessionId: string, cause?: RebuildCause) => Promise<{ session: SessionInfo; resumed: boolean; reason?: string; }>
  readonly running: Map<string, { model: string | null; effort: string | null; verbosity: string | null; serviceTier: string | null; permissionPreset: PermissionPreset; }>
  scheduleDrain: (sessionId: string) => void
  readonly store: Store
}

/**
 * When a session's process is replaced (#428): the changes that wait for the end of a turn (#164, #589, #663, #371
 * part A), the restarts under way, and the background work a restart that changes nothing about safety waits for
 * (#648). Moved out of the session manager as it was; what it reaches of the manager is `RestartHost`.
 */
export class RestartPolicy {
  constructor(private readonly host: RestartHost) {}

  /** Why a session's process is being restarted, for the cache's rebuild cause; taken when the new process comes up */
  readonly restartReasons = new Map<string, RebuildCause>()

  /**
   * Session whose configuration changed mid-turn — the process is swapped once that turn ends
   * (#164). It used to be swapped on the spot, which made the running turn vanish (Codex closes its
   * app-server), even though the screen said "starting next turn".
   */
  readonly restartAfterTurn = new Set<string>()

  /** Input arriving after a note completes waits for its deferred process replacement, including disposal. */
  readonly deferredRestarts = new Map<string, Promise<void>>()

  /** A new host served a different Centralu tool prefix; replace the old agent at its safe boundary. */
  readonly definitionsRestartAfterTurn = new Set<string>()

  /** A kept process was started with adapter settings from an older host build (#589). */
  readonly launchSettingsRestartAfterTurn = new Set<string>()

  /** Sessions whose pending launch-settings restart comes from a change of their project's trust (#663): the restart says so */
  readonly trustRestartNotice = new Set<string>()

  /**
   * Sessions whose adopted process may hold background work this host knows nothing of (#648) -> when the session was
   * last heard from. The previous host left no list of it (a build before the list was kept), and the tool says its
   * level only when it changes. Until the tool's own full list arrives (`snapshot`), the session is never idle
   * (`sessionIdle`: `background_unknown`), so it is not put to sleep over a shell nobody can see; after
   * `BACKGROUND_UNKNOWN_MAX_MS` without a word it is taken as holding nothing (`backgroundKnown`). A safety restart does
   * not wait for it (`applyDeferredRestart`). A fresh process starts known: it holds nothing yet.
   */
  readonly backgroundUnknown = new Map<string, number>()

  /**
   * A deferred restart that changes nothing about safety, waiting for the session's background work to end (#648) ->
   * when the wait began, and the timer that applies it anyway `BACKGROUND_HOLD_MAX_MS` later. The entry outlives its
   * timer until the restart is applied: a timer that fires mid-turn finds the turn running, and the turn's end applies
   * the restart then, counting from `since` rather than starting a new hour.
   */
  private readonly backgroundHolds = new Map<string, { since: number; timer: ReturnType<typeof setTimeout> }>()

  /**
   * Codex sessions whose attached apps changed mid-turn (#371 part A) — restarted through resume when
   * the turn ends, beside `restartAfterTurn`'s settings drift: a Codex thread keeps the MCP servers it
   * started with, so the restart is what gives it (or takes away) an app it attached or detached.
   */
  readonly appsRestartAfterTurn = new Set<string>()

  /** Background work the session's process holds that ending it would end (#648): what its tool listed as running */
  private backgroundRunning(sessionId: string): boolean {
    const m = this.host.meta.get(sessionId)
    return !!m && liveBackgroundTasks(m.backgroundTasks).length > 0
  }

  /**
   * Whether what the session's process holds in the background is known (#648). An adopted process with no record is
   * not, until its tool lists its work; after `BACKGROUND_UNKNOWN_MAX_MS` without a word from the session it is taken
   * as holding nothing, said in the log, and recorded so the next host does not start from unknown again.
   */
  backgroundKnown(sessionId: string): boolean {
    const since = this.backgroundUnknown.get(sessionId)
    if (since === undefined) return true
    if (Date.now() - since < BACKGROUND_UNKNOWN_MAX_MS) return false
    this.backgroundUnknown.delete(sessionId)
    console.error(
      `[sessions] ${sessionId.slice(0, 8)}: no word of its background work since it was adopted, for ` +
        `${Math.round(BACKGROUND_UNKNOWN_MAX_MS / 3_600_000)} h; taking it as none`,
    )
    const m = this.host.meta.get(sessionId)
    if (m) this.host.rememberBackgroundTasks(m)
    return true
  }

  /** The session's process is gone for good (deleted): nothing of its background work is kept (#648) */
  forgetBackground(sessionId: string): void {
    this.backgroundUnknown.delete(sessionId)
    this.clearBackgroundHold(sessionId)
    this.host.store.settings.deleteAppSetting(this.host.backgroundTasksKey(sessionId))
  }

  /**
   * Says in the conversation that a restart is about to end the session's background work (#648): the tool's own
   * ending of each task follows in the list, but a person whose dev server stopped should read why where they look.
   */
  noticeBackgroundStopped(sessionId: string, cause: RebuildCause | undefined): void {
    const m = this.host.meta.get(sessionId)
    if (!m || !this.host.handles.has(sessionId)) return
    const why =
      cause === 'launch_settings' ? 'changed launch settings'
      : cause === 'instructions' ? "changed Centralu tool definitions"
      : cause === 'thread_restart' ? 'a change of attached apps'
      : cause === 'model_change' ? 'a model change'
      : this.host.running.get(sessionId)?.permissionPreset !== m.permissionPreset ? 'a permission change'
      : 'changed settings'
    const tasks = liveBackgroundTasks(m.backgroundTasks)
    const text =
      tasks.length > 0
        ? `Restarting the agent to apply ${why}. The background work it was running stops with it: ` +
          `${tasks.map((t) => t.description).join(', ')}. Ask the agent to start it again if you still need it.`
        : this.backgroundUnknown.has(sessionId)
          ? `Restarting the agent to apply ${why}. Any background work it started before Centralu was updated ` +
            `(a dev server, a watcher) stops with it; ask the agent to start it again if you still need it.`
          : null
    if (text) this.host.onEvent({ type: 'notice', sessionId, level: 'warning', from: 'Centralu', label: 'restart', text })
  }

  /**
   * Changes model or permissions (FR-7). If the adapter supports it, it applies starting next turn;
   * if not, only the metadata is updated — it comes up with the new configuration on resume.
   */
  /** A settings restart is a model change when the model is what drifted (§6.1); otherwise a plain new process */
  restartCause(sessionId: string): RebuildCause | undefined {
    const live = this.host.running.get(sessionId)
    const m = this.host.meta.get(sessionId)
    return live && m && live.model !== m.model ? 'model_change' : undefined
  }

  /** Does the configuration the running process received (running) differ from the current one (meta) — false
   * if no process is running */
  settingsDrifted(sessionId: string): boolean {
    const m = this.host.meta.get(sessionId)
    const live = this.host.running.get(sessionId)
    return (
      !!m &&
      !!live &&
      (live.model !== m.model ||
        live.effort !== m.effort ||
        live.verbosity !== m.verbosity ||
        live.serviceTier !== m.serviceTier ||
        launchPreset(live.permissionPreset) !== launchPreset(m.permissionPreset))
    )
  }

  /**
   * A note receipt follows turn_complete: re-check the same deferred change when the last hold is released.
   *
   * Background work (#648). A change of safety (the permission preset, the launch settings, the tool definitions a
   * profile serves) is applied at the end of the turn whatever runs in the background: another turn under the old
   * policy is worse than a stopped dev server, and the conversation says what stopped (`noticeBackgroundStopped`). Any
   * other change (a model, an app set) waits while work the tool listed is running, as a sleep does, and is applied
   * anyway after `BACKGROUND_HOLD_MAX_MS`.
   */
  applyDeferredRestart(sessionId: string): void {
    // The same boundaries free a busy session for the request queued for it (#677)
    if (this.host.children.queued.has(sessionId)) this.host.scheduleDrain(sessionId)
    // Not while the host leaves (#839): a restart now would stop a process the keeper keeps for the next host, or start one nobody stops
    if (this.host.lettingGo) return
    const session = this.host.meta.get(sessionId)
    if (!session || inTurn(session.state) || this.deferredRestarts.has(sessionId) || this.host.inputsHeld(sessionId) || !this.restartAfterTurn.has(sessionId)) return
    const hold = this.backgroundHolds.get(sessionId)
    const holdExpired = !!hold && Date.now() - hold.since >= BACKGROUND_HOLD_MAX_MS
    if (!holdExpired && !this.safetyRestartPending(sessionId) && this.backgroundRunning(sessionId)) {
      this.holdForBackground(sessionId)
      return
    }
    this.restartAfterTurn.delete(sessionId)
    this.clearBackgroundHold(sessionId)
    // An app attached or detached in this turn (#371 part A) is a reason of its own, settings or not.
    const apps = this.appsRestartAfterTurn.delete(sessionId)
    const definitions = this.definitionsRestartAfterTurn.delete(sessionId)
    const launchSettings = this.launchSettingsRestartAfterTurn.delete(sessionId)
    if (!(apps || definitions || launchSettings || this.settingsDrifted(sessionId)) || !this.host.handles.has(sessionId)) return
    const cause = launchSettings ? 'launch_settings' : apps ? 'thread_restart' : definitions ? 'instructions' : this.restartCause(sessionId)
    // Publish the barrier before dispose can emit events or the completed wait can hand the parent its answer.
    const restarting = Promise.resolve().then(() => this.host.restartSession(sessionId, cause)).then(() => {}).finally(() => {
      if (this.deferredRestarts.get(sessionId) === restarting) this.deferredRestarts.delete(sessionId)
      // A drain that met this restart returned: the request queued behind it goes in now (#684 review)
      if (this.host.children.queued.has(sessionId)) this.host.scheduleDrain(sessionId)
    })
    this.deferredRestarts.set(sessionId, restarting)
    void restarting.catch(() => {})
  }

  /** A deferred restart changes what the process may do (#648): its permission preset, launch settings or tool set */
  private safetyRestartPending(sessionId: string): boolean {
    const m = this.host.meta.get(sessionId)
    const live = this.host.running.get(sessionId)
    return (
      this.launchSettingsRestartAfterTurn.has(sessionId) ||
      this.definitionsRestartAfterTurn.has(sessionId) ||
      (!!m && !!live && launchPreset(live.permissionPreset) !== launchPreset(m.permissionPreset))
    )
  }

  /** Holds a non-safety restart for background work, at most `BACKGROUND_HOLD_MAX_MS` (#648) */
  private holdForBackground(sessionId: string): void {
    if (this.backgroundHolds.has(sessionId)) return
    const timer = setTimeout(() => {
      console.error(`[sessions] ${sessionId.slice(0, 8)}: a restart waited ${Math.round(BACKGROUND_HOLD_MAX_MS / 60_000)} min for background work; applying it at the next quiet moment`)
      this.applyDeferredRestart(sessionId)
    }, BACKGROUND_HOLD_MAX_MS)
    timer.unref?.()
    this.backgroundHolds.set(sessionId, { since: Date.now(), timer })
  }

  /** The wait is over: the restart was applied, or the session is gone (#648) */
  clearBackgroundHold(sessionId: string): void {
    const hold = this.backgroundHolds.get(sessionId)
    if (hold) clearTimeout(hold.timer)
    this.backgroundHolds.delete(sessionId)
  }
}
