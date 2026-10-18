import type { BackgroundTask, NormalizedEvent } from '@cc/protocol'

/**
 * How much of how a background task ended its entry carries, the same for both tools (#843): Claude's
 * `task_notification` summary was cut here while a Codex child's error went whole, so one screen row was a line and
 * the other a page. The task's own output stays where the tool keeps it.
 */
export const BACKGROUND_SUMMARY_CHARS = 300

/** An ended task's summary as both adapters carry it: cut at `BACKGROUND_SUMMARY_CHARS`, absent when there is none */
export function endedSummary(text: string | undefined): { summary?: string } {
  const summary = (text ?? '').slice(0, BACKGROUND_SUMMARY_CHARS)
  return summary ? { summary } : {}
}

/**
 * The `background_tasks` events of one session, by one rule for both tools (#843): an event when the live list or an
 * ending moved, nothing when neither did. Codex skipped a repeat and Claude sent every one, and each repeat is a store
 * write on the host (`applyBackgroundTasks`, `rememberBackgroundTasks`). A tool's whole list (`snapshot`) always goes
 * out: it is what settles what an adopted process holds (#648), whether or not it differs.
 */
export class BackgroundEvents {
  private last = '[]'

  constructor(private readonly sessionId: string) {}

  event(live: BackgroundTask[], ended: BackgroundTask[] = [], snapshot = false): NormalizedEvent[] {
    const key = JSON.stringify(live)
    if (key === this.last && ended.length === 0 && !snapshot) return []
    this.last = key
    return [
      {
        type: 'background_tasks',
        ...(snapshot ? { snapshot: true as const } : {}),
        sessionId: this.sessionId,
        live,
        ...(ended.length ? { ended } : {}),
      },
    ]
  }
}
