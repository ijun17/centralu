import type { NormalizedEvent } from '@cc/protocol'
import { allDoneNotification, badgeCount, countWaiting, gridSessionIds, notificationFor, pendingProposals, proposalCandidates, type SessionSummary } from '@cc/core'
import { isOnScreen } from '../../app/onscreen.js'
import type { AppState, Notice, StoreGet, StoreSet } from '../state.js'
import { projectScreenSessions } from '../screens.js'

/**
 * What tells the person something happened: the cards in the top right, the sweep for a turn that
 * finished on screen, the sound and the OS banner, and the dock badge.
 */

/**
 * Tells the system the number of things that need an answer (the dock badge): approvals and errors among the sessions,
 * and the orchestrator's pending proposals (#703), which wait like an approval. Called whenever either changes.
 */
export function syncBadge(get: () => AppState): void {
  const st = get()
  if (!st.platform) return
  const waiting = [...Object.values(st.sessions), ...proposalCandidates(pendingProposals(st))]
  void st.platform.system.setBadge(badgeCount(countWaiting(waiting)))
}

/**
 * Stacks a notification card — one per session.
 *
 * If the same session calls again, it is updated in place rather than added again, and **its
 * position keeps the order it was first added in.** Always sending it to the bottom would let a
 * busy session keep the cards constantly moving, so the card someone was about to press slips out
 * from under their finger.
 */
function pushNotice(set: (fn: (s: AppState) => Partial<AppState>) => void, notice: Notice): void {
  set((s) => {
    const at = s.notices.findIndex((n) => n.sessionId === notice.sessionId)
    if (at === -1) return { notices: [...s.notices, notice] }
    const notices = [...s.notices]
    notices[at] = notice
    return { notices }
  })
}

/**
 * The notices an event raises as it arrives, before it touches the conversation: a request to start an
 * agent, its answer, and a finished turn. Returns whether it already alerted the person.
 */
export function noticeEvent(e: NormalizedEvent, sessionId: string, set: StoreSet, get: StoreGet): boolean {
  /** Whether this event already alerted the person — a flag so the same instant does not fire twice */
  let announced = false

  /*
   * A session asks to start another agent (#673): a notice every time, on screen or not, until it is answered. It
   * used to stand unseen in a session the person was not looking at until it was withdrawn, and the session then
   * worked alone.
   */
  if (e.type === 'approval_request' && e.detail.kind === 'agent_start') {
    // Made on screen too (owner, 2026-10-18): a question the person must answer is always told
    pushNotice(set, { sessionId, kind: 'agent_start', name: get().sessions[sessionId]?.name ?? sessionId, at: Date.now() })
  }
  // The agent asks the person a question (a question card): told every time, and it stands until answered
  if (e.type === 'question_request') {
    pushNotice(set, { sessionId, kind: 'question', name: get().sessions[sessionId]?.name ?? sessionId, at: Date.now() })
  }
  // Answered (in another window, or withdrawn): the card in the top right has nothing left to open
  if (e.type === 'approval_resolved' && get().notices.some((n) => n.sessionId === sessionId && n.kind === 'agent_start')) {
    get().dismissNotices([sessionId])
  }

  /*
   * The response finished — the trigger for one sweep of the screen.
   *
   * **Visibility is decided right now.** This used to keep only the fact, and let the screen
   * multiply in "is it visible" later, which lets the two moments fall out of sync: switching to
   * the session at the very instant it becomes visible would also make that later check true, so
   * **the sweep fired even though nothing had just finished** (dogfooding: "it also fires just from
   * switching session windows"). Worse, since this value was never cleared, it repeated every time
   * on switching back and forth.
   *
   * Deciding it once, at the instant the event happens, leaves no room to fall out of sync.
   * The instant is kept alongside it so the same session finishing twice in a row still fires each
   * time.
   *
   * Something that finished off screen is left as a **card**, not a sweep — since it was not being
   * watched, a passing signal would be missed. The two are two faces of the same event, and mutually
   * exclusive.
   */
  if (e.type === 'turn_complete') {
    const s = get()
    /*
     * **Seen = the app is in front, and that session is on screen.**
     *
     * The first half used to be missing. `isOnScreen` only checks which session is showing in the
     * UI, so it was true even with the app behind another window — but stepping away makes the
     * whole app invisible. So the sweep fired in an empty room, and the very card built for the
     * case of stepping away was never created. Exactly nothing happened in the one case a
     * notification mattered most.
     */
    const seen =
      s.appFocused &&
      isOnScreen(s.view, sessionId, {
        focusedSessionId: s.focusedSessionId,
        orchestratorId: s.orchestratorId,
        gridSessions: gridSessionIds(s.gridPanels),
        builderPaneSessionId: s.builderPaneSessionId,
        projectScreen: projectScreenSessions(s),
      })
    if (seen) set({ completion: { sessionId, at: Date.now() } })
    /*
     * A notice either way (owner, 2026-10-18): the capsule writes it out for a few seconds, and whether the person saw
     * it is decided when that line folds (Notices.tsx), not at this instant.
     */
    pushNotice(set, { sessionId, kind: 'done', name: s.sessions[sessionId]?.name ?? sessionId, at: Date.now() })
    if (!seen) {
      /*
       * The card and the sound go together. A card that piles up silently reads as "the card is
       * there, why did it not alert me," and to someone who stepped away, a card is only seen once
       * they come back — so a card alone is half the job. The sound follows the same policy as
       * every other notification — quietly leave only the card while the app is in view.
       */
      if (s.notifyPolicy.done && (!s.appFocused || s.notifyPolicy.whenFocused)) {
        announced = true
        void s.platform?.system
          .alert('done', s.notifyPolicy.sound)
          .catch((err: Error) => set({ toast: `Could not alert: ${err.message}` }))
      }
    }

    /*
     * A finished turn is the cheapest strong hint that the working tree moved (issue #41):
     * an agent just stopped editing in that folder, which is the very thing that made the
     * sidebar's changed count wrong. No filesystem watcher needed for the common case —
     * that is a bigger design (#34) and this must not wait for it.
     *
     * The session may not be registered yet (its events arrive buffered and are replayed
     * after `attach` lists it); the replay runs this branch again with a project to name.
     */
    const projectId = s.sessions[sessionId]?.projectId
    if (projectId) get().refreshProjectGit(projectId)
  }
  return announced
}

/**
 * What a session that now waits or failed is told as: a request to start an agent (#673) and a question the agent asked
 * keep their own words, pushed by `noticeEvent` for the same event, rather than read as a plain approval.
 */
function waitKind(e: NormalizedEvent, s: SessionSummary): Notice['kind'] {
  if (s.state === 'error') return 'error'
  if (e.type === 'approval_request' && e.detail.kind === 'agent_start') return 'agent_start'
  if (e.type === 'question_request') return 'question'
  return 'approval'
}

/** The notices for a session whose state the event changed (`cur` before it, `withSeq` after) */
export function notifyStateChange(
  e: NormalizedEvent,
  sessionId: string,
  cur: SessionSummary,
  withSeq: SessionSummary,
  announced: boolean,
  set: StoreSet,
  get: StoreGet,
): void {
  // Notifications are decided only when the state changed (the decision belongs to core, delivery to the system port)
  if (withSeq.state !== cur.state) {
    const st = get()
    const platform = st.platform
    if (!platform) return

    const ctx = { appFocused: st.appFocused, policy: st.notifyPolicy }
    const after = Object.values(st.sessions)
    const before = after.map((x) => (x.id === sessionId ? cur : x))

    // An OS banner has no machine tag to show, so the name carries it for a session on a linked machine (#82)
    const named = withSeq.machine ? `${withSeq.name} on ${st.machines[withSeq.machine]?.name ?? withSeq.machine}` : withSeq.name
    const one = notificationFor({ id: sessionId, name: named, state: withSeq.state }, cur.state, ctx)
    const all = allDoneNotification(after, before, ctx)
    // If there is a per-session notice, use only that — do not fire twice at the same instant
    // If a per-session completion already fired, "all done" does not fire on top of it — twice at the same instant is just noise
    const notice = one ?? (announced ? null : all)
    if (notice) {
      // The banner has been downgraded to a nice-to-have (this path is dead on macOS).
      // If it could not be sent, it is left on screen — disappearing silently would make "notifications do not arrive" undiagnosable.
      void platform.system.notify(notice.title, notice.body).catch((e: Error) => set({ toast: e.message }))
      // The path that actually reaches the person. Goes through neither permissions nor signing.
      void platform.system
        .alert(notice.kind, st.notifyPolicy.sound)
        .catch((e: Error) => set({ toast: `Could not alert: ${e.message}` }))
    }
    // An approval or error is only resolved once the person shows up → also left as a card so it survives until they come back.
    // "All done" is not about a single session, so it never creates a card (a per-session card already exists for that).
    if (one || withSeq.state === 'waiting_approval' || withSeq.state === 'error') {
      /*
       * The notification policy decides the sound and the banner, not whether the top bar says it (owner, 2026-10-18).
       * With the cards gone, a notice is one line the inbox's capsule writes out for a few seconds and nothing that
       * covers the page, so an approval or an error is told there always, the session on screen included.
       */
      pushNotice(set, { sessionId, kind: waitKind(e, withSeq), name: withSeq.name, at: Date.now() })
    }
    syncBadge(get)
  }
}
