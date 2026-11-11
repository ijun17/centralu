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
}
