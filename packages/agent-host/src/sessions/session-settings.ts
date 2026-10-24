import type { NormalizedEvent, PermissionPreset, SessionInfo, SettingsApplied } from '@cc/protocol'
import { applyBackgroundTasks, oneLineText } from '@cc/protocol'
import { inTurn } from '../idle.js'
import { rpcError } from '../rpc-error.js'
import type { DelegationHost } from './delegation-flow.js'
import type { RestartHost } from './restart-policy.js'
import type { SessionEventsHost } from './session-events.js'
import type { SessionRecordHost } from './session-record.js'
import type { SessionStartsHost } from './session-start.js'
import type { SessionTrashHost } from './session-trash.js'
import type { WorktreeHost } from './worktree-sessions.js'

/**
 * What a session's settings reach of the session manager (#1143), typed as the manager declares each member. The
 * manager builds it with getters for its fields (`SessionManager.parts`), so each is read when used, never kept.
 */
export type SessionSettingsHost = Pick<DelegationHost, 'meta' | 'store' | 'emit' | 'handles' | 'onEvent'> &
  Pick<SessionStartsHost, 'openSession' | 'appSessions' | 'toolLabel'> &
  Pick<SessionTrashHost, 'restartPolicy'> &
  Pick<RestartHost, 'restartSession'> &
  Pick<SessionRecordHost, 'cacheLedger' | 'sessionOf'> &
  Pick<SessionEventsHost, 'queue' | 'requireHandle'> &
  Pick<WorktreeHost, 'resuming'>

/**
 * What the person (or the orchestrator for them) changes on a session: its model, effort and permission preset, its
 * name and read mark, its background tasks; and the notices of a move to a newer CLI. Moved out of the session manager
 * as it was (#1143); what it reaches of the manager is `SessionSettingsHost`.
 */
export class SessionSettings {
  constructor(private readonly host: SessionSettingsHost) {}

  async updateSettings(
    sessionId: string,
    s: { model?: string | null; effort?: string | null; verbosity?: string | null; serviceTier?: string | null; permissionPreset?: PermissionPreset },
    by: 'person' | 'orchestrator' = 'person',
  ): Promise<SessionInfo & { applied: SettingsApplied }> {
    const m = this.host.openSession(sessionId)

    // Another model reads none of this one's cache (§6.1), whether it applies live or through a restart
    if (s.model !== undefined && s.model !== m.model) this.host.cacheLedger.note(sessionId, 'model_change')
    if (s.model !== undefined) m.model = s.model
    if (s.effort !== undefined) m.effort = s.effort
    if (s.verbosity !== undefined) m.verbosity = s.verbosity
    if (s.serviceTier !== undefined) m.serviceTier = s.serviceTier
    const wasAuto = m.permissionPreset === 'auto'
    if (s.permissionPreset) m.permissionPreset = s.permissionPreset
    this.host.store.sessions.upsertSession(m)
    if (wasAuto && m.permissionPreset !== 'auto') this.host.queue.dropOpenedByAuto(sessionId)
    /*
     * The model and effort chosen most recently become this project's default (#69, item 5). The
     * same lesson default_tool learned: instead of building a settings screen, the fact is recorded
     * that the act of choosing already told us. This is where the repetition ends for someone using
     * Opus/high who had to click through the same four clicks on every new session.
     *
     * **Recorded under this session's own tool slot** (#107). There used to be only one slot, which
     * had to be guarded with the condition "only record a choice from a session using the project's
     * default tool" — and that condition broke the moment the default tool changed: a single codex
     * session switching the default back to codex would let the next codex choice overwrite the value
     * saved for claude. Now that the tool is part of the key, no condition is needed: any tool's
     * choice lands only in its own slot.
     */
    if ((s.model !== undefined || s.effort !== undefined) && m.projectId) {
      const before = this.host.store.projects.projectToolDefaults(m.projectId)[m.tool]
      this.host.store.projects.setProjectToolDefaults(m.projectId, m.tool, { model: m.model, effort: m.effort })
      // Another window starts its next session on what this one chose last (#719)
      if ((before?.model ?? null) !== (m.model || null) || (before?.effort ?? null) !== (m.effort || null)) this.host.emit({ type: 'projects_changed' })
    }
    /*
     * **Every client hears about a saved change** (#659). The caller gets the answer, but another window, a linked
     * machine, or the person's own window when an agent made the call only learned the new values from a re-list.
     * The permission preset is among them, and it is shown on screen as a safety fact. Sent as soon as the change is
     * saved, with the full snapshot, before the wait below: whether the process takes it now, after the turn or on
     * the next wake does not change what the session is set to.
     */
    this.host.emit({
      type: 'settings_changed',
      sessionId,
      model: m.model,
      effort: m.effort,
      verbosity: m.verbosity,
      serviceTier: m.serviceTier,
      permissionPreset: m.permissionPreset,
      ...(by === 'person' ? { person: true } : { by }),
    })

    /*
     * **If a wake is in progress, this waits for it before comparing** (#162). While that wait is in
     * flight there is no handle, so the comparison below would do nothing, and the process that comes
     * up would run with the value from before the change — the screen says safe, the process runs
     * auto. A second change arriving mid-restart lands in the same window too (while restartSession is
     * tearing down and re-creating the handle). Since the save already happened above, even if this
     * call is interrupted while waiting, the next time it comes up it comes up with the new value.
     */
    await this.host.resuming.get(sessionId)?.catch(() => {})

    const handle = this.host.handles.get(sessionId)
    handle?.updateSettings?.(s)
    // `normal` <-> `edits` replaces no process (`launchPreset`): the adapter reads the preset at each call (#1525)
    if (s.permissionPreset) handle?.setPermissionPreset?.(m.permissionPreset)

    // The comparison baseline is not the screen's value (meta) but **the configuration the running process
    // actually has**
    const drifted = this.host.restartPolicy.settingsDrifted(sessionId)

    /**
     * Permissions and model are **fixed the moment the tool process is launched.**
     * Claude receives permissionMode at the start of query(), and Codex receives approvalPolicy at
     * thread/start. So fixing only the metadata of a living session leaves the screen saying "auto"
     * while it keeps asking for approval anyway — this surfaced during dogfooding as "I changed
     * permissions to auto, so why does it keep asking".
     *
     * If the adapter does not support applying it live, **the process itself is swapped.**
     * The conversation is not interrupted, since resume carries it forward. Better than silently
     * ignoring the change.
     */
    let applied: SettingsApplied = 'saved'
    if (drifted && handle && !handle.updateSettings) {
      /*
       * **A running turn is never interrupted** (#164) — the change is only saved, and the swap
       * happens when the turn ends (completed, error, canceled — in onEvent). This keeps what the
       * person is told ("starting next turn") consistent with what actually happens. The
       * orchestrator's own settings tool goes through this same path too.
       */
      if (inTurn(m.state)) {
        this.host.restartPolicy.restartAfterTurn.add(sessionId)
        applied = 'after_turn'
      } else {
        applied = (await this.host.restartSession(sessionId, this.host.restartPolicy.restartCause(sessionId))).resumed ? 'restarted' : 'saved'
      }
    }

    return { ...m, live: this.host.handles.has(sessionId), applied }
  }

  /**
   * Stops one of the session's background tasks (#290). Only a task the adapter listed as running and stoppable is
   * asked for — an id from an old list, or a task the tool cannot stop alone, is refused with a reason instead of
   * being sent. The ending arrives as the session's next `background_tasks` event.
   */
  async stopBackgroundTask(sessionId: string, taskId: string): Promise<void> {
    const handle = this.host.requireHandle(sessionId)
    const task = this.host.meta.get(sessionId)?.backgroundTasks.find((t) => t.id === taskId && t.status === 'running')
    if (!task) throw rpcError('That background task is no longer running')
    if (!task.stoppable || !handle.stopBackgroundTask) {
      throw rpcError('This task cannot be stopped on its own')
    }
    await handle.stopBackgroundTask(taskId)
  }

  /** Takes the ended tasks off the session's list (#290); the running ones stay. */
  clearBackgroundTasks(sessionId: string): void {
    const m = this.host.sessionOf(sessionId)
    const e: NormalizedEvent = { type: 'background_tasks', sessionId, live: m.backgroundTasks.filter((t) => t.status === 'running'), clearEnded: true }
    m.backgroundTasks = applyBackgroundTasks(m.backgroundTasks, e)
    this.host.emit(e)
  }

  /**
   * Says in the conversation that the session moved to a newer CLI (#297): restarting a process by itself is never
   * silent. A notice from Centralu, not from the tool, so it reads as what happened rather than as something to fix.
   */
  noteAgentMoved(sessionId: string, from: string, to: string): void {
    const m = this.host.meta.get(sessionId)
    if (!m) return
    const label = this.host.toolLabel(m.tool)
    this.host.onEvent({
      type: 'notice',
      sessionId,
      level: 'info',
      from: 'Centralu',
      label: 'agent update',
      text: `${label} restarted on ${to} (was ${from}). The conversation continues.`,
    })
  }

  noteAgentMoveFailed(sessionId: string, to: string, why: string): void {
    const m = this.host.meta.get(sessionId)
    if (!m) return
    this.host.onEvent({
      type: 'notice',
      sessionId,
      level: 'warning',
      from: 'Centralu',
      label: 'agent update',
      text: `${this.host.toolLabel(m.tool)} could not restart on ${to}: ${why}. The session stays on its current version; restart it to try again.`,
    })
  }

  /**
   * The person sets a name (FR-18).
   *
   * **autoNamed is cleared so an auto-name can never overwrite it again.** An auto-name cuts down the
   * first prompt, but a session created by resuming or importing all share the same first line, so
   * four sessions named `This session is being continued…` once stood side by side in the list — the
   * name alone could not distinguish anything, and the body itself had to be searched (issue #5). So a
   * name the person has chosen once must survive no matter what happens.
   *
   * **Never silently passes through.** This used to just `return` when the session did not exist, and
   * the RPC still reported `{ ok: true }` — the name never changed, but the screen wore the face of success.
   */
  rename(sessionId: string, name: string): void {
    const m = this.host.sessionOf(sessionId)
    // One line (#838): a name goes into the model's text (list_sessions, cards, reports), where a line break started a line of its own
    const next = oneLineText(name)
    // An empty name becomes a row in the list that points at nothing at all — accepting it would create a
    // nameless session
    if (!next) throw rpcError('Session name cannot be empty')
    m.name = next
    m.autoNamed = false
    this.host.store.sessions.upsertSession(m)
    // auto:false — the receiving side needs to know "the person set this" in order to block the next
    // auto-name
    this.host.emit({ type: 'session_title', sessionId, title: next, auto: false })
  }

  markRead(sessionId: string, seq: number): void {
    const m = this.host.meta.get(sessionId)
    if (!m) return
    // The person has this session open (#378): an app's agent session they read becomes theirs
    this.host.appSessions.noteTookPart(sessionId, 'opened')
    m.lastReadSeq = Math.max(m.lastReadSeq, seq)
    this.host.store.sessions.markRead(sessionId, seq)
  }
}
