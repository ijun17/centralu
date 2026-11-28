import { roleTextDemanded, type NormalizedEvent, type SessionInfo } from '@cc/protocol/client'
import { initialSession, type SessionSummary } from '@cc/core'
import type { AppState } from './state.js'

/**
 * Facts mostly held only in the host's memory: a list read after a reconnect that dropped them would leave a
 * `waiting_approval` session with no card. Not spread whole: `SessionInfo` has fields `SessionSummary` must not take.
 */
function liveFactsOf(
  s: SessionInfo,
): Pick<
  SessionSummary,
  'pendingApproval' | 'pendingQuestions' | 'activity' | 'limit' | 'usage' | 'context' | 'backgroundTasks' | 'agentVersion' | 'machine' | 'unreachable' | 'interruption' | 'startedFromHub'
> {
  return {
    pendingApproval: s.pendingApproval,
    pendingQuestions: s.pendingQuestions,
    activity: s.activity,
    limit: s.limit,
    usage: s.usage,
    context: s.context,
    backgroundTasks: s.backgroundTasks,
    agentVersion: s.agentVersion,
    // Taken on every list read, so a machine's resync clears the mirror mark a read while it was away left (#82)
    machine: s.machine ?? null,
    unreachable: s.unreachable === true,
    // Stored by the host (#698), so it survives a restart too
    interruption: s.interruption ?? null,
    // From a linked computer (#1273): the header shows its preset, the sidebar row does not (owner, 2026-11-05)
    startedFromHub: s.startedFromHub === true,
  }
}

/**
 * The only place a row is built from `SessionInfo` (list reads, `session_created`, `createSession`'s answer), so they
 * cannot drift (#37). What the reducer derived in `cur` (preview, `touchedPaths`, …) is kept.
 */
export function sessionFromInfo(f: SessionInfo, cur?: SessionSummary): SessionSummary {
  return {
    ...(cur ?? initialSession({ id: f.id, projectId: f.projectId, name: f.name, tool: f.tool })),
    projectId: f.projectId,
    kind: f.kind,
    roleText: roleTextDemanded(f),
    appId: f.appId,
    askedBy: f.askedBy ?? null,
    forkedFrom: f.forkedFrom ?? null,
    goal: f.goal,
    tool: f.tool,
    name: f.name,
    autoNamed: f.autoNamed,
    state: f.state,
    live: f.live,
    // An event may have moved `lastSeq` past the list's; winding it back would resurrect an unread mark
    lastSeq: Math.max(cur?.lastSeq ?? 0, f.lastSeq),
    lastReadSeq: f.lastReadSeq,
    waitingSince: f.waitingSince,
    model: f.model,
    effort: f.effort,
    verbosity: f.verbosity,
    serviceTier: f.serviceTier,
    permissionPreset: f.permissionPreset,
    worktree: f.worktree,
    parentSessionId: f.parentSessionId,
    merged: f.worktreeMerged,
    pr: f.worktreePr,
    ...liveFactsOf(f),
  }
}

/** The sessions and fields live events named while a `sessions.list` was out, one map per read in flight */
type LiveEventFields = Map<string, Set<keyof SessionSummary>>
export const liveEventWatchers = new Set<LiveEventFields>()

export function watchLiveEvents(): { touched: LiveEventFields; stop: () => void } {
  const touched: LiveEventFields = new Map()
  liveEventWatchers.add(touched)
  return { touched, stop: () => liveEventWatchers.delete(touched) }
}

/**
 * A list can be older than the live events (docs/state-management.md §5), so it merges against `asked`, the sessions
 * when it was asked for. A session it lacks is `gone` only if `asked` had it and no live event named it since.
 * `include` limits which held sessions this list speaks for (a machine's recovery only for its own).
 */
export function mergeListedSince(
  asked: Record<string, SessionSummary>,
  now: Record<string, SessionSummary>,
  fresh: Iterable<SessionInfo>,
  touched: ReadonlyMap<string, ReadonlySet<keyof SessionSummary>>,
  include: (s: SessionSummary) => boolean = () => true,
): { sessions: Record<string, SessionSummary>; gone: Set<string> } {
  const listed = new Map<string, SessionInfo>()
  for (const f of fresh) listed.set(f.id, f)
  const sessions: Record<string, SessionSummary> = {}
  const gone = new Set<string>()
  for (const [id, cur] of Object.entries(now)) {
    if (!include(cur)) sessions[id] = cur
    else if (listed.has(id)) sessions[id] = keepChangedSince(asked[id], cur, sessionFromInfo(listed.get(id)!, cur), touched.get(id))
    else if (!asked[id] || touched.has(id)) sessions[id] = cur
    else gone.add(id)
  }
  for (const [id, f] of listed) if (!sessions[id] && !gone.has(id) && !asked[id]) sessions[id] = sessionFromInfo(f)
  return { sessions, gone }
}

/** `merged`, with every field of `cur` that differs from `asked` put back: the store learned those after the list was asked for */
function keepChangedSince(asked: SessionSummary | undefined, cur: SessionSummary, merged: SessionSummary, reported?: ReadonlySet<keyof SessionSummary>): SessionSummary {
  if (cur === asked && !reported?.size) return merged
  // Arrived since: everything the store holds is newer than the request
  if (!asked) return cur
  const out = { ...merged } as Record<string, unknown>
  const was = asked as Record<string, unknown>
  for (const [k, v] of Object.entries(cur)) if (v !== was[k]) out[k] = v
  // Re-attachment reaffirms working/live at their pre-swap values (#640); they still win over the list
  for (const k of reported ?? []) out[k] = cur[k]
  return out as SessionSummary
}

/**
 * One start per turn (#23): an entry is never overwritten and goes when the session stops working. Returns `prev`
 * when nothing moved, so a streaming delta re-renders no reader. A session found already working is stamped when
 * found: the host does not send when its turn began.
 */
export function trackWorkingSince(
  prev: Record<string, number>,
  sessions: Record<string, SessionSummary>,
  now: number,
): Record<string, number> {
  let next = prev
  const copy = () => (next === prev ? (next = { ...prev }) : next)
  for (const s of Object.values(sessions)) {
    if (s.state === 'working') {
      if (prev[s.id] == null) copy()[s.id] = now
    } else if (prev[s.id] != null) {
      delete copy()[s.id]
    }
  }
  for (const id of Object.keys(prev)) if (!sessions[id]) delete copy()[id]
  return next
}

/**
 * Everything kept per session goes together (#163), for a deletion and a reconnect that finds it missing alike: a
 * leftover notice would focus a missing session. A draft with words moves to `keptDrafts` (#378): a session can go
 * without the person asking (an app's agent session ends with its run).
 */
export function forgetSessions(s: AppState, gone: ReadonlySet<string>): Partial<AppState> {
  if (gone.size === 0) return {}
  const keep = <T,>(obj: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {}
    for (const [id, v] of Object.entries(obj)) if (!gone.has(id)) out[id] = v
    return out
  }
  // Events parked for a session that will never register would wait forever
  for (const id of gone) pendingEvents.delete(id)
  const lost = [...gone]
    .filter((id) => s.drafts[id]?.text.trim())
    .map((id) => ({ sessionId: id, name: s.sessions[id]?.name ?? null, text: s.drafts[id]!.text }))
  return {
    // A session restored and deleted again keeps its newer text
    ...(lost.length ? { keptDrafts: [...s.keptDrafts.filter((d) => !gone.has(d.sessionId)), ...lost] } : {}),
    chat: keep(s.chat),
    inlineViews: keep(s.inlineViews),
    scrollAnchor: keep(s.scrollAnchor),
    notices: s.notices.filter((n) => !gone.has(n.sessionId)),
    history: keep(s.history),
    subagentSteps: keep(s.subagentSteps),
    foldOpen: keep(s.foldOpen),
    drafts: keep(s.drafts),
    stickToBottom: keep(s.stickToBottom),
    searchTargets: keep(s.searchTargets),
    wakeError: keep(s.wakeError),
    wakeLocked: keep(s.wakeLocked),
    watches: keep(s.watches),
    focusedSessionId: s.focusedSessionId && gone.has(s.focusedSessionId) ? null : s.focusedSessionId,
    // The Assistant shows its start state; the next question starts a fresh session (#1653)
    assistantId: s.assistantId && gone.has(s.assistantId) ? null : s.assistantId,
  }
}

const pendingEvents = new Map<string, { since: number; events: { e: NormalizedEvent; id: string | undefined }[] }>()

/**
 * The pen's limits (#392): an event for a session that never registers (already deleted, or not listed) would stay for
 * the window's life. Ten minutes is far past any registration; past the count the oldest half goes, which opening the
 * session reads back from the host's store.
 */
export const PENDING_EVENTS_MAX = 2000
export const PENDING_EVENTS_MAX_AGE_MS = 10 * 60_000

export function penEvent(sessionId: string, e: NormalizedEvent, id: string | undefined, now: number): void {
  for (const [id, pen] of pendingEvents) if (now - pen.since > PENDING_EVENTS_MAX_AGE_MS) pendingEvents.delete(id)
  let pen = pendingEvents.get(sessionId)
  if (!pen) pendingEvents.set(sessionId, (pen = { since: now, events: [] }))
  // Pushed in place: copying the pen per event makes a burst of n events cost n² (#392)
  pen.events.push({ e, id })
  if (pen.events.length > PENDING_EVENTS_MAX) pen.events.splice(0, PENDING_EVENTS_MAX / 2)
}

/**
 * Called at every registration, not only `createSession`: events of a session running before the app opened can arrive
 * before `attach` lists it, and left in the pen the first turn's output is lost. Taken out of the pen before replay, so
 * overlapping calls never apply an event twice.
 */
export function replayPendingEvents(get: () => AppState): void {
  for (const id of [...pendingEvents.keys()]) {
    if (!get().sessions[id]) continue
    const buffered = pendingEvents.get(id)!
    pendingEvents.delete(id)
    for (const { e, id } of buffered.events) get().dispatchEvent(e, id)
  }
}
