/**
 * Placeholders for what a screen is still reading (a session's history, a project's changes, a file).
 *
 * The shape of what will stand there, in quiet surface colours, instead of an empty area or a bare
 * "Loading…": an empty area reads as stalled, and a line of text jumps when the content replaces it.
 * Waiting is not a signal meant to call the person (the palette rule), so nothing here is bright.
 *
 * It fades in after a short delay (`.cc-skeleton`, styles/index.css): a read that answers at once
 * never flashes it, and only a wait the eye would notice shows it.
 */
const BAR = 'animate-pulse rounded-md bg-surface-hover/50'

/** Lines of text still on their way; the widths step down so it reads as a paragraph, not a table */
export function SkeletonLines({
  lines = 3,
  className = '',
  label = 'Loading',
  testId,
}: {
  lines?: number
  className?: string
  /** What a screen reader hears; nothing is shown */
  label?: string
  testId?: string
}) {
  return (
    <div
      className={`cc-skeleton flex flex-col gap-2 ${className}`}
      role="status"
      aria-label={label}
      data-testid={testId}
    >
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className={`h-2.5 ${BAR}`} style={{ width: `${WIDTHS[i % WIDTHS.length]}%` }} />
      ))}
    </div>
  )
}

const WIDTHS = [72, 88, 56, 80, 64]

/**
 * A conversation being read: the person's message on the right, the agent's answer on the left, twice.
 * Drawn in the chat's own column and spacing, so the first rows land where the skeleton stood.
 */
export function ChatSkeleton({ testId = 'chat-skeleton' }: { testId?: string }) {
  return (
    <div
      className="cc-skeleton flex flex-col"
      role="status"
      aria-label="Loading the conversation"
      data-testid={testId}
    >
      {[0, 1].map((turn) => (
        <div key={turn} className="flex flex-col">
          {/* The conversation's shapes: the person's bubble on the right, the answer's full-width bubble on the left */}
          <div className="flex justify-end pb-4 pt-6">
            <div
              className="h-10 animate-pulse rounded-[14px] bg-surface-hover/50"
              style={{ width: turn === 0 ? '38%' : '26%' }}
            />
          </div>
          <div className="mb-3 flex flex-col gap-2 rounded-[14px] border border-line bg-surface-raised px-4 py-3.5">
            {(turn === 0 ? [92, 84, 96, 48] : [88, 70]).map((w, i) => (
              <div key={i} className={`h-3 ${BAR}`} style={{ width: `${w}%` }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
