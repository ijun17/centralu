import { useRef } from 'react'
import { interruptNotice, type SessionSummary } from '@cc/core'
import { formatCount } from '../../../app/format.js'
import { useStore } from '../../../store/store.js'
import { Button } from '../../../components/Button.jsx'
import { PlanStepIcon } from '../../../components/icons.jsx'
import { formatElapsed, useElapsedNow } from '../elapsed.js'

/**
 * A turn being waited for: a moving dot (a first character can take tens of seconds, and only motion
 * tells working from frozen), the elapsed time and Stop, where the waiting eye is. The count is derived
 * from the store's `workingSince` (#23): a start taken on mount would reset on every remount.
 */
export function ActivityRow({ sessionId, activity }: { sessionId: string; activity: SessionSummary['activity'] }) {
  const interrupt = useStore((s) => s.interrupt)
  const startedAt = useStore((s) => s.workingSince[sessionId])
  // An estimate (#58): Claude's thinking body is encrypted
  const thinkingTokens = useStore((s) => s.sessions[sessionId]?.thinkingTokens ?? null)
  const plan = useStore((s) => s.sessions[sessionId]?.plan ?? null)
  // What Stop does to background work, said before the press (#290): the tools differ (Claude stops a
  // subagent and keeps a shell, Codex keeps a child agent), so each task says it of itself
  const notice = useStore((s) => interruptNotice(s.sessions[sessionId]?.backgroundTasks ?? []))
  // Stopping until the tool confirms (#1060: Codex's `turn/completed`, Claude's answer); a refusal says why in the notice's place
  const stop = useStore((s) => s.stopping[sessionId])
  const pressed = stop !== undefined && stop.turn === startedAt
  const unconfirmed = pressed ? stop.failed : undefined
  const stopping = pressed && unconfirmed === undefined
  const line = unconfirmed ?? notice
  const rowRef = useRef<HTMLDivElement>(null)
  // Re-read only when the shown count changes and someone can see it (elapsed.ts, #364)
  const now = useElapsedNow(startedAt ?? null, rowRef)

  // Unknown start: no count rather than a fresh one
  const seconds = startedAt == null ? 0 : Math.max(0, Math.floor((now - startedAt) / 1000))

  return (
    <div ref={rowRef} className="py-2" data-testid="activity-row">
      {/* Codex's plan (#58, turn/plan/updated), gone with the turn;
          status by glyph, not colour */}
      {plan && plan.length > 0 && (
        <ul className="mb-1.5 flex flex-col gap-0.5" data-testid="activity-plan">
          {plan.map((step, i) => (
            <li
              key={i}
              className={`flex items-baseline gap-1.5 text-xs ${step.status === 'inProgress' ? 'text-ink' : 'text-ink-faint'}`}
              data-testid={`plan-step-${i}`}
              data-status={step.status}
            >
              {/* On the first line's baseline, so a step that wraps keeps its icon on its first line */}
              <PlanStepIcon status={step.status} />
              <span className={step.status === 'completed' ? 'line-through opacity-60' : undefined}>
                {step.text}
              </span>
            </li>
          ))}
        </ul>
      )}
      {/*
        In a narrow panel only the notice gives way, down to nothing, its whole text on hover: free to shrink,
        it squeezed the label onto three lines and the dot into a sliver.
      */}
      <div className="flex items-center gap-2">
        <span className="size-1.5 shrink-0 animate-pulse rounded-full bg-ink" aria-hidden data-testid="activity-dot" />
        {/* Compacting was measured at up to 39 seconds,
            so it has its own words */}
        <span className="shrink-0 whitespace-nowrap text-sm text-ink-muted" data-testid="activity-label">
          {activity === 'compacting'
            ? 'Compacting context'
            : activity === 'reviewing'
              ? 'Reviewing changes'
              : // Codex's own word for it (#168): the connection dropped and it is trying again
                activity === 'retrying'
                ? 'Reconnecting'
                : thinkingTokens
                ? `Thinking · ~${formatCount(thinkingTokens)} tokens`
                : 'Waiting for response'}
        </span>
        {/* The width of the widest count ("9m 50s", "2h 11m"),
            so a new digit does not move the notice */}
        {seconds >= 2 && (
          <span className="readout min-w-[6.5ch] shrink-0 whitespace-nowrap text-xs text-ink-faint" data-testid="activity-elapsed">
            {formatElapsed(seconds)}
          </span>
        )}
        {line && (
          <span
            className="min-w-0 flex-1 truncate text-right text-xs text-ink-muted"
            title={line}
            data-testid={unconfirmed !== undefined ? 'interrupt-unconfirmed' : 'interrupt-background-note'}
            role={unconfirmed !== undefined ? 'status' : undefined}
          >
            {line}
          </span>
        )}
        <Button
          variant="subtle"
          size="sm"
          className={`${line ? '' : 'ml-auto '}shrink-0`}
          onClick={() => void interrupt(sessionId)}
          busy={stopping}
          busyText="Stopping…"
          title={stopping ? 'Waiting for the tool to confirm the stop' : notice ? `Stop the turn — ${notice.charAt(0).toLowerCase()}${notice.slice(1)}` : 'Stop the turn'}
          data-testid="activity-interrupt"
          data-stopping={stopping || undefined}
        >
          Stop
        </Button>
      </div>
    </div>
  )
}
