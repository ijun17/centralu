/**
 * The colours of a message bubble, one definition for every conversation the person reads: a session's (its answers, the
 * person's messages and their pinned copy) and a mail thread's in the Inbox (owner, 2026-11-14). The person's own words sit
 * on `surface-hover` with their own edge; everything anyone else said (the agent, another session, an app, a script) on
 * `surface-raised` with the `line` edge. The edge is never dashed: a dashed edge means failed or unknown everywhere else
 * (#1629). Shape, size and spacing stay with each caller.
 */
export function bubbleLook(side: 'mine' | 'theirs'): string {
  return side === 'mine' ? 'border-line-bubble-mine bg-surface-hover text-ink' : 'border-line bg-surface-raised text-ink'
}
