import { gridSessionIds, isInTurn, type SessionSummary } from '@cc/core'
import { handoffOpening, handoffPrompt } from '@cc/protocol'
import type { AppState, StoreGet, StoreSet } from '../state.js'
import { EMPTY_DRAFT } from '../state.js'

/**
 * Handing a session off to a fresh one (#78, #102, #142): the note asked of the agent or built from
 * the record, the successor's first message, and the grid slot it takes over.
 */

/** The prompt asking the agent for its note, now in the protocol (#694: the orchestrator's handoff_session asks with it too) */
export { handoffPrompt }

/** A handoff in progress — calling it twice on the same session births two new sessions (module state: purely a re-entry guard, nothing to draw from it) */
const handoffInFlight = new Set<string>()

/**
 * The card that blocks asking the agent for a handoff note (#174) — `null` if there is none. The
 * store's `handoffSession` and the sidebar's confirmation window use the same decision.
 */
export function handoffBlockedBy(s: Pick<SessionSummary, 'pendingQuestions' | 'pendingApproval'>): 'question' | 'approval' | null {
  if (s.pendingQuestions.length > 0) return 'question'
  if (s.pendingApproval) return 'approval'
  return null
}

/** The store's action that hands a session off */
type HandoffActions = Pick<
  AppState,
  | 'handoffSession'
>

export const handoffActions = (set: StoreSet, get: StoreGet): HandoffActions => ({
  async handoffSession(sessionId, opts) {
    const s = get()
    const session = s.sessions[sessionId]
    const project = session?.projectId ? s.projects[session.projectId] : null
    if (!s.platform || !session || !project || handoffInFlight.has(sessionId)) return
    const heirTool = opts?.tool ?? session.tool
    /*
     * The note comes from the record unless the caller asks the agent (owner decision on #694): the session being
     * replaced is the one least likely to summarize correctly (repeated compaction, stale state, injected text), and
     * the record mode asks it nothing. It used to be the default only for a session that could not respond (#78).
     */
    const mode = opts?.mode ?? 'record'
    // Only a fallback for a caller that leaves it out: the dialog always passes its box, which starts on (archive the original, #1477)
    const deleteOld = opts?.deleteOld ?? mode === 'agent'
    // A worktree session cannot hand off yet. A session with worktree children can since #561: they outlive it (they
    // used to pin a worktree manager, whose delete refused while one was unmerged)
    if (session.worktree) {
      set({ toast: 'Worktree sessions cannot hand off yet — merge or delete them first' })
      return
    }
    /*
     * The path that asks the agent for a note **never starts while a card is up** (#174). The request
     * travels as an ordinary message, so if exactly one question is open, that message becomes the
     * question's answer (`send`), and the agent would receive the handoff request text as the answer
     * to "Which DB?" — an answer that has already reached the agent cannot be taken back. With several
     * questions open, or an approval pending, it becomes a new turn instead and the card is dropped.
     * Record mode never asks the agent, so it proceeds regardless. The sidebar's confirmation window
     * checks the same condition (`handoffBlockedBy`).
     */
    const blocked = mode === 'agent' ? handoffBlockedBy(session) : null
    if (blocked) {
      set({ toast: `Answer the open ${blocked} first, or hand off from the record` })
      return
    }
    handoffInFlight.add(sessionId)
    try {
      /*
       * The note's location is decided and written by the host (#142) — under the data folder, at
       * `handoff/<project id>/<departing session id>.md`. This used to clear that spot inside the
       * project first (#104: a file left by a past failure was then delivered as if it were the
       * freshly written note). Now the file is only returned as a path **after** the host has
       * overwritten it with this handoff's text, so there is no way to read a leftover file.
       */
      let note = ''
      let notePath = ''
      if (mode === 'record') {
        /*
         * Record mode (#78): asks the agent **nothing at all** — the reason this mode exists is
         * precisely that the agent cannot respond. The host builds the record from the store's own
         * transcript (plus, for a codex rollout, its compaction summaries).
         *
         * The host writes this to **the same file** as agent mode (#102) — only the producer differs,
         * and the first message the successor receives is identical between the two modes. The `text`
         * returned here is only for the preview.
         */
        const record = await s.platform.agents.exportHandoffRecord(sessionId, heirTool)
        note = record.text
        notePath = record.path
      } else {
      /*
       * If a turn is running, the request **waits for it to finish** first (measured in the Mea session: a
       * handoff where the prompt merged into (steered) the turn already in progress, so the report of the
       * work just done ended up glued to the top of the handoff note. Nothing was actually lost, but it read
       * as "a note with its beginning cut off"). Sending only after the turn boundary makes sure the reply
       * that follows is the handoff, whole.
       */
      const quietBy = Date.now() + 10 * 60_000
      while (get().sessions[sessionId]?.state === 'working') {
        if (Date.now() > quietBy) throw new Error('the session never finished its current turn')
        await new Promise((r) => setTimeout(r, 500))
      }
      if (!get().sessions[sessionId]) throw new Error('the session disappeared')

      const prompt = handoffPrompt()
      /*
       * The last recorded point right before sending the request — the host reads the first human
       * message after this point as the request, and the reply after that as the note. Even if a
       * past handoff failed and the same request and its reply are still sitting in the conversation,
       * they are before this point. The point is asked of the host's own record: the screen's
       * `lastSeq` does not count a sent message until its confirmation (`user_message`) arrives, so it
       * can lag, and the first human message after a lagging point would not be this request.
       */
      const before = (await s.platform.agents.loadMessages(sessionId, 1)).at(-1)?.seq ?? 0
      await get().send(sessionId, prompt)
      // A send failure flows through the composer-restore path and leaves the prompt in the draft — since this was never written by the person, it is cleared
      if (!(get().chat[sessionId] ?? []).some((i) => i.kind === 'user' && i.text === prompt)) {
        if (get().drafts[sessionId]?.text.includes(prompt)) get().setDraft(sessionId, EMPTY_DRAFT)
        throw new Error('could not reach the session')
      }

      /*
       * **Waits for the turn to finish, then receives the note from the host** (#142) — never
       * scraped from the on-screen conversation (measured: leftover output from a turn still in
       * progress mixed into the top of the text and read as "cut off"). The host reads the last reply
       * after the request message from its own record and places it as a file. If the turn is still
       * running or there is no reply yet, it returns `null` and this asks again. Nothing is cleared if
       * no reply ever arrives.
       *
       * The received text is never sent whole to the successor (#102) — a preview is extracted, and
       * the full text is embedded in the record instead, because this text cannot be recreated once
       * the predecessor is gone.
       */
      const deadline = Date.now() + 10 * 60_000
      for (;;) {
        await new Promise((r) => setTimeout(r, 500))
        const st = get()
        const cur = st.sessions[sessionId]
        if (!cur) throw new Error('the session disappeared while writing the note')
        if (cur.state === 'error') throw new Error('the session hit an error while writing the note')
        if (Date.now() > deadline) throw new Error('timed out waiting for the handoff note')
        if (st.connection !== 'connected') continue // No decision is made while disconnected
        if (isInTurn(cur.state)) continue
        /*
         * null is "no reply yet": asked again. A throw is not (#841 item 5): the host could not place the note (a
         * full disk, a folder it cannot write), and reading it as "not yet" polled to the ten-minute timeout and blamed
         * that. A throw because the connection dropped is asked again once it is back.
         */
        let got: Awaited<ReturnType<typeof s.platform.agents.exportHandoffNote>>
        try {
          got = await s.platform.agents.exportHandoffNote(sessionId, before)
        } catch (e) {
          if (get().connection !== 'connected') continue
          throw new Error(`could not save the handoff note: ${(e as Error).message}`)
        }
        if (got) {
          note = got.text
          notePath = got.path
          break
        }
      }
      }

      /*
       * The new session inherits **every one** of the dying session's settings (the rule #37 taught:
       * carrying over only one leaves the rest born fresh with defaults). Except **when the tool
       * changes, nothing is carried over** — model, effort, verbosity and speed are all tool-specific
       * values, and passing them across tools either kills session creation outright or leaves a
       * setting silently wrong. The name is always inherited, regardless.
       */
      const sameTool = heirTool === session.tool
      const info = await get().createSession(session.projectId!, {
        tool: heirTool,
        model: sameTool ? (session.model ?? undefined) : undefined,
        effort: sameTool ? (session.effort ?? undefined) : undefined,
        verbosity: sameTool ? (session.verbosity ?? undefined) : undefined,
        serviceTier: sameTool ? (session.serviceTier ?? undefined) : undefined,
        permissionPreset: session.permissionPreset,
        initialPrompt: handoffOpening(session.name, note, notePath),
        // The note's full text goes into the record (#102), along with the id (#106) — that id is
        // what tells the host's cleanup this note still has an owner; without it, deleting the
        // predecessor is the same as deleting the note. Saying the predecessor goes next gives this session all of
        // its children, settled ones too, and the note lists them (#738)
        handoff: { from: session.name, note, fromSessionId: sessionId, ...(deleteOld ? { removesOriginal: true } : {}) },
      })
      await get().rename(info.id, session.name)

      /*
       * Grid slot succession (a dogfooding request, 2026-09-04): if the dying session was on the grid,
       * the successor takes its place at **the same index**. Emptying the slot with the delete and
       * then reinserting it would make the panel flicker away and reappear, shifting the order along
       * the way — so the swap happens before destruction. It swaps even with `deleteOld: false`: the
       * grid is a place for "sessions working right now," and the one that continues that work is the
       * successor — the surviving original is still reachable from the sidebar. `createSession` has
       * already focused the successor, so this only fixes up the lane (making it visible inside the
       * grid if it was on the grid).
       */
      const grid = get().gridPanels
      if (gridSessionIds(grid).includes(sessionId)) {
        await get().setGridPanels(
          grid.map((p) => (p.kind === 'session' && p.sessionId === sessionId ? { kind: 'session', sessionId: info.id } : p)),
        )
        get().focusSession(info.id, { preferGrid: true })
      }

      /*
       * **Nothing is cleaned up here** (#106).
       *
       * Cleanup has moved twice. The first time it was right here, right after `createSession` — the
       * successor had not even opened the file yet. #102 moved it to **the instant the successor's
       * first turn ends**, but that condition asks neither whether the turn succeeded nor whether the
       * note was ever read: in an actual incident, the first turn died with a 400 in under a second,
       * and the directory was empty within three minutes. What the successor received was a path to a
       * file that no longer existed, and that text can never be recreated — the predecessor who wrote
       * it had just been replaced.
       *
       * "Was it read" is not a fact we can observe. So the whole approach of hanging cleanup off a
       * turn is abandoned, and the two moments that cannot race the reader (session deletion, and
       * startup) are handed to the host instead (`manager.sweepOrphanHandoffNotes`). The cost of
       * leaving one extra file behind is close to zero — the note lives in the data folder, not the
       * user's repository (#142).
       */

      if (deleteOld) {
        // Destruction comes last — if this fails, both sessions are left standing (better than half deleted)
        await s.platform.agents.deleteSession(sessionId, false, true)
      }
      set({ toast: `Handed off: ${session.name}` })
    } catch (e) {
      // The next card after a live failure is record mode — the app tells the person instead of switching silently on its own (#78)
      const hint = mode === 'agent' ? ' — if the agent cannot respond, retry with "From the record"' : ''
      set({ toast: `Handoff failed: ${(e as Error).message}${hint}` })
    } finally {
      handoffInFlight.delete(sessionId)
    }
  },
})
