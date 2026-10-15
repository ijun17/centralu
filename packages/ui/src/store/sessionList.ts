import type { NormalizedEvent, SessionInfo } from '@cc/protocol'
import { initialSession, type SessionSummary } from '@cc/core'
import type { AppState } from './state.js'

/**
 * Which sessions the store holds: a host's session list merged over them without undoing what
 * changed while the list was out (`mergeListedSince`), the turn clock kept in step with them
 * (`trackWorkingSince`), what goes when one is gone (`forgetSessions`), and the events held for a
 * session not registered yet (`penEvent`, `replayPendingEvents`).
 */

/**
 * Picks out only the **while-alive facts** from `SessionInfo` (approval, questions, activity,
 * limit, usage).
 *
 * These values live only in the host's memory, so if they are not carried over when the list
 * arrives after a reconnect or restart, a session can sit at `state=waiting_approval` with no card
 * payload and the approval never shows up on screen. Not spread whole, because `SessionInfo` has
 * fields `SessionSummary` does not (`externalId`, `createdAt`, …) that must not leak in.
 */
export function liveFactsOf(
  s: SessionInfo,
): Pick<
  SessionSummary,
  'pendingApproval' | 'pendingQuestions' | 'activity' | 'limit' | 'usage' | 'context' | 'backgroundTasks' | 'agentVersion' | 'machine' | 'unreachable' | 'interruption'
> {
  return {
    pendingApproval: s.pendingApproval,
    pendingQuestions: s.pendingQuestions,
    activity: s.activity,
    limit: s.limit,
    usage: s.usage,
    context: s.context,
    // Background work (#290) lives in the host's memory too — a reconnect reads back what was running and what ended
    backgroundTasks: s.backgroundTasks,
    // So does the CLI version the process runs (#297)
    agentVersion: s.agentVersion,
    /*
     * Where it runs, and whether the hub answered for its machine from the mirror (#82). Taken on every list read, so a
     * machine coming back (its `machine_resync`) clears the mark the list read while it was away left behind.
     */
    machine: s.machine ?? null,
    unreachable: s.unreachable === true,
    // Why the last turn did not finish (#698); stored by the host, so it comes back after a restart too
    interruption: s.interruption ?? null,
  }
}

/**
 * One session's summary from a fresh `sessions.list` row, merged over what the store already holds (`cur`).
 *
 * Shared by initial attach, reconnect recovery and a machine's recovery (#82):
 * two places that construct one thing have to ask for one set (#37). Only the facts the host knows are overwritten;
 * local derived state (preview, `touchedPaths`, …) belongs to the reducer and is kept.
 */
function mergeListed(cur: SessionSummary | undefined, f: SessionInfo): SessionSummary {
  return cur
    ? {
        ...cur,
        projectId: f.projectId,
        kind: f.kind,
        appId: f.appId,
        askedBy: f.askedBy ?? null,
        forkedFrom: f.forkedFrom ?? null,
        goal: f.goal,
        tool: f.tool,
        name: f.name,
        autoNamed: f.autoNamed,
        state: f.state,
        live: f.live,
        // `lastSeq` might already be further ahead here from an event we received — winding it back would resurrect an unread mark
        lastSeq: Math.max(cur.lastSeq, f.lastSeq),
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
    : {
        ...initialSession({
          id: f.id,
          projectId: f.projectId,
          kind: f.kind,
          appId: f.appId,
          askedBy: f.askedBy ?? null,
          forkedFrom: f.forkedFrom ?? null,
          goal: f.goal,
          name: f.name,
          tool: f.tool,
          effort: f.effort,
          verbosity: f.verbosity,
          serviceTier: f.serviceTier,
          model: f.model,
          permissionPreset: f.permissionPreset,
          worktree: f.worktree,
          parentSessionId: f.parentSessionId,
          merged: f.worktreeMerged,
          pr: f.worktreePr,
        }),
        autoNamed: f.autoNamed,
        state: f.state,
        live: f.live,
        lastSeq: f.lastSeq,
        lastReadSeq: f.lastReadSeq,
        waitingSince: f.waitingSince,
        ...liveFactsOf(f),
      }
}

/**
 * The sessions and fields live events named while a `sessions.list` was out, one map per read in flight
 * (`watchLiveEvents`). Empty whenever no recovery is reading, so it never holds anything for long.
 */
type LiveEventFields = Map<string, Set<keyof SessionSummary>>
export const liveEventWatchers = new Set<LiveEventFields>()

/** Starts noting which sessions and fields live events touch until `stop` */
export function watchLiveEvents(): { touched: LiveEventFields; stop: () => void } {
  const touched: LiveEventFields = new Map()
  liveEventWatchers.add(touched)
  return { touched, stop: () => liveEventWatchers.delete(touched) }
}

/**
 * The sessions a fresh `sessions.list` describes, merged over what the store holds **now**, without undoing what
 * changed after the list was asked for.
 *
 * Events keep arriving while the list is out, and the list can be older than them: the hub answers once every linked
 * machine has, so its own rows may be read long before the answer leaves (`links/router.ts`). Applying the rows as
 * they stand turned a session that `session_created` registered during the wait into a deleted one (it was not in
 * the list), and wrote an answered approval, an older state or read position back over the live ones. So, against
 * `asked` (the sessions when the list was requested):
 *
 * - a field the store changed since then keeps the store's value; every other field takes the list's
 * - a session that left the store since then (`session_deleted`) is not brought back by an older row
 * - a session the list lacks is kept if it arrived since then, or a live event named it since then (`touched`);
 *   otherwise it was deleted during the gap and is reported in `gone`
 *
 * `include` limits which held sessions this list speaks for (a machine's recovery only speaks for its own).
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
    else if (listed.has(id)) sessions[id] = keepChangedSince(asked[id], cur, mergeListed(cur, listed.get(id)!), touched.get(id))
    else if (!asked[id] || touched.has(id)) sessions[id] = cur
    else gone.add(id)
  }
  for (const [id, f] of listed) if (!sessions[id] && !gone.has(id) && !asked[id]) sessions[id] = mergeListed(undefined, f)
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
  // Re-attachment can reaffirm working/live without changing either pre-swap value (#640).
  // Those reports still supersede a list captured during the replacement host's startup reset.
  for (const k of reported ?? []) out[k] = cur[k]
  return out as SessionSummary
}

/**
 * Keep `workingSince` in step with who is actually working (issue #23).
 *
 * A session that starts a turn gets the current instant; one that stops working loses its
 * entry, so the next turn cannot inherit the previous turn's start. An entry that is
 * already there is never overwritten — that is the whole point, since a turn's start does
 * not move just because we looked again.
 *
 * Returns `prev` unchanged when nothing moved. Zustand hands this object straight to
 * subscribers, so allocating a fresh one per streaming delta would re-render every reader
 * of it a few times a second for no reason.
 *
 * Sessions that were already running before we knew about them (first attach, reconnect)
 * are stamped with the moment we found out. That is not when the turn began, and we cannot
 * know when it did — the host does not send it. It is the earliest instant we can honestly
 * claim, and it is still stable across every view change after that.
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
  // Drop instants for sessions that no longer exist — the ids never come back, but the map grows
  for (const id of Object.keys(prev)) if (!sessions[id]) delete copy()[id]
  return next
}

/**
 * Everything the store keeps per session, for sessions that are gone. Kept in one place so a deletion and a
 * reconnect that finds a session missing clear the same things.
 *
 * Everything kept per session goes together (#163). A leftover notification card would focus a nonexistent
 * session on click, showing "Select a project or session." The rest (history cursor, draft, wake error) is dead
 * weight nobody reads any more. The conversation's views go too — the host has already closed the instance — and
 * the read position goes with the session (#61). An id can come back: restoring a session from the trash brings
 * it back under the same id, and it then opens like a session read for the first time.
 */
export function forgetSessions(s: AppState, gone: ReadonlySet<string>): Partial<AppState> {
  if (gone.size === 0) return {}
  const keep = <T,>(obj: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {}
    for (const [id, v] of Object.entries(obj)) if (!gone.has(id)) out[id] = v
    return out
  }
  // Events parked for a session that will now never register would wait forever
  for (const id of gone) pendingEvents.delete(id)
  return {
    chat: keep(s.chat),
    inlineViews: keep(s.inlineViews),
    scrollAnchor: keep(s.scrollAnchor),
    notices: s.notices.filter((n) => !gone.has(n.sessionId)),
    history: keep(s.history),
    subagentSteps: keep(s.subagentSteps),
    drafts: keep(s.drafts),
    stickToBottom: keep(s.stickToBottom),
    searchTargets: keep(s.searchTargets),
    wakeError: keep(s.wakeError),
    wakeLocked: keep(s.wakeLocked),
    focusedSessionId: s.focusedSessionId && gone.has(s.focusedSessionId) ? null : s.focusedSessionId,
  }
}

/** A holding pen for events belonging to a session not yet registered in the store (replayed right after registration) */
const pendingEvents = new Map<string, { since: number; events: NormalizedEvent[] }>()

/**
 * How many events the pen holds for one session, and for how long (#392).
 *
 * A session registers within moments of its first event: `createSession` answers, or `attach` and a
 * reconnect read the list. An event for a session that never registers stayed in the pen for the
 * life of the window: a late event for a session already deleted (its `session_deleted` cleared the
 * pen before it arrived), or one for a session the list does not carry. Ten minutes is far past any
 * registration; a pen older than that is for a session that is not coming. Past the count, the
 * oldest half goes: the host has already written that output to its store, and opening the
 * session reads it from there.
 */
export const PENDING_EVENTS_MAX = 2000
export const PENDING_EVENTS_MAX_AGE_MS = 10 * 60_000

/** Holds an event for a session not yet registered, and lets go of pens no session is coming for */
export function penEvent(sessionId: string, e: NormalizedEvent, now: number): void {
  for (const [id, pen] of pendingEvents) if (now - pen.since > PENDING_EVENTS_MAX_AGE_MS) pendingEvents.delete(id)
  let pen = pendingEvents.get(sessionId)
  if (!pen) pendingEvents.set(sessionId, (pen = { since: now, events: [] }))
  // Pushed in place: copying the pen for every event made a burst of n events cost n² (#392)
  pen.events.push(e)
  if (pen.events.length > PENDING_EVENTS_MAX) pen.events.splice(0, PENDING_EVENTS_MAX / 2)
}

/**
 * Replays events held while waiting for registration, in order, **only for sessions now
 * registered**.
 *
 * While only `createSession` drained this holding pen, events for a session that had already been
 * running on the host before the app was even opened stayed in the pen forever if they arrived
 * before `attach` registered the list — the entire output of the first turn was lost until a
 * restart. This is now called at every point a session gets registered. Cleared from the pen before
 * replay, so even overlapping calls never apply the same event twice.
 */
export function replayPendingEvents(get: () => AppState): void {
  for (const id of [...pendingEvents.keys()]) {
    if (!get().sessions[id]) continue
    const buffered = pendingEvents.get(id)!
    pendingEvents.delete(id)
    for (const e of buffered.events) get().dispatchEvent(e)
  }
}
