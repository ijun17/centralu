import { useEffect, useState } from 'react'
import type { SendIntent } from '@cc/platform/ports'
import { usePlatform } from '../../app/PlatformProvider.js'

/**
 * "Working for <caller>" (#1377): a session that owes a delegation report shows who waits for its work when the person
 * types into it, and asks what the message means. Deterministic, kept by the host: **Just asking** (the default) is the
 * person's own turn, not reported, and the report stays open; **Add to the task** makes the turn the work's, noted as
 * their addition; **Take it over** closes the report and tells the caller once.
 */
export const CHOICES: readonly { value: SendIntent; label: string; hint: string }[] = [
  { value: 'ask', label: 'Just asking', hint: 'Your message and its answer stay yours; the work goes on and is still reported' },
  { value: 'task', label: 'Add to the task', hint: 'The answer counts as part of the work and is reported, saying you added to it' },
  { value: 'takeover', label: 'Take it over', hint: 'Stop reporting this work; the session tells whoever waits for it, once' },
]

export type ReportOwed = { callerId: string; callerName: string }

/** Who waits for the session's work, asked once the person starts typing (and again after each message): null when nobody */
export function useReportOwed(sessionId: string, typing: boolean, sent: number): { owed: ReportOwed | null; forget: () => void } {
  const platform = usePlatform()
  const [owed, setOwed] = useState<{ sessionId: string; value: ReportOwed | null } | null>(null)
  useEffect(() => {
    if (!typing) return
    let live = true
    platform.agents.reportOwed(sessionId).then(
      (value) => live && setOwed({ sessionId, value }),
      () => live && setOwed({ sessionId, value: null }),
    )
    return () => {
      live = false
    }
  }, [platform, sessionId, typing, sent])
  return {
    owed: owed?.sessionId === sessionId ? owed.value : null,
    // The report closed (the person took the session over): the choice goes with it, ahead of the next answer
    forget: () => setOwed({ sessionId, value: null }),
  }
}

export function ReportChoice({ owed, value, onChange }: { owed: ReportOwed; value: SendIntent; onChange: (v: SendIntent) => void }) {
  return (
    <div className="mb-2 text-sm text-ink-muted" role="group" aria-label={`Working for ${owed.callerName}`} data-testid="report-choice">
      <span className="mr-2" data-testid="report-choice-for">
        Working for <span className="text-ink">{owed.callerName}</span>
      </span>
      {CHOICES.map((c) => (
        <button
          key={c.value}
          type="button"
          aria-pressed={value === c.value}
          title={c.hint}
          // A click must not take the keyboard from the message being written: Enter then still sends it
          onMouseDown={(e) => e.preventDefault()}
          data-testid={`report-choice-${c.value}`}
          className={`mr-1 rounded-sm px-1.5 py-0.5 ${value === c.value ? 'text-ink underline underline-offset-4' : 'text-ink-faint hover:text-ink'}`}
          onClick={() => onChange(c.value)}
        >
          {c.label}
        </button>
      ))}
      <span className="mt-0.5 block text-xs text-ink-faint" data-testid="report-choice-hint">
        {CHOICES.find((c) => c.value === value)?.hint}
      </span>
    </div>
  )
}
