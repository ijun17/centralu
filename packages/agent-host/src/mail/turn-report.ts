/** How a turn of delegated work ended, as Centralu reports it on the task (docs/plans/mailbox.md §9.3, `MessageService.report`) */
export type TurnReport = {
  outcome: 'finished' | 'failed' | 'stopped' | 'paused' | 'waiting'
  body: string
  answer?: string
  error?: string
  reason?: string
  paused?: number
  waitingOn?: number
  /** On a last response (§10.6.3): the person wrote in the session after the task was given; the task arrived after the response was written */
  personSince?: boolean
  after?: boolean
  /**
   * The same sender's other open tasks to the same session that this report answers too (docs/plans/mailbox.md §10.6.3): one
   * turn end, one report per giver. Each is settled `reported` with it; an id that is no such task is left alone
   */
  covers?: readonly string[]
}
