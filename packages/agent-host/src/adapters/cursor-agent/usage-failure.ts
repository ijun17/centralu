/**
 * Each way reading Cursor's plan usage can fail, and the one reason the panel shows for it (#2459; ux-writing.md §1). The
 * plan stays on screen whatever the kind (`ToolQueries.usageFor`)
 */
const REASONS = {
  'no-token': "Cursor's sign-in could not be read on this computer",
  'signed-out': 'Sign in to Cursor again to see its usage',
  refused: 'Cursor did not share its usage',
  unreachable: "Cursor's usage could not be reached",
  unreadable: "Cursor's usage answer could not be read",
  'no-limit': 'Cursor does not report a limit for this plan',
} as const

export type CursorUsageFailureKind = keyof typeof REASONS

/** `detail` goes to host.log only, and is built from fixed words, a status or an exit code: never the token or an answer */
export class CursorUsageFailure extends Error {
  constructor(
    readonly kind: CursorUsageFailureKind,
    readonly detail: string,
  ) {
    super(REASONS[kind])
  }
}
