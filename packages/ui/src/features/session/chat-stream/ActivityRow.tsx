import { useRef } from 'react'
import { interruptNotice, type SessionSummary } from '@cc/core'
import { useStore } from '../../../store/store.js'
import { formatElapsed, useElapsedNow } from '../elapsed.js'

/**
 * The indicator that says a response is being waited for.
 *
 * It is common for the first character to take tens of seconds to arrive, and if the screen is
 * completely quiet the whole time, **there is no way to tell whether it is working or has
 * stopped** (found in dogfooding).
 *
 * So two things are shown together:
 *   - A moving dot: "it is alive". In the end, movement is the only thing that sets it apart
 *     from a frozen screen.
 *   - Elapsed time: "how long has this been going". 3 seconds and 3 minutes are not the same
 *     kind of "waiting" — watching the number climb also confirms it has not stopped.
 *
 * The stop button lives here too. It is also at the top, but the eyes of someone waiting are at
 * the bottom of the conversation.
 *
 * **The count is derived; only the tick lives here** (issue #23). This used to read
 * `Date.now()` on mount and treat that as the start of the turn, which held right up until
 * the component was remounted — switching to the grid and back, or moving between sessions,
 * put a three-minute turn back at zero. The lie was small and in the worst direction: the
 * longer a wait, the more the number understated it.
 *
 * Keeping the component alive would not have been the fix. What was stored was the wrong
 * thing — an elapsed count, which is derived, and derived values should not be the thing
 * that survives. The start instant lives on the store now (`workingSince`), and this
 * subtracts it from the current time. The clock below no longer carries any state; it
 * exists only to make the time be re-read when the shown count would change (elapsed.ts).
 */
export function ActivityRow({ sessionId, activity }: { sessionId: string; activity: SessionSummary['activity'] }) {
  const interrupt = useStore((s) => s.interrupt)
  const startedAt = useStore((s) => s.workingSince[sessionId])
  // The amount of thinking (#58) — Claude's thinking body is encrypted, so this estimate is all
  // there is to show
  const thinkingTokens = useStore((s) => s.sessions[sessionId]?.thinkingTokens ?? null)
  // A plan snapshot (#58, Codex) — it has the same lifetime as activity, so this row (which
  // only lives while working) is the right home for it
  const plan = useStore((s) => s.sessions[sessionId]?.plan ?? null)
  /*
   * What Stop does to the background work (#290), said before it is pressed. On 2026-10-04 an interrupt to rephrase
   * a message stopped two background subagents without a word; the tools differ (Claude stops a subagent and keeps a
   * shell, Codex keeps a child agent), so the line comes from what each task says about itself.
   */
  const notice = useStore((s) => interruptNotice(s.sessions[sessionId]?.backgroundTasks ?? []))
  const rowRef = useRef<HTMLDivElement>(null)
  // Re-read only when the shown count changes and someone can see it (elapsed.ts, #364)
  const now = useElapsedNow(startedAt ?? null, rowRef)

  // No instant means we genuinely do not know when this turn began — say nothing rather
  // than start a fresh count, which is the mistake this whole row is here to stop making
  const seconds = startedAt == null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))

  return (
    <div ref={rowRef} className="py-2" data-testid="activity-row">
      {/*
        The plan checklist (#58, Codex's turn/plan/updated). Being progress display, it lives
        here (visible only while working) — it disappears along with activity once the turn
        ends. Status is told apart by glyph, not color (the palette rule: distinguish by shape).
      */}
      {plan && plan.length > 0 && (
        <ul className="mb-1.5 flex flex-col gap-0.5" data-testid="activity-plan">
          {plan.map((step, i) => (
            <li
              key={i}
              className={`flex items-baseline gap-1.5 text-xs ${step.status === 'inProgress' ? 'text-ink' : 'text-ink-faint'}`}
              data-testid={`plan-step-${i}`}
              data-status={step.status}
            >
              <span className="readout shrink-0" aria-hidden>
                {step.status === 'completed' ? '✓' : step.status === 'inProgress' ? '▸' : '○'}
              </span>
              <span className={step.status === 'completed' ? 'line-through opacity-60' : undefined}>
                {step.text}
              </span>
            </li>
          ))}
        </ul>
      )}
      {/*
        What gives way in a narrow panel is the background notice, and only it (0.1.0-beta.9, the owner's screenshot):
        with every part free to shrink, the notice's long line squeezed the label onto three lines and the dot into a
        sliver. The dot, the label, the elapsed time and Stop keep their size; the notice takes what is left, cut short
        with its whole text on hover, down to nothing before anything else wraps.
      */}
      <div className="flex items-center gap-2">
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-ink" aria-hidden data-testid="activity-dot" />
        {/*
        Not the same kind of "waiting". Compacting has been measured to take up to 39 seconds,
        and with the same wording, someone waiting has no way to tell whether it has stopped or
        is just taking a while.
      */}
        <span className="shrink-0 whitespace-nowrap text-sm text-ink-muted" data-testid="activity-label">
          {activity === 'compacting'
            ? 'Compacting context'
            : activity === 'reviewing'
              ? 'Reviewing changes'
              : // Codex's own word for it (#168): the connection dropped and it is trying again
                activity === 'retrying'
                ? 'Reconnecting'
                : thinkingTokens
                ? `Thinking · ~${thinkingTokens >= 1000 ? `${(thinkingTokens / 1000).toFixed(1)}k` : thinkingTokens} tokens`
                : 'Waiting for response'}
        </span>
        {/*
          Showing a number for a one-second wait would just be noise. The minimum width holds the widest the count gets
          ("9m 50s", "2h 11m"), so a count that grows a digit does not move the notice next to it.
        */}
        {seconds >= 2 && (
          <span className="readout min-w-[6.5ch] shrink-0 whitespace-nowrap text-xs text-ink-faint" data-testid="activity-elapsed">
            {formatElapsed(seconds)}
          </span>
        )}
        {notice && (
          <span
            className="min-w-0 flex-1 truncate text-right text-xs text-ink-muted"
            title={notice}
            data-testid="interrupt-background-note"
          >
            {notice}
          </span>
        )}
        <button
          type="button"
          className={`${notice ? '' : 'ml-auto '}shrink-0 rounded-md border border-line px-2 py-0.5 text-xs text-ink-faint transition-colors hover:border-line-strong hover:text-ink`}
          onClick={() => void interrupt(sessionId)}
          title={notice ? `Stop the turn — ${notice.charAt(0).toLowerCase()}${notice.slice(1)}` : 'Stop the turn'}
          data-testid="activity-interrupt"
        >
          Stop
        </button>
      </div>
    </div>
  )
}
