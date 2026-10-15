import type { GroupAttention } from '../fold.js'

/**
 * What a folded group says about the rows it hides (#666): how many, and a sign when one of them needs the person.
 *
 * The count is quiet (faint ink, no chip): it explains why the rows below are missing. The sign is the part that must
 * not be lost with the rows: a dot in the signal ink when a hidden row needs an answer (approval, question, error),
 * one step quieter when it is only unread. Pure white is spent on the first alone, the way a row's mark spends it on
 * "waiting for you" and nowhere else.
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
