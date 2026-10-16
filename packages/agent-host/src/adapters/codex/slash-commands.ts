import type { EventSink } from '../contract.js'
import { adapterNotice } from '../session-kit.js'

/** What the slash commands use of the session they belong to */
export type SlashCommandsHost = {
  readonly sessionId: string
  emit: EventSink
  /** A request on the session's connection */
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  threadId(): string | null
  /** An unsteerable turn (compact/review) we started is running, or no longer is (see the session's `pendingInputs`) */
  setBlockingTurn(on: boolean): void
  /** Sends what was queued behind such a turn */
  flushPending(): void
}

/**
 * The slash commands Codex runs as functions rather than messages (#58): `/compact`, `/review` and `/goal` go to their
 * own requests, since sent through turn/start the model would read the literal characters.
 */
export class CodexSlashCommands {
  constructor(private readonly host: SlashCommandsHost) {}

  /** The request a slash command started, or null when the text is a message */
  run(text: string): Promise<unknown> | null {
    /*
     * **compact is a function, not a message** (a dogfooding observation nailed it exactly —
     * "it does not work by sending a message"). In the codex CLI, /compact runs compaction
     * without going into the conversation, but the app-server path has no such slash-command
     * handler — sending it through turn/start makes the model **read the literal characters**
     * "/compact". There is a dedicated RPC instead: thread/compact/start
     * (generated/ClientRequest.ts). Measured: it answers {} immediately and proceeds
     * turn/started -> contextCompaction item started -> completed -> turn/completed, which our
     * existing normalize plumbing (the compacting indicator, the completion marker) already
     * receives as-is. (No `thread/compacted` on 0.147.0, 0.153.4 or 0.160.0 — #303.)
     */
    if (text.trim() === '/compact') {
      this.host.setBlockingTurn(true)
      return this.host
        .request('thread/compact/start', { threadId: this.host.threadId() })
        .catch((e: unknown) => {
          // Waiting on a turn that failed to start would lock the queue forever — unblock and flush what piled up
          this.host.setBlockingTurn(false)
          this.host.flushPending()
          throw e
        })
    }
    /*
     * /review is the same kind of thing (the review/start RPC). Measured: with no argument it
     * is the same "review what has changed right now" default as the codex CLI; with an
     * argument it follows that instruction instead (custom). The result usually arrives like a
     * turn — the review body streams as agentMessage (existing plumbing), and its start and end
     * arrive as enteredReviewMode/exitedReviewMode items (normalize turns these into activity).
     * Since upstream also classifies review turns as unsteerable ("cannot steer a review turn"),
     * we guard it with the same queue as compact.
     */
    if (text.trim() === '/review' || text.trim().startsWith('/review ')) {
      const instructions = text.trim().slice('/review'.length).trim()
      this.host.setBlockingTurn(true)
      return this.host
        .request('review/start', {
          threadId: this.host.threadId(),
          target: instructions ? { type: 'custom', instructions } : { type: 'uncommittedChanges' },
        })
        .catch((e: unknown) => {
          this.host.setBlockingTurn(false)
          this.host.flushPending()
          throw e
        })
    }
    /*
     * /goal is also a function (2026-09-07 — the same #58 family as /compact and /review).
     * Sending it through turn/start makes the model read the literal characters "/goal". There
     * are three dedicated RPCs: thread/goal/set, get and clear. The state change comes back as
     * a thread/goal/updated|cleared notification, which is what draws the badge — here we only
     * leave a one-line confirmation in the chat (if a local command's answer is invisible,
     * there is no way to know it ran — a lesson from claude's local_command_output). This is
     * not a turn, so blockingTurn is not set.
     */
    if (text.trim() === '/goal' || text.trim().startsWith('/goal ')) {
      const arg = text.trim().slice('/goal'.length).trim()
      // Its own message, not a continuation of the model's open reply (`adapterNotice`)
      const say = (line: string) => this.host.emit(adapterNotice(this.host.sessionId, line))
      if (!arg) {
        return this.host
          .request<{ goal: { objective?: string; status?: string } | null }>('thread/goal/get', {
            threadId: this.host.threadId(),
          })
          .then((r) =>
            say(
              r.goal ? `Goal (${r.goal.status ?? 'active'}): ${r.goal.objective ?? ''}` : 'No goal set.',
            ),
          )
      }
      if (arg === 'clear') {
        return this.host
          .request('thread/goal/clear', { threadId: this.host.threadId() })
          .then(() => say('Goal cleared.'))
      }
      /*
       * **State the status the response actually gave, verbatim** (dogfooding 2026-09-08:
       * "it looks registered but does not do anything").
       *
       * Measured: if the thread already has a finished goal, setting a new objective made
       * codex leave status as complete while only swapping in the new objective. If we had
       * just answered "Goal set" at that point, the screen would say it worked while the goal
       * loop never actually ran — and no badge would appear either, since our own rule is that
       * a completed goal does not raise a badge.
       */
      const setGoal = () =>
        this.host.request<{ goal?: { status?: string } }>('thread/goal/set', {
          threadId: this.host.threadId() as string,
          objective: arg,
        })
      const statusOf = (r: { goal?: { status?: string } }) =>
        typeof r?.goal?.status === 'string' ? r.goal.status : 'active'
      return setGoal().then(async (first) => {
        /*
         * **Setting a new goal on top of a finished one leaves it finished** (measured 2026-09-08).
         *
         * That thread had a goal the model had marked complete on its own two days earlier, and
         * setting a new objective made codex swap in only the objective while leaving status at
         * complete. A completed goal drives nothing, so to a person it looks like "it is
         * registered but does not do anything".
         *
         * The person writing a new goal **means to start over**. So we clear it once and set it
         * again — and if it is still not active after that, we state that status rather than
         * making one up.
         */
        let status = statusOf(first)
        if (status !== 'active') {
          await this.host.request('thread/goal/clear', { threadId: this.host.threadId() }).catch(() => {})
          status = statusOf(await setGoal())
        }
        say(status === 'active' ? `Goal set: ${arg}` : `Goal set (${status}): ${arg}`)
      })
    }
    return null
  }
}
