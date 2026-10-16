import { SUBAGENT_STEPS_PAGE, type StoredMessage } from '@cc/protocol'
import type { AppState, StoreGet, StoreSet } from './state.js'
import { HISTORY_PAGE, SUBAGENT_STEPS_UNREAD, mergeBySeq, mergePage, prependPage, putSubagentSteps, readBack } from './historyPages.js'
import { RECOVERY_RETRY_MS } from './connection.js'
import { inlineViewsFromHistory, mergeInlineHistory, syncInlineViews } from './apps.js'
import { omitKey } from './patch.js'
import { bumpChatKeysAbove, messagesToChat } from './transcript.js'

/**
 * Reading a conversation's history from the host's store: its newest page, the page around a search
 * hit, an older page, and a launch card's subagent steps. The merge rules are in historyPages.ts.
 */

/** The store's actions that read a conversation's history */
type HistoryActions = Pick<
  AppState,
  | 'loadHistory'
  | 'loadHistoryAt'
  | 'loadOlder'
  | 'toggleSubagentSteps'
  | 'loadMoreSubagentSteps'
>

export const historyActions = (set: StoreSet, get: StoreGet): HistoryActions => ({
  async loadHistory(sessionId) {
    const platform = get().platform
    if (!platform) return
    /*
     * A page that fails to arrive is asked for again (`RECOVERY_RETRY_MS`), and meanwhile the cursor is dropped.
     * Swallowing the failure left a re-read's gap for good: a resync re-reads sessions that already hold a cursor,
     * and a cursor is what tells the screen and `focusSession` the conversation was read, so nothing read it again
     * until the app was reopened. Without the cursor, opening the conversation reads it again too.
     */
    let msgs: StoredMessage[]
    for (let attempt = 0; ; attempt++) {
      const held = get().history[sessionId]
      try {
        msgs = await platform.agents.loadMessages(sessionId, HISTORY_PAGE)
        break
      } catch {
        // A cursor some other read set meanwhile is a successful read, and stays
        set((s) => {
          if (!held || s.history[sessionId] !== held) return {}
          const { [sessionId]: _dropped, ...history } = s.history
          return { history }
        })
        const wait = RECOVERY_RETRY_MS[attempt]
        // Even if history fails to load, a new conversation is still possible, so the last failure is not shown
        if (wait === undefined) return
        await new Promise((r) => setTimeout(r, wait))
        if (get().platform !== platform || !get().sessions[sessionId]) return
      }
    }
    try {
      const items = messagesToChat(msgs)
      bumpChatKeysAbove(items)
      set((s) => {
        /*
         * Screen rows are merged with history, never discarded (#79, `mergePage`). This used to
         * discard the page whenever rows existed on screen — setting the cursor from the discarded
         * page. Re-reads (catching up on a conversation continued elsewhere, filling a gap) go
         * through the same path: within the page's range, history is the source of truth, and only
         * whatever streams after it belongs to the screen.
         * The cursor is the stored number of the top row of the merged result: the page's first
         * row, or the cursor the person had already read back to when those rows are kept (`readBack`).
         */
        const have = s.chat[sessionId] ?? []
        const held = s.history[sessionId]
        const read = readBack(have, held, msgs)
        const merged = mergePage(have, items, msgs)
        return {
          chat: { ...s.chat, [sessionId]: read.length ? prependPage(merged, read) : merged },
          // Slots for past cards' app views (M4 B-1) — a view this UI already knows about (a live one) is left as is
          inlineViews: mergeInlineHistory(s.inlineViews, sessionId, inlineViewsFromHistory(msgs)),
          history: {
            ...s.history,
            [sessionId]:
              read.length && held
                ? { oldestSeq: held.oldestSeq, more: held.more, loading: false }
                : { oldestSeq: msgs[0]?.seq ?? 0, more: msgs.length >= HISTORY_PAGE, loading: false },
          },
        }
      })
    } catch {
      // A page that cannot be turned into rows is not worth taking the screen down for; the conversation goes on
      return
    }
    await syncInlineViews(get, set, sessionId)
  },

  async loadHistoryAt(sessionId, seq) {
    const platform = get().platform
    if (!platform) return
    try {
      // `beforeSeq` is exclusive. The first page ends on the row search named; the second
      // extends the window past it. Together they avoid walking every page from a long
      // conversation's newest message while still leaving context after the matched line.
      const [before, after] = await Promise.all([
        platform.agents.loadMessages(sessionId, HISTORY_PAGE, seq + 1),
        platform.agents.loadMessages(sessionId, HISTORY_PAGE, seq + HISTORY_PAGE + 1),
      ])
      const msgs = mergeBySeq(before, after)
      if (get().searchTargets[sessionId]?.seq !== seq) return
      const items = messagesToChat(msgs)
      bumpChatKeysAbove(items)
      set((s) => {
        const merged = mergePage(s.chat[sessionId] ?? [], items, msgs)
        return {
          chat: { ...s.chat, [sessionId]: merged },
          inlineViews: mergeInlineHistory(s.inlineViews, sessionId, inlineViewsFromHistory(msgs)),
          history: {
            ...s.history,
            [sessionId]: { oldestSeq: msgs[0]?.seq ?? 0, more: msgs.length >= HISTORY_PAGE, loading: false },
          },
        }
      })
      await syncInlineViews(get, set, sessionId)
    } catch {
      // Remove the temporary cursor so the ordinary first-open read can recover the view.
      set((s) => ({ history: omitKey(s.history, sessionId) }))
    }
  },

  async loadOlder(sessionId) {
    const platform = get().platform
    const cur = get().history[sessionId]
    if (!platform || !cur?.more || cur.loading || cur.oldestSeq <= 1) return
    const asked = { ...cur, loading: true }
    set((s) => ({ history: { ...s.history, [sessionId]: asked } }))
    /*
     * The page is only good for the cursor it was asked from (#79). A re-read that lands while this
     * one is out (`loadHistory`: a catch-up, a resync) or a trim on leaving the session moves the
     * cursor and the rows under it; prepending the page then left the rows between it and the new
     * cursor out for good, since the cursor was set below them. Such a page is dropped: the cursor
     * that replaced it is right, and the next scroll asks again from there.
     */
    const stale = () => get().history[sessionId] !== asked
    try {
      const msgs = await platform.agents.loadMessages(sessionId, HISTORY_PAGE, cur.oldestSeq)
      if (stale()) return
      const older = messagesToChat(msgs)
      bumpChatKeysAbove(older)
      set((s) => ({
        chat: { ...s.chat, [sessionId]: prependPage(s.chat[sessionId] ?? [], older) },
        inlineViews: mergeInlineHistory(s.inlineViews, sessionId, inlineViewsFromHistory(msgs)),
        history: {
          ...s.history,
          [sessionId]: {
            oldestSeq: msgs[0]?.seq ?? cur.oldestSeq,
            more: msgs.length >= HISTORY_PAGE,
            loading: false,
          },
        },
      }))
    } catch (e) {
      // Putting the old cursor back over one a re-read set meanwhile would undo the re-read
      if (stale()) return
      set((s) => ({
        history: { ...s.history, [sessionId]: { ...cur, loading: false } },
        toast: `Could not load past conversation: ${(e as Error).message}`,
      }))
    }
  },

  toggleSubagentSteps(sessionId, callId) {
    const cur = get().subagentSteps[sessionId]?.[callId]
    const open = !cur?.open
    set((s) => putSubagentSteps(s.subagentSteps, sessionId, callId, { ...(cur ?? SUBAGENT_STEPS_UNREAD), open }))
    // Read on the first opening, and again after a failed read — never while it is closed
    if (open && (!cur || cur.error)) void get().loadMoreSubagentSteps(sessionId, callId)
  },

  async loadMoreSubagentSteps(sessionId, callId) {
    const platform = get().platform
    const cur = get().subagentSteps[sessionId]?.[callId]
    if (!platform || !cur || cur.loading) return
    const after = cur.rows.at(-1)?.seq ?? 0
    set((s) => putSubagentSteps(s.subagentSteps, sessionId, callId, { ...cur, loading: true, error: null }))
    try {
      const page = await platform.agents.loadSubagentMessages(sessionId, callId, after, SUBAGENT_STEPS_PAGE)
      set((s) => {
        const now = s.subagentSteps[sessionId]?.[callId] ?? cur
        // A live step may have joined while the page was on its way: one row per number, in order
        const rows = mergeBySeq(now.rows, page)
        return putSubagentSteps(s.subagentSteps, sessionId, callId, { ...now, rows, more: page.length >= SUBAGENT_STEPS_PAGE, loading: false })
      })
    } catch (e) {
      set((s) =>
        putSubagentSteps(s.subagentSteps, sessionId, callId, {
          ...(s.subagentSteps[sessionId]?.[callId] ?? cur),
          loading: false,
          error: (e as Error).message,
        }),
      )
    }
  },
})
