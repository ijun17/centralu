import type { LimitsReasons } from '../token-limits/failure.js'

/** The one reason the panel shows for each way reading Cursor's plan usage fails (#2459); the plan stays on screen whatever the kind */
export const CURSOR_REASONS: LimitsReasons = {
  'no-token': "Cursor's sign-in could not be read on this computer",
  expired: 'Sign in to Cursor again to see its usage',
  'signed-out': 'Sign in to Cursor again to see its usage',
  refused: 'Cursor did not share its usage',
  unreachable: "Cursor's usage could not be reached",
  unreadable: "Cursor's usage answer could not be read",
}
