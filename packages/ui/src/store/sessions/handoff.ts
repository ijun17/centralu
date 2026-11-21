import { gridSessionIds, isAway, isInTurn, type SessionSummary } from '@cc/core'
import { errorMessage, busyWith, handoffOpening, handoffPrompt } from '@cc/protocol/client'
import type { AppState, StoreGet, StoreSet } from '../state.js'
import { EMPTY_DRAFT } from '../state.js'

// Handing a session off to a fresh one (#78, #102, #142).

/** The Assistant's handoff_session asks with it too (#694) */
export { handoffPrompt }

/** A re-entry guard: a second call on the same session would birth two sessions */
const handoffInFlight = new Set<string>()

/**
 * The card that blocks asking the agent for a note (#174): the busy rule's (`busyWith`, #2158), shared with the
 * sidebar's confirmation. A turn does not block: the request waits for its end.
 */
export function handoffBlockedBy(s: Pick<SessionSummary, 'state' | 'pendingQuestions' | 'pendingApproval'>): 'question' | 'approval' | null {
  const busy = busyWith(s)
  return busy === 'question' || busy === 'approval' ? busy : null
}

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
    const { tool: heirTool, mode, deleteOld } = opts
    // A worktree session cannot hand off yet. A session with worktree children can (#561): they outlive it
    if (session.worktree) {
      set({ toast: 'Worktree sessions cannot hand off yet — merge or delete them first' })
      return
    }
    // Never while a card is up (#174): the request travels as a message, which would answer an open question (and
    // cannot be taken back) or drop the card. Record mode never asks the agent.
    const blocked = mode === 'agent' ? handoffBlockedBy(session) : null
    if (blocked) {
      set({ toast: `Answer the open ${blocked} first, or hand off from the record` })
      return
    }
    handoffInFlight.add(sessionId)
    try {
      // The host places the note (#142) and returns its path only after writing this handoff's text, so a file a past
      // failure left is never delivered (#104)
      let note = ''
      let notePath = ''
      if (mode === 'record') {
        // Record mode (#78) asks the agent nothing: it exists for when the agent cannot answer. The host writes the
        // record to the same file as agent mode (#102); `text` is only for the preview.
        const record = await s.platform.agents.exportHandoffRecord(sessionId, heirTool)
        note = record.text
        notePath = record.path
      } else {
      // Sent after the turn ends: a prompt mid-turn steers it, and the note would start with the turn's report
      const quietBy = Date.now() + 10 * 60_000
      // A machine that is away shows its turn as not working (#1822): what it does there is not known, so it is waited for
      while (isInTurn(get().sessions[sessionId]?.state) || isAway(get().sessions[sessionId], get().machines)) {
        if (Date.now() > quietBy) throw new Error('the session never finished its current turn')
        await new Promise((r) => setTimeout(r, 500))
      }
      if (!get().sessions[sessionId]) throw new Error('the session disappeared')

      const prompt = handoffPrompt()
      // The host reads the first human message after this point as the request. From its record, not the screen's
      // `lastSeq`, which lags until `user_message` confirms a send.
      const before = (await s.platform.agents.loadMessages(sessionId, 1)).at(-1)?.seq ?? 0
      await get().send(sessionId, prompt)
      // A failed send restores the prompt into the draft; the person never wrote it, so it is cleared
      if (!(get().chat[sessionId] ?? []).some((i) => i.kind === 'user' && i.text === prompt)) {
        if (get().drafts[sessionId]?.text.includes(prompt)) get().setDraft(sessionId, EMPTY_DRAFT)
        throw new Error('could not reach the session')
      }

      /*
       * The note comes from the host's record (#142), never the screen, where a running turn's output would mix in. The
       * successor gets a preview; the full text goes in its record (#102), as it cannot be made again.
       */
      const deadline = Date.now() + 10 * 60_000
      for (;;) {
        await new Promise((r) => setTimeout(r, 500))
        const st = get()
        const cur = st.sessions[sessionId]
        if (!cur) throw new Error('the session disappeared while writing the note')
        if (cur.state === 'error') throw new Error('the session hit an error while writing the note')
        if (Date.now() > deadline) throw new Error('timed out waiting for the handoff note')
        if (st.connection !== 'connected' || isAway(cur, st.machines)) continue // No decision is made while disconnected, here or there (#1822)
        if (isInTurn(cur.state)) continue
        // null is "no reply yet". A throw is not (#841): the host could not place the note (a full disk), and polling
        // would blame the timeout. A dropped connection is asked again once back.
        let got: Awaited<ReturnType<typeof s.platform.agents.exportHandoffNote>>
        try {
          got = await s.platform.agents.exportHandoffNote(sessionId, before)
        } catch (e) {
          if (get().connection !== 'connected') continue
          throw new Error(`could not save the handoff note: ${errorMessage(e)}`)
        }
        if (got) {
          note = got.text
          notePath = got.path
          break
        }
      }
      }

      // Every setting carries over (#37), except tool-specific ones when the tool changes: they would fail creation or
      // be silently wrong
      const sameTool = heirTool === session.tool
      const info = await get().createSession(session.projectId!, {
        tool: heirTool,
        model: sameTool ? (session.model ?? undefined) : undefined,
        effort: sameTool ? (session.effort ?? undefined) : undefined,
        verbosity: sameTool ? (session.verbosity ?? undefined) : undefined,
        serviceTier: sameTool ? (session.serviceTier ?? undefined) : undefined,
        permissionPreset: session.permissionPreset,
        initialPrompt: handoffOpening(session.name, note, notePath),
        // The id tells the host's cleanup the note still has an owner (#106). A predecessor that goes next gives this
        // session all its children, which the note lists (#738)
        handoff: { from: session.name, note, fromSessionId: sessionId, ...(deleteOld ? { removesOriginal: true } : {}) },
      })
      await get().rename(info.id, session.name)

      // The successor takes the same grid index before the delete, so the panel does not flicker; even when the old one
      // stays, as the grid holds the work running now
      const grid = get().gridPanels
      if (gridSessionIds(grid).includes(sessionId)) {
        await get().setGridPanels(
          grid.map((p) => (p.kind === 'session' && p.sessionId === sessionId ? { kind: 'session', sessionId: info.id } : p)),
        )
        get().focusSession(info.id, { preferGrid: true })
      }

      /*
       * Nothing is cleaned up here (#106): whether the note was read cannot be observed, and a first turn that dies at
       * once would leave a path to a file gone for good. The host cleans up only at deletion and startup
       * (`sweepOrphanHandoffNotes`).
       */

      if (deleteOld) {
        // Destruction comes last — if this fails, both sessions are left standing (better than half deleted)
        await s.platform.agents.deleteSession(sessionId, false, true)
      }
      set({ toast: `Handed off: ${session.name}` })
    } catch (e) {
      // The app suggests record mode rather than switching on its own (#78)
      const hint = mode === 'agent' ? ' — if the agent cannot respond, retry with "From the record"' : ''
      set({ toast: `Handoff failed: ${errorMessage(e)}${hint}` })
    } finally {
      handoffInFlight.delete(sessionId)
    }
  },
})
