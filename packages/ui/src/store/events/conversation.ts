import { isInTurn, STOP_NOT_CONFIRMED_LABEL, type NormalizedEvent, type SessionState } from '@cc/protocol/client'
import {
  applyEvent,
  bumpSeq,
  gridSessionIds,
  markRead as markReadPure,
  nextStateFor,
  type SessionSummary,
} from '@cc/core'
import { isOnScreen } from '../../app/onscreen.js'
import type { StoreGet, StoreSet } from '../state.js'
import { OFFSCREEN_TRIM_AT, putSubagentSteps, trimWindow, withoutClosedSteps } from '../historyPages.js'
import { projectScreenSessions } from '../screens.js'
import { liveEventWatchers, penEvent, trackWorkingSince } from '../sessionList.js'
import { omitKey } from '../patch.js'
import { appendChat, stampSaid, subagentRow, type ChatItem } from '../transcript.js'
import { notifyStateChange } from './notices.js'

// Proposal tool calls not returned yet, as `sessionId:callId`: a Codex call id may be unique only within its thread
const proposalCalls = new Set<string>()
const PROPOSAL_CALLS_MAX = 50

export function subagentStepEvent(e: NormalizedEvent, set: StoreSet, get: StoreGet): boolean {
  // docs/state-management.md §4: joins an opened launch card only once every earlier step is read, or it leaves a hole
  if (e.type === 'subagent_event') {
    if (e.stepSeq === undefined) return true
    const cur = get().subagentSteps[e.sessionId]?.[e.parentCallId]
    if (!cur || cur.more || cur.rows.some((r) => r.seq === e.stepSeq)) return true
    const row = subagentRow(e.sessionId, e.stepSeq, e.step)
    set((s) =>
      putSubagentSteps(s.subagentSteps, e.sessionId, e.parentCallId, { ...cur, rows: [...cur.rows, row] }),
    )
    return true
  }
  return false
}

export function conversationEvent(
  e: NormalizedEvent,
  sessionId: string,
  set: StoreSet,
  get: StoreGet,
  id?: string,
): void {
  const cur = get().sessions[sessionId]
  if (!cur) {
    // Held and replayed after registration: the first turn can stream before it
    penEvent(sessionId, e, id, Date.now())
    return
  }

  const next = applyEvent(cur, e, Date.now())
  for (const touched of liveEventWatchers) {
    const fields = touched.get(sessionId)!
    // Keep changes even if a later event returns them to their pre-request value.
    for (const k of Object.keys(next) as (keyof SessionSummary)[]) if (next[k] !== cur[k]) fields.add(k)
    if (nextStateFor(e) === next.state) {
      fields.add('state')
      fields.add('waitingSince')
    }
    if (e.type === 'session_live') fields.add('live')
  }
  /*
   * An absent `chat[id]` means history is unread. A `[]` slot for a non-conversation event (one can come while
   * resuming, before the person opens the session) would mean "read, and empty", and history would never be read.
   */
  const had = get().chat[sessionId]
  const appended = stampNew(had ?? [], appendChat(had ?? [], e), Date.now())
  const chat = had === undefined && appended.length === 0 ? undefined : appended
  /*
   * For a host without `orchestrator_proposals_changed`: proposals are re-read on `tool_result`, which comes after the
   * save, not `tool_call`, which comes before (#703). `centralu_run` may be either proposal (#512).
   */
  if (e.type === 'tool_call' && /(propose_mcp_server|propose_skill|centralu_run)$/.test(e.summary.tool)) {
    if (proposalCalls.size >= PROPOSAL_CALLS_MAX) proposalCalls.delete(proposalCalls.values().next().value!)
    proposalCalls.add(`${sessionId}:${e.callId}`)
  }
  if (e.type === 'tool_result' && proposalCalls.delete(`${sessionId}:${e.callId}`)) {
    void get().refreshMcpProposals()
    void get().refreshSkillProposals()
  }
  // A worktree suggestion's branch rides in the title, its only channel (#69); the bare tool name means none
  if (e.type === 'tool_call' && /propose_worktree_session$/.test(e.summary.tool) && cur.projectId) {
    const branch = /propose_worktree_session$/.test(e.summary.title) ? '' : e.summary.title
    set((st) => ({
      worktreeProposals: st.worktreeProposals.some(
        (p) => p.projectId === cur.projectId && p.branch === branch,
      )
        ? st.worktreeProposals // Idempotent across replay and reconnect
        : [...st.worktreeProposals, { projectId: cur.projectId as string, branch }],
    }))
  }
  /*
   * `lastSeq` advances only by the host's per-session seq, never the render key (`chatSeq`, shared across sessions):
   * it flows through `markRead` into the host's `last_read_seq`, and an inflated one hides unread for good.
   */
  const hostSeq = 'seq' in e && typeof e.seq === 'number' ? e.seq : null
  let withSeq = hostSeq != null ? bumpSeq(next, hostSeq) : next
  // The host marks a sent message read; the screen follows
  if (e.type === 'user_message') withSeq = markReadPure(withSeq, e.seq)
  // A lock a slow background resume found (#168 item 5): the host dropped the handle, so the session is dormant
  // and offers "Continue in a fork" as a lock found while waking does
  const lockedLate = e.type === 'error' && e.error.code === 'conversation_locked' ? e.error.message : null
  if (lockedLate !== null) withSeq = { ...withSeq, live: false }

  set((st) => {
    const sessions = { ...st.sessions, [sessionId]: withSeq }
    const workingSince = trackWorkingSince(st.workingSince, sessions, Date.now())
    const stop = stopAfter(st.stopping[sessionId], cur.state, withSeq.state, workingSince[sessionId])
    // docs/state-management.md §4; never while a history page is on its way: it merges against the rows it asked for
    const trimmed =
      chat !== undefined &&
      chat.length > OFFSCREEN_TRIM_AT &&
      sessionId !== st.focusedSessionId &&
      !st.history[sessionId]?.loading &&
      !isOnScreen(st.view, sessionId, {
        focusedSessionId: st.focusedSessionId,
        assistantId: st.assistantId,
        gridSessions: gridSessionIds(st.gridPanels),
        builderPaneSessionId: st.builderPaneSessionId,
        projectScreen: projectScreenSessions(st),
      })
        ? trimWindow(chat)
        : null
    // A new turn makes this session's "Finished" cards untrue (#674); its approval and error cards stay
    const turnBegan = withSeq.state === 'working' && cur.state !== 'working'
    const notices = turnBegan
      ? st.notices.filter((n) => !(n.sessionId === sessionId && n.kind === 'done'))
      : st.notices
    return {
      sessions,
      ...(notices.length !== st.notices.length ? { notices } : {}),
      ...(lockedLate !== null
        ? {
            // This line gives the reason, so the note does not repeat it (#2360)
            wakeError: { ...st.wakeError, [sessionId]: { reason: lockedLate, saidByLine: true } },
            wakeLocked: { ...st.wakeLocked, [sessionId]: true },
          }
        : {}),
      ...(trimmed
        ? {
            history: {
              ...st.history,
              [sessionId]: { oldestSeq: trimmed.oldestSeq, more: trimmed.oldestSeq > 1, loading: false },
            },
            subagentSteps: withoutClosedSteps(st.subagentSteps, sessionId),
          }
        : {}),
      chat: chat === undefined ? st.chat : { ...st.chat, [sessionId]: trimmed ? trimmed.items : chat },
      // Recorded here, not in a view, so the elapsed line survives remounting (#23)
      workingSince,
      ...(stop !== st.stopping[sessionId]
        ? { stopping: stop ? { ...st.stopping, [sessionId]: stop } : omitKey(st.stopping, sessionId) }
        : {}),
    }
  })

  // The tool says the Stop has not taken effect: the button stops saying "Stopping…" and says why (`stopping`)
  if (e.type === 'notice' && e.label === STOP_NOT_CONFIRMED_LABEL && get().stopping[sessionId]) {
    set((st) => ({
      stopping: { ...st.stopping, [sessionId]: { ...st.stopping[sessionId]!, failed: e.text } },
    }))
  }

  notifyStateChange(e, sessionId, cur, withSeq, set, get)
}

type Stop = { turn: number | undefined; failed?: string }

/**
 * A pressed Stop (#1060) goes when its turn ends. Back to working from an approval or question, `workingSince` restarts,
 * so the Stop moves with it, or the button would read Stop again while the stop is on its way.
 */
function stopAfter(
  stop: Stop | undefined,
  from: SessionState,
  to: SessionState,
  since: number | undefined,
): Stop | undefined {
  if (!stop) return stop
  if (!isInTurn(to)) return undefined
  if (from === 'waiting_approval' && to === 'working') return { ...stop, turn: since }
  return stop
}

/** The rows this event added or changed at the end, marked with when they arrived (`ChatItem.at`) */
function stampNew(had: ChatItem[], next: ChatItem[], at: number): ChatItem[] {
  if (next === had) return next
  const from = had.length > 0 && next[had.length - 1] !== had[had.length - 1] ? had.length - 1 : had.length
  if (from >= next.length) return next
  const out = next.slice()
  for (let k = from; k < out.length; k++) out[k] = stampSaid(out[k]!, at)
  return out
}
