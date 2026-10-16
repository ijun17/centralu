import type { NormalizedEvent } from '@cc/protocol'

/**
 * Bookkeeping both adapters do the same way. Each helper here replaces copies that had drifted apart, so a rule
 * changed here changes for Claude and Codex at once.
 */

/** Counts notices across every handle in this host, so a notice from a new handle never reuses an open row's id */
let notices = 0

/**
 * A line Centralu itself says in a session's chat (a `/goal` confirmation or refusal), as an assistant message of
 * its own. It carries its own message id: the record and the screen join a chunk that names no message onto the
 * open row (session-record.ts, #212), so a notice without one was glued onto the model's open reply mid-turn.
 */
export function adapterNotice(sessionId: string, text: string): NormalizedEvent {
  return { type: 'message_delta', sessionId, role: 'assistant', messageId: `centralu-notice-${++notices}`, text }
}

/**
 * What a message the person sent and the CLI never read is called, by when it was left behind (`when`, read after
 * the count: "were still queued when the session closed"). The screen already shows such a message as sent (the
 * manager records it first), so dropping it silently leaves "sent, but the agent never read it" (the 2026-09-02 loss
 * incident): every place that lets one go says so with this text.
 */
export function undeliveredText(count: number, when: string): string {
  return `${count} message(s) ${when} and were not delivered — please resend`
}

/** `undeliveredText` as the error event a session shows (`internal`, not retryable: only a resend brings it back) */
export function undeliveredError(sessionId: string, count: number, when: string): NormalizedEvent {
  return { type: 'error', sessionId, error: { code: 'internal', message: undeliveredText(count, when), retryable: false } }
}

/**
 * The cards a session has open (approvals, questions), by request id. A card is **never released silently**: the
 * screen keeps a card until it hears `approval_resolved` / `question_resolved`, and an id the handle no longer holds
 * makes its buttons do nothing. So every way a card goes — answered, withdrawn by the CLI, the turn stopped, the
 * handle closed — goes through `take` or `release`, and the caller says it there.
 */
export class PendingCards<T> {
  private readonly cards = new Map<string, T>()

  get size(): number {
    return this.cards.size
  }

  set(requestId: string, card: T): void {
    this.cards.set(requestId, card)
  }

  /** Removes the card and hands it over, so it is answered at most once */
  take(requestId: string): T | undefined {
    const card = this.cards.get(requestId)
    this.cards.delete(requestId)
    return card
  }

  /** The ids of the open cards `match` picks (all without one), in the order they were raised */
  ids(match?: (card: T, requestId: string) => boolean): string[] {
    return [...this.cards].filter(([id, card]) => !match || match(card, id)).map(([id]) => id)
  }

  /**
   * Closes the open cards `match` picks (all without one). Each is removed before `close` runs, so an answer that
   * arrives from inside `close` finds nothing to answer twice.
   */
  release(close: (requestId: string, card: T) => void, match?: (card: T, requestId: string) => boolean): void {
    for (const id of this.ids(match)) {
      const card = this.take(id)
      if (card !== undefined) close(id, card)
    }
  }
}

/**
 * A Stop that did not reach the CLI. Said, never swallowed: letting the person believe it stopped and wait is the
 * worst outcome.
 */
export function couldNotStop(sessionId: string, err: Error): NormalizedEvent {
  return { type: 'error', sessionId, error: { code: 'internal', message: `Could not stop: ${err.message}`, retryable: true } }
}
