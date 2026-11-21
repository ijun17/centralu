import type { GroupAttention } from '../fold.js'

/**
 * What a folded group hides (#666): a quiet count, and a dot in the signal ink when a hidden row needs an answer, one
 * step quieter when it is only unread (docs/themes.md "The urgency order").
 */
export function FoldedMark({ count, attention, testId }: { count: number; attention: GroupAttention | null; testId: string }) {
  const label =
    `${count} hidden` +
    (attention === 'alert' ? ', one needs you' : attention === 'unread' ? ', one unread' : '')
  return (
    <span className="flex shrink-0 items-center gap-1" aria-label={label} title={label} data-testid={testId}>
      <span className="readout text-2xs text-ink-faint" data-testid={`${testId}-count`}>
        {count}
      </span>
      {attention && (
        <span
          className={`size-1.5 rounded-full ${attention === 'alert' ? 'bg-ink-signal' : 'bg-ink-muted'}`}
          data-testid={`${testId}-attention`}
          data-attention={attention}
        />
      )}
    </span>
  )
}
