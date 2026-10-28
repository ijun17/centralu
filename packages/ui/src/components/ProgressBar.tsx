/**
 * A thin bar for work with a known end (an install's download). `value` is 0 to 1; null is a bar of unknown length, which
 * breathes (`.breathe`, the signal for work in progress) instead of filling. The fill moves as a transition of its width
 * (180ms, `.cc-progress`), so a reading is followed, not jumped to; with reduced motion it changes without travel.
 */
export function ProgressBar({ value, label, testId, className = '' }: { value: number | null; label: string; testId?: string; className?: string }) {
  const pct = value === null ? 100 : Math.max(0, Math.min(1, value)) * 100
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value === null ? undefined : Math.round(pct)}
      className={`h-1 overflow-hidden rounded-full bg-line ${className}`}
      data-testid={testId}
    >
      <div className={`cc-progress h-full rounded-full bg-ink-muted ${value === null ? 'breathe' : ''}`} style={{ width: `${pct}%` }} />
    </div>
  )
}
