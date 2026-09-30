import type { NormalizedEvent, StoredMessage } from '@cc/protocol'

/**
 * An agent an app has assigned (M4 D-1) — what gets sent to the session, and what gets read as
 * its answer once the session finishes.
 *
 * Standing the session up and waiting for it is the manager's job (`SessionManager.runAppAgent`).
 * The frame around the text it sends is the same one used for in-conversation UI messages
 * (`manager.ts`'s `appMessageFrame`). What lives here is only what comes after: waiting for the
 * turn's outcome, and the rule for picking the final answer out of the conversation record.
 */

/**
 * The final answer of a turn — the agent's text standing after the last tool call at the end of
 * the conversation record.
 *
 * Why it is "the text after the last tool call" and not simply "the last piece of text": an agent
 * writes text, calls a tool, and writes again. Text before a tool call is a plan, not an answer.
 * A reasoning summary (`reasoning`) is skipped since it is not an answer, and the scan stops the
 * moment it meets a tool call, a tool result, an approval, a marker or something a person said.
 * If there is no text at the end (the turn ended on a tool call), the answer is empty — an
 * earlier plan is never handed back pretending to be the answer.
 */
export function finalAnswer(messages: readonly StoredMessage[]): string {
  const parts: string[] = []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'assistant' && m.kind === 'reasoning') continue
    if (m.role === 'assistant' && m.kind === 'text') {
      parts.unshift(String((m.payload as { text?: unknown }).text ?? ''))
      continue
    }
    break
  }
  return parts.join('\n\n').trim()
}

/**
 * One session an app is waiting on for an answer (M4 D-1) — decides the outcome of its turn by
 * watching that session's events.
 *
 *   turn_complete       the answer landed (with structured output, if there is any). The end of a
 *                       turn the person stopped is not an answer, though — it is returned as stopped
 *   error               the turn failed (including a tool dying)
 *   limit_reached       a usage limit — this turn will not resolve no matter how long we wait
 *   approval, question  waiting on the person — the app is told in one line (that it is waiting
 *                       on the person, not that the app itself has stalled)
 *   usage_update        tokens spent (D-5) — passed through regardless of the outcome. Claude
 *                       carries the session's running total right before the turn's outcome (the
 *                       `result`'s modelUsage, summed across every model), while Codex carries the
 *                       thread's running total. Since each assignment is a fresh session, the last
 *                       value is exactly this assignment's share.
 *
 * Once the outcome is decided, later events are ignored (except for tokens).
 */
export class AgentRunWait {
  /** The person stopped that session's turn (`SessionManager.interrupt`) */
  stoppedByPerson = false
  /** The person deleted that session — there is no session left to conclude */
  deleted = false
  readonly done: Promise<{ output?: unknown }>
  private settle!: { resolve: (v: { output?: unknown }) => void; reject: (e: Error) => void }
  private settled = false

  constructor(
    private notify: (message: string) => void,
    private sessionName: () => string,
    private onUsage: (tokens: { input: number; output: number }) => void = () => {},
  ) {
    this.done = new Promise((resolve, reject) => (this.settle = { resolve, reject }))
    // So a failure before anyone is waiting does not leak as an unhandled rejection
    this.done.catch(() => {})
  }

  onEvent(e: NormalizedEvent): void {
    /*
     * The input recorded here is **all** of the input the model read — including what it read
     * from cache and what it wrote to cache (TokenUsage's three fields do not overlap). What is
     * recorded here is how much of the person's agent the app used, and an agent re-reads its
     * whole context on every call — without the cache, a run that read 25k looked like it read
     * only 1k. Codex ends up with the same sum (cached input is already counted inside its
     * reported input).
     */
    if (e.type === 'usage_update') {
      const t = e.tokens
      return this.onUsage({ input: t.inputTokens + t.cacheReadTokens + t.cacheCreationTokens, output: t.outputTokens })
    }
    if (this.settled) return
    switch (e.type) {
      case 'turn_complete':
        if (this.stoppedByPerson) return this.fail(new Error('the person stopped the agent before it finished'))
        this.settled = true
        return this.settle.resolve(e.output === undefined ? {} : { output: e.output })
      case 'error':
        return this.fail(new Error(this.stoppedByPerson ? 'the person stopped the agent before it finished' : `the agent's turn failed: ${e.error.message}`))
      case 'limit_reached':
        return this.fail(new Error(`the agent reached its usage limit${e.resumeAt ? ` (it resets at ${e.resumeAt})` : ''}`))
      case 'approval_request':
        return this.notify(`waiting for the person to approve a step in "${this.sessionName()}"`)
      case 'question_request':
        return this.notify(`waiting for the person to answer a question in "${this.sessionName()}"`)
    }
  }

  fail(err: Error): void {
    if (this.settled) return
    this.settled = true
    this.settle.reject(err)
  }
}
