/**
 * The look of the person's bubble on the right, in one place for the row (ChatRow) and its pinned
 * copy at the top (StickyUser). A message that came from another session, an app or a script
 * (relayed) keeps the shape of the person's bubble
 * (#1629). Relayed is drawn as the agent's answer bubble is: its fill (surface-raised) and its edge
 * (line), so a message that is not the person's reads as the other side's, and no token of its own is
 * needed. The edge is never dashed: a dashed edge means failed or unknown everywhere else.
 */
export function isRelayed(item: { from?: unknown; fromApp?: unknown; fromScript?: unknown }): boolean {
  return Boolean(item.from || item.fromApp || item.fromScript)
}

/** The colour classes of a bubble (shape, size and spacing stay with each caller) */
export function mineBubbleLook(relayed: boolean): string {
  return relayed ? 'border-line bg-surface-raised text-ink' : 'border-ink-faint/40 bg-surface-hover text-ink'
}

/** The marker the stylesheet reads: a light-theme edge override must leave a relayed bubble alone */
export function mineBubbleAttrs(relayed: boolean): { 'data-mine-bubble': ''; 'data-relayed'?: '' } {
  return relayed ? { 'data-mine-bubble': '', 'data-relayed': '' } : { 'data-mine-bubble': '' }
}
