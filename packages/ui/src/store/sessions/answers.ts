import { suggestMatcher } from '@cc/core'
import type { AppState, StoreGet, StoreSet } from '../state.js'

/** Answering what a session asks: an approval, exactly once (#158), and a question's options */

/** The key of an answer in flight (`approvalsInFlight`): the session and the request, since ids repeat across sessions */
export function inFlightKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`
}

/** The store's actions that answer a session's approval or question */
type AnswerActions = Pick<
  AppState,
  | 'respondApproval'
  | 'answerQuestion'
>

export const answerActions = (set: StoreSet, get: StoreGet): AnswerActions => ({
  async respondApproval(sessionId, requestId, decision, scope) {
    // The "always allow" pattern is computed by core (the host does not know core, so it is carried here)
    const pending = get().sessions[sessionId]?.pendingApproval
    /*
     * A request is answered exactly once (#158). If a response already sent is still in flight, or if
     * that outcome already dismissed the card, this is not sent again. A card keeps its listener alive
     * until `approval_resolved` lands and React re-renders, so a second `y` in that window became a
     * "vanished request" on the host and recorded a command that had already run as Denied. Both the
     * card's key and its buttons go through this same path.
     */
    const flight = inFlightKey(sessionId, requestId)
    if (get().approvalsInFlight[flight] || pending?.requestId !== requestId) return
    set((s) => ({ approvalsInFlight: { ...s.approvalsInFlight, [flight]: true } }))
    const matcher =
      decision === 'always' && pending
        ? pending.detail.kind === 'command'
          ? suggestMatcher(pending.detail.command)
          : pending.detail.kind === 'file_edit'
            ? pending.detail.path
            : undefined
        : undefined
    /*
     * This used to be the one action in this store that swallowed a failure. Approval is exactly the
     * spot where **pressing it and having nothing happen is worst of all** — there is no way to tell
     * whether the command ran or not.
     */
    try {
      await get().platform!.agents.respondApproval(sessionId, requestId, decision, scope, matcher)
      /*
       * What got remembered is stated using **the matcher actually sent** (#170). The card used to
       * compose its own wording separately, so even a kind with no matcher (`other`) was announced as
       * "Always allow in this session: other" — even though neither the adapter nor the store had kept
       * anything at all.
       */
      if (decision === 'always') {
        const access = pending?.detail.kind === 'project_access' ? pending.detail : null
        const agents = pending?.detail.kind === 'agent_start' ? pending.detail : null
        set({
          toast: access
            ? // A cross-project consent is remembered by the host for the pair, not by a matcher (#371)
              `Always allowed: ${access.from.name} → ${access.to.name}. Revoke it in Settings.`
            : agents
              ? // Starting agents (#561): this session while the app runs, or the whole project (stored, revocable)
                scope === 'project'
                ? `Sessions in ${agents.project.name} may start agents. Revoke it in Settings.`
                : 'This session may start agents until Centralu restarts.'
            : matcher
              ? `Always allow in ${scope === 'project' ? 'this project' : 'this session'}: ${matcher}`
              : 'Allowed once — this kind of request cannot be always-allowed yet',
        })
      }
      /*
       * Letting an edit or a command through means the tree is **about to** move (issue #41).
       *
       * Waiting for `turn_complete` alone would freeze the count for as long as the turn
       * runs — ten minutes of watching an agent edit twenty files while the sidebar insists
       * nothing has changed. A denial changes nothing, so it buys no refresh, and neither
       * does an `other` approval, which is by definition something we cannot read.
       *
       * The debounce is what makes this affordable: a run of approvals costs one status.
       */
      const changing =
        decision !== 'deny' && (pending?.detail.kind === 'file_edit' || pending?.detail.kind === 'command')
      const projectId = get().sessions[sessionId]?.projectId
      if (changing && projectId) get().refreshProjectGit(projectId)
    } catch (e) {
      set({ toast: (e as Error).message || 'Could not send the approval' })
    } finally {
      // A failure must allow pressing it again. A success already dismissed the card, so the `pendingApproval` check above blocks a repeat
      set((s) => {
        const { [flight]: _done, ...rest } = s.approvalsInFlight
        return { approvalsInFlight: rest }
      })
    }
  },

  /** Answers a set of options — the answer reaches the model as that tool's result */
  async answerQuestion(sessionId, requestId, answers) {
    try {
      await get().platform!.agents.answerQuestion(sessionId, requestId, answers)
      return true
    } catch (e) {
      set({ toast: (e as Error).message || 'Could not send the answer' })
      return false
    }
  },
})
