/**
 * The colours of a message bubble, for every conversation (docs/design-system.md §7): the person's own words or anyone
 * else's. Never dashed (#1629). Shape, size and spacing stay with each caller.
 */
export function bubbleLook(side: 'mine' | 'theirs'): string {
  return side === 'mine' ? 'border-line-bubble-mine bg-surface-hover text-ink' : 'border-line bg-surface-raised text-ink'
}
