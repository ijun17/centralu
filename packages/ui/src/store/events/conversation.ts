import { isInTurn, STOP_NOT_CONFIRMED_LABEL, type NormalizedEvent, type SessionState } from '@cc/protocol'
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

/**
 * A session's conversation: an event folded into the session through the core reducer and appended
 * to its rows, held in the pen when the session is not registered yet, and a native subagent's step
 * joined to its launch card.
 */

/**
 * Calls of the orchestrator's proposal tools that have not returned yet, as `sessionId:callId` (a Codex call id may be
 * unique only within its thread): their `tool_result` re-reads the lists (#703)
 */
const proposalCalls = new Set<string>()
const PROPOSAL_CALLS_MAX = 50

/** A native subagent's step (#222): app-wide in where it is handled, before the session guard. True when it was one */
export function subagentStepEvent(e: NormalizedEvent, set: StoreSet, get: StoreGet): boolean {
  /*
   * A native subagent's step (#222). It is not the conversation: it changes no state, adds no row and never moves
   * unread. It only joins a launch card's steps the person has opened, once every earlier step is read (`more`
   * false) — appended past a page not read yet, it would leave a hole in the middle.
   */
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

/** Any other event of a registered session: through the reducer, into the conversation, then the notices */
export function conversationEvent(
  e: NormalizedEvent,
  sessionId: string,
  set: StoreSet,
  get: StoreGet,
): void {
  const cur = get().sessions[sessionId]
  if (!cur) {
    // An event that arrived before the session was registered (the initial prompt streaming right
    // away is one such case). Discarding it would lose the whole first turn, so it is held and
    // replayed right after registration.
    penEvent(sessionId, e, Date.now())
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
   * `chat[id]` being **absent** means "history has not been read yet" — focusing reads that and
   * calls for history. But a non-conversation event (a state change, context usage, and so on)
   * also arrives here, and writing `[]` for it would make that session read as "read, and empty,"
   * so **history is never called for again.** Dogfooding, 2026-09-25: an 11,550-line session
   * looked completely empty after reopening the app. An event the host sent while resuming it had
   * arrived before the user ever clicked that session. So no slot is created for a session that had
   * no conversation to append and no slot yet.
   */
  const had = get().chat[sessionId]
  const appended = stampNew(had ?? [], appendChat(had ?? [], e), Date.now())
  const chat = had === undefined && appended.length === 0 ? undefined : appended
  /*
   * The MCP-server and skill proposal lists are not re-read on the `tool_call` (#703). It arrives when the call starts,
   * before the host has run it and saved the proposal, so a read on it came back with the old list and the card never
   * showed. The host broadcasts `orchestrator_proposals_changed` after it writes a list; that event's handler (in
   * events/lists.ts) is what re-reads them.
   *
   * A safety net for a host that predates that event (an old host still serving during a swap): the call's
   * `tool_result` comes after the save, so it re-reads both lists. `centralu_run` may be either proposal (#512).
   */
  if (e.type === 'tool_call' && /(propose_mcp_server|propose_skill|centralu_run)$/.test(e.summary.tool)) {
    if (proposalCalls.size >= PROPOSAL_CALLS_MAX) proposalCalls.delete(proposalCalls.values().next().value!)
    proposalCalls.add(`${sessionId}:${e.callId}`)
  }
  if (e.type === 'tool_result' && proposalCalls.delete(`${sessionId}:${e.callId}`)) {
    void get().refreshMcpProposals()
    void get().refreshSkillProposals()
  }
  /*
   * A worktree suggestion (#69) — the same principle (pointing), carrying one extra value: the
   * branch name. The adapter carries it in the title (there is no other channel). If the title is
   * exactly the tool's own name, the suggestion has no name — the window opens with an empty name.
   */
  if (e.type === 'tool_call' && /propose_worktree_session$/.test(e.summary.tool) && cur.projectId) {
    const branch = /propose_worktree_session$/.test(e.summary.title) ? '' : e.summary.title
    set((st) => ({
      worktreeProposals: st.worktreeProposals.some(
        (p) => p.projectId === cur.projectId && p.branch === branch,
      )
        ? st.worktreeProposals // The same suggestion arriving again does not queue up a second time (idempotent across replay and reconnect)
        : [...st.worktreeProposals, { projectId: cur.projectId as string, branch }],
    }))
  }
  /*
   * **Unread tracking (`lastSeq`) advances only by the seq the host assigns within the session.**
   *
   * It used to advance by the conversation item's render key (`chatSeq`, shared across every
   * session). That value flows through `markRead` into the host's `last_read_seq`, so after viewing
   * a 200-message session, even a single event arriving in a 2-message session inflated that
   * session's `last_read_seq` to around 201 — and even across a restart, its unread dot never
   * appeared again. The render key and the stored sequence are two different numbering schemes.
   */
  const hostSeq = 'seq' in e && typeof e.seq === 'number' ? e.seq : null
  let withSeq = hostSeq != null ? bumpSeq(next, hostSeq) : next
  // A message sent by me (or by the orchestrator) also gets marked read by the host — the screen follows
  if (e.type === 'user_message') withSeq = markReadPure(withSeq, e.seq)
  /*
   * A lock found after the session was already handed back (#168, item 5) — a slow background
   * resume. The host has dropped the handle, so the session is dormant again, and its dormant line
   * offers the same "Continue in a fork" as a lock found while waking.
   */
  const lockedLate = e.type === 'error' && e.error.code === 'conversation_locked' ? e.error.message : null
  if (lockedLate !== null) withSeq = { ...withSeq, live: false }

  set((st) => {
    const sessions = { ...st.sessions, [sessionId]: withSeq }
    const workingSince = trackWorkingSince(st.workingSince, sessions, Date.now())
    const stop = stopAfter(st.stopping[sessionId], cur.state, withSeq.state, workingSince[sessionId])
    /*
     * An off-screen conversation is cut back to the window (OFFSCREEN_TRIM_AT), never while a page of history is
     * still on its way: that page is merged against the rows it was asked for. The focused session is never cut,
     * even while the orchestrator, the grid or a pinned app covers it: it is the conversation the person returns
     * to, with the pages they loaded and their reading position (docs/state-management.md §4).
     */
    const trimmed =
      chat !== undefined &&
      chat.length > OFFSCREEN_TRIM_AT &&
      sessionId !== st.focusedSessionId &&
      !st.history[sessionId]?.loading &&
      !isOnScreen(st.view, sessionId, {
        focusedSessionId: st.focusedSessionId,
        orchestratorId: st.orchestratorId,
        gridSessions: gridSessionIds(st.gridPanels),
        builderPaneSessionId: st.builderPaneSessionId,
        projectScreen: projectScreenSessions(st),
      })
        ? trimWindow(chat)
        : null
    /*
     * A "Finished" card says the session is waiting for the person. Once the session starts another turn (a
     * message from the person or from an agent), that is no longer true, and a card that stays says it is
     * (#674). Only this session's finished cards go: its approval and error cards still describe something
     * the person has not seen, and other sessions' cards are not about this one.
     */
    const turnBegan = withSeq.state === 'working' && cur.state !== 'working'
    const notices = turnBegan
      ? st.notices.filter((n) => !(n.sessionId === sessionId && n.kind === 'done'))
      : st.notices
    return {
      sessions,
      ...(notices.length !== st.notices.length ? { notices } : {}),
      ...(lockedLate !== null
        ? {
            wakeError: { ...st.wakeError, [sessionId]: lockedLate },
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
      // A turn begins because an event arrived — this is where its start instant is
      // recorded, so the elapsed line survives remounting (issue #23)
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
 * A Stop the person pressed (#1060) as its turn moves on. It goes when the turn ends. Through an approval or a question
 * the turn is the same one, but `workingSince` starts again when the session goes back to working, so the Stop moves to
 * that instant: otherwise the button would read Stop again while the stop is still on its way.
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
