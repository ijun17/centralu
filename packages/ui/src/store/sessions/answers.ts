import { errorMessage, alwaysAllowKey } from '@cc/protocol/client'
import type { AppState, StoreGet, StoreSet } from '../state.js'

/** Both ids: request ids repeat across sessions */
export function inFlightKey(sessionId: string, requestId: string): string {
  return `${sessionId}\u0000${requestId}`
}

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
     * Answered exactly once (#158): the card listens until `approval_resolved` re-renders it, and a second `y` meanwhile
     * would reach the host as a vanished request and record a command that ran as Denied.
     */
    const flight = inFlightKey(sessionId, requestId)
    if (get().approvalsInFlight[flight] || pending?.requestId !== requestId) return
    set((s) => ({ approvalsInFlight: { ...s.approvalsInFlight, [flight]: true } }))
    // The command trimmed or the edit's path, the same key the host matches (#428); none for an edit with no path
    const matcher = (decision === 'always' && pending && alwaysAllowKey(pending.detail)) || undefined
    // Shown, never swallowed: a press that does nothing leaves no way to tell whether the command ran
    try {
      await get().platform!.agents.respondApproval(sessionId, requestId, decision, scope, matcher)
      // Worded from the matcher actually sent (#170): a kind with none (`other`) must not be announced as remembered
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
      // An allowed edit or command moves the tree now (#41): `turn_complete` alone freezes the count for the whole turn.
      // A denial or an `other` buys no refresh; the debounce makes a run of approvals one status.
      const changing =
        decision !== 'deny' && (pending?.detail.kind === 'file_edit' || pending?.detail.kind === 'command')
      const projectId = get().sessions[sessionId]?.projectId
      if (changing && projectId) get().refreshProjectGit(projectId)
    } catch (e) {
      set({ toast: errorMessage(e) || 'Could not send the approval' })
    } finally {
      // A failure allows pressing again; a success dismissed the card, and the `pendingApproval` check blocks a repeat
      set((s) => {
        const { [flight]: _done, ...rest } = s.approvalsInFlight
        return { approvalsInFlight: rest }
      })
    }
  },

  /** The answer reaches the model as that tool's result */
  async answerQuestion(sessionId, requestId, answers) {
    try {
      await get().platform!.agents.answerQuestion(sessionId, requestId, answers)
      return true
    } catch (e) {
      set({ toast: errorMessage(e) || 'Could not send the answer' })
      return false
    }
  },
})
