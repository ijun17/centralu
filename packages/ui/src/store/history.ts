import { errorMessage, SUBAGENT_STEPS_PAGE } from '@cc/protocol/client'
import type { AppState, StoreGet, StoreSet } from './state.js'
import { HISTORY_PAGE, SUBAGENT_STEPS_UNREAD, mergeBySeq, mergePage, prependPage, putSubagentSteps, readBack } from './historyPages.js'
import { retryLadder } from './retry.js'
import { inlineViewsFromHistory, mergeInlineHistory, syncInlineViews } from './apps.js'
import { omitKey } from './patch.js'
import { bumpChatKeysAbove, messagesToChat } from './transcript.js'
import { formatCount } from '../app/format.js'

// Reading a conversation's history from the host's store; the merge rules are in historyPages.ts.

type HistoryActions = Pick<
  AppState,
  | 'loadHistory'
  | 'loadHistoryAt'
  | 'loadOlder'
  | 'setFoldOpen'
  | 'toggleSubagentSteps'
  | 'loadMoreSubagentSteps'
  | 'trashSubagentSteps'
  | 'restoreSubagentSteps'
>

export const historyActions = (set: StoreSet, get: StoreGet): HistoryActions => ({
  async loadHistory(sessionId) {
    const platform = get().platform
    if (!platform) return
    // docs/state-management.md §5: a failed page is read again, and the cursor dropped meanwhile so opening reads it too
    let held: AppState['history'][string] | undefined
    const msgs = await retryLadder(
      () => {
        held = get().history[sessionId]
        return platform.agents.loadMessages(sessionId, HISTORY_PAGE)
      },
      () => get().platform === platform && !!get().sessions[sessionId],
      () =>
        // A cursor some other read set meanwhile is a successful read, and stays
        set((s) => {
          if (!held || s.history[sessionId] !== held) return {}
          const { [sessionId]: _dropped, ...history } = s.history
          return { history }
        }),
    )
    // Not shown: a new conversation is still possible
    if (!msgs) return
    try {
      const items = messagesToChat(msgs)
      bumpChatKeysAbove(items)
      set((s) => {
        // Merged, never discarded (#79, `mergePage`); the cursor is the merged top row's stored number (`readBack`)
        const have = s.chat[sessionId] ?? []
        const held = s.history[sessionId]
        const read = readBack(have, held, msgs)
        const merged = mergePage(have, items, msgs)
        return {
          chat: { ...s.chat, [sessionId]: read.length ? prependPage(merged, read) : merged },
          // Past cards' app views (M4 B-1)
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
      // A page that cannot become rows does not take the screen down
      return
    }
    await syncInlineViews(get, set, sessionId)
  },

  async loadHistoryAt(sessionId, seq) {
    const platform = get().platform
    if (!platform) return
    try {
      // `beforeSeq` is exclusive: the first page ends on the hit, the second adds context after it
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
     * A page is good only for the cursor it was asked from (#79): after a re-read or a trim moved it, prepending would
     * leave a gap for good. Such a page is dropped, and the next scroll asks from the new cursor.
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
        toast: `Could not load past conversation: ${errorMessage(e)}`,
      }))
    }
  },

  setFoldOpen(sessionId, keys, open) {
    set((s) => {
      const cur = s.foldOpen[sessionId] ?? {}
      if (open ? keys.every((k) => cur[k]) : !keys.some((k) => cur[k])) return {}
      const next = { ...cur }
      for (const k of keys) {
        if (open) next[k] = true
        else delete next[k]
      }
      return { foldOpen: { ...s.foldOpen, [sessionId]: next } }
    })
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
      // docs/state-management.md §4 (`messages.subagentTrashed`, #418); an older host does not answer, and the card goes without
      const [page, trashed] = await Promise.all([
        platform.agents.loadSubagentMessages(sessionId, callId, after, SUBAGENT_STEPS_PAGE),
        after === 0 ? platform.agents.subagentTrashed(sessionId, callId).then((r) => r.steps, () => cur.trashed) : cur.trashed,
      ])
      set((s) => {
        const now = s.subagentSteps[sessionId]?.[callId] ?? cur
        // A live step may have joined while the page was on its way: one row per number, in order
        const rows = mergeBySeq(now.rows, page)
        return putSubagentSteps(s.subagentSteps, sessionId, callId, {
          ...now,
          rows,
          more: page.length >= SUBAGENT_STEPS_PAGE,
          loading: false,
          ...(trashed === undefined ? {} : { trashed }),
        })
      })
    } catch (e) {
      set((s) =>
        putSubagentSteps(s.subagentSteps, sessionId, callId, {
          ...(s.subagentSteps[sessionId]?.[callId] ?? cur),
          loading: false,
          error: errorMessage(e),
        }),
      )
    }
  },

  async trashSubagentSteps(sessionId) {
    const platform = get().platform
    if (!platform) return 'Not connected'
    try {
      const { steps } = await platform.trash.trashSubagentSteps(sessionId)
      rereadSubagentSteps(sessionId, set, get)
      const name = get().sessions[sessionId]?.name ?? 'the session'
      // The person is on Settings → Archive, by the entry's Restore: the toast points nowhere (docs/ux-writing.md §1.1)
      set({
        toast: `Moved ${formatCount(steps)} subagent ${steps === 1 ? 'step' : 'steps'} of ${name} to the session archive`,
        // Archiving them is undone by the archive's own Restore, so it needs no question first (#1512)
        toastAction: {
          label: 'Undo',
          run: () => {
            void get()
              .restoreSubagentSteps(sessionId)
              .then((error) => {
                if (error) set({ toast: `Could not undo: ${error}` })
              })
          },
        },
      })
      return null
    } catch (e) {
      return errorMessage(e)
    }
  },

  async restoreSubagentSteps(sessionId) {
    const platform = get().platform
    if (!platform) return 'Not connected'
    try {
      await platform.trash.restoreSubagentSteps(sessionId)
      rereadSubagentSteps(sessionId, set, get)
      return null
    } catch (e) {
      return errorMessage(e)
    }
  },
})

// docs/state-management.md §4: archiving or restoring steps makes open cards read again and closed ones forget (#418)
function rereadSubagentSteps(sessionId: string, set: StoreSet, get: StoreGet): void {
  const cards = get().subagentSteps[sessionId]
  if (!cards) return
  const open = Object.entries(cards).filter(([, c]) => c.open)
  set((s) => ({
    subagentSteps: { ...s.subagentSteps, [sessionId]: Object.fromEntries(open.map(([callId]) => [callId, { ...SUBAGENT_STEPS_UNREAD, open: true }])) },
  }))
  for (const [callId] of open) void get().loadMoreSubagentSteps(sessionId, callId)
}
