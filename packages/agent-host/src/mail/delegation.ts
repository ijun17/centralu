import type { ThreadOrigin } from '../dev-services/store/mail.js'
import type { MailService } from './service.js'

/**
 * What the mailbox does when a session gives another one work through a tool whose delivery the host already makes
 * (`ChildOwnership.delegated`, docs/plans/mailbox.md §8.1): it writes the task down as a thread the caller owns, beside the old
 * path, which stays the way the task reaches the child. Both are sessions of this host: a child on a linked machine keeps the
 * old path until slice 4 and never reaches here.
 */
export function delegationRecorder(
  mail: MailService,
  sessionOf: (id: string) => { projectId?: string | null } | undefined,
): (callerId: string, childId: string, origin: ThreadOrigin, task: string) => void {
  return (callerId, childId, origin, task) => {
    mail.recordDelegation(mail.sessionAddress(callerId), { assignee: mail.sessionAddress(childId), task, origin, projectId: sessionOf(childId)?.projectId || null })
  }
}
