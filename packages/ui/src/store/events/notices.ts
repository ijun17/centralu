import { errorMessage, type NormalizedEvent } from '@cc/protocol/client'
import { badgeCount, countWaiting, gridSessionIds, notificationFor, pendingProposals, proposalCandidates, type NotifyRequest, type SessionSummary } from '@cc/core'
import { notifyPolicyOf } from '@cc/protocol/client'
import { firstToRaise } from '../../app/notice-claim.js'
import { isOnScreen } from '../../app/onscreen.js'
import type { AppState, Notice, StoreGet, StoreSet } from '../state.js'
import { projectScreenSessions } from '../screens.js'
import { machineNameOf } from '../names.js'

// The dock badge: sessions' approvals and errors, and the Assistant's pending proposals, which wait like one (#703)
export function syncBadge(get: () => AppState): void {
  const st = get()
  if (!st.platform) return
  const waiting = [...Object.values(st.sessions), ...proposalCandidates(pendingProposals(st))]
  void st.platform.system.setBadge(badgeCount(countWaiting(waiting)))
}

// The one path every OS notification takes (#1630), once per machine however many windows hear `event` (#2168)
export function alertPerson(notice: NotifyRequest, event: string | undefined, set: StoreSet, get: StoreGet): void {
  void raisesHere(event).then((first) => {
    const st = get()
    if (!first || !st.platform) return
    // The banner is a nice-to-have (dead on macOS); its failure is shown, or a missing banner is undiagnosable
    void st.platform.system.notify(notice.title, notice.body).catch((e: unknown) => set({ toast: errorMessage(e) }))
    // What reaches the person: needs neither permission nor signing. Mail, a question too, alerts once, never as an approval
    const kind = notice.kind === 'mail' ? 'done' : notice.kind
    void st.platform.system.alert(kind, notifyPolicyOf(st.prefs).sound).catch((e: unknown) => set({ toast: `Could not alert: ${errorMessage(e)}` }))
  })
}

/**
 * `event` is a name every window gives the same event (a host id or event number), never a window's own count, which
 * two windows can hold apart (#2168). Without one every window raises: twice rather than none.
 */
function raisesHere(event: string | undefined): Promise<boolean> {
  return event === undefined ? Promise.resolve(true) : firstToRaise(event)
}

// One card per session, updated in place so a busy session does not move the card about to be pressed
function pushNotice(set: (fn: (s: AppState) => Partial<AppState>) => void, notice: Notice): void {
  set((s) => {
    const at = s.notices.findIndex((n) => n.sessionId === notice.sessionId)
    if (at === -1) return { notices: [...s.notices, notice] }
    const notices = [...s.notices]
    notices[at] = notice
    return { notices }
  })
}

// Runs before the event touches the conversation; `id` is the host's name for the event
export function noticeEvent(e: NormalizedEvent, sessionId: string, set: StoreSet, get: StoreGet, id?: string): void {
  // A request to start an agent is told every time, on screen too, until answered (#673; owner, 2026-10-18)
  if (e.type === 'approval_request' && e.detail.kind === 'agent_start') {
    pushNotice(set, { sessionId, kind: 'agent_start', name: get().sessions[sessionId]?.name ?? sessionId, at: Date.now() })
  }
  if (e.type === 'question_request') {
    pushNotice(set, { sessionId, kind: 'question', name: get().sessions[sessionId]?.name ?? sessionId, at: Date.now() })
  }
  // Answered (in another window, or withdrawn): the card in the top right has nothing left to open
  if (e.type === 'approval_resolved' && get().notices.some((n) => n.sessionId === sessionId && n.kind === 'agent_start')) {
    get().dismissNotices([sessionId])
  }

  /*
   * A finished turn sweeps the screen if seen, judged now: judged later, switching to the session would fire a sweep
   * for nothing. The instant lets two finishes in a row both fire. A compaction turn (#1451) tells nothing.
   */
  if (e.type === 'turn_complete' && !e.turn?.compaction) {
    const s = get()
    // `isOnScreen` is true with the app behind another window, so focus is checked too
    const seen =
      s.appFocused &&
      isOnScreen(s.view, sessionId, {
        focusedSessionId: s.focusedSessionId,
        assistantId: s.assistantId,
        gridSessions: gridSessionIds(s.gridPanels),
        builderPaneSessionId: s.builderPaneSessionId,
        projectScreen: projectScreenSessions(s),
      })
    if (seen) set({ completion: { sessionId, at: Date.now() } })
    // A notice either way (owner, 2026-10-18): whether it was seen is decided when its line folds (Notices.tsx)
    pushNotice(set, { sessionId, kind: 'done', name: s.sessions[sessionId]?.name ?? sessionId, at: Date.now() })
    if (!seen) {
      // Unseen, the card comes with the sound: a silent card is seen only once the person is back
      const policy = notifyPolicyOf(s.prefs)
      if (policy.done && (!s.appFocused || policy.whenFocused)) {
        // A turn has no id of its own, so the event that ends it names it (#2168)
        void raisesHere(id === undefined ? undefined : `done:${id}`).then((first) => {
          if (!first) return
          void get()
            .platform?.system.alert('done', policy.sound)
            .catch((err: unknown) => set({ toast: `Could not alert: ${errorMessage(err)}` }))
        })
      }
    }

    /*
     * A finished turn is the cheapest strong hint that the working tree moved (#41, no file watcher needed, #34).
     * An unregistered session's replay runs this again with a project to name.
     */
    const projectId = s.sessions[sessionId]?.projectId
    if (projectId) get().refreshProjectGit(projectId)
  }
}

function waitKind(e: NormalizedEvent, s: SessionSummary): Notice['kind'] {
  if (s.state === 'error') return 'error'
  if (e.type === 'approval_request' && e.detail.kind === 'agent_start') return 'agent_start'
  if (e.type === 'question_request') return 'question'
  return 'approval'
}

export function notifyStateChange(
  e: NormalizedEvent,
  sessionId: string,
  cur: SessionSummary,
  withSeq: SessionSummary,
  set: StoreSet,
  get: StoreGet,
): void {
  // core decides, the system port delivers
  if (withSeq.state !== cur.state) {
    const st = get()
    if (!st.platform) return

    const ctx = { appFocused: st.appFocused, policy: notifyPolicyOf(st.prefs) }

    // An OS banner has no machine tag to show, so the name carries it for a session on a linked machine (#82)
    const named = withSeq.machine ? `${withSeq.name} on ${machineNameOf(st.machines, withSeq.machine)}` : withSeq.name
    const notice = notificationFor({ id: sessionId, name: named, state: withSeq.state }, cur.state, ctx)
    // The card's own id names it: only a card the person answers makes one (`notificationFor`)
    const card = e.type === 'approval_request' || e.type === 'question_request' ? e.requestId : undefined
    if (notice) alertPerson(notice, card === undefined ? undefined : `${notice.kind}:${sessionId}:${card}`, set, get)
    // An approval or error waits for the person, so its card is pushed always; the policy decides only sound and
    // banner (owner, 2026-10-18)
    if (notice || withSeq.state === 'waiting_approval' || withSeq.state === 'error') {
      pushNotice(set, { sessionId, kind: waitKind(e, withSeq), name: withSeq.name, at: Date.now() })
    }
    syncBadge(get)
  }
}
