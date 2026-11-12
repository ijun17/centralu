import { oneLineText, type BackgroundTask, type NormalizedEvent } from '@cc/protocol'

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

const NONE: ReadonlySet<string> = new Set()

const KIND_WORDS: Record<BackgroundTask['kind'], string> = { agent: 'agent', shell: 'shell', mcp: 'MCP task', other: 'task' }

/**
 * The conversation's one line for a task that ended failed or stopped (#2230), whatever its kind: which task, how it ended and
 * the reason when the tool gave one. A task that completed leaves none. The list of background work shows only the current burst,
 * so this line is what remains of an ended task.
 */
function endedNotice(sessionId: string, t: BackgroundTask): NormalizedEvent[] {
  if (t.status !== 'failed' && t.status !== 'stopped') return []
  const why = t.summary ? `: ${oneLineText(t.summary, BACKGROUND_SUMMARY_CHARS)}` : ''
  return [
    {
      type: 'notice',
      sessionId,
      level: t.status === 'failed' ? 'warning' : 'info',
      text: `Background ${KIND_WORDS[t.kind]} "${oneLineText(t.description, 80)}" ${t.status}${why}`,
      from: 'Centralu',
      label: 'background task',
    },
  ]
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

  /**
   * `carded`: the launch cards that carry the ending of their own task as they close with it (a background agent's card marked failed with the reason when the process
   * goes away). A task whose card is one of them leaves no line of its own: its ending is said once
   */
  event(live: BackgroundTask[], ended: BackgroundTask[] = [], snapshot = false, carded: ReadonlySet<string> = NONE): NormalizedEvent[] {
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
      ...ended.flatMap((t) => (t.parentCallId !== undefined && carded.has(t.parentCallId) ? [] : endedNotice(this.sessionId, t))),
    ]
  }
}
