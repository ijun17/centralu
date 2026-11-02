import { isNewerVersion } from '@cc/protocol'

/** The release the mail switch stack (M3a-host, M3a-person, M6) ships in: before it, mail lives in thread tables; from it, in the message tables (docs/plans/mailbox.md D28) */
export const MAIL_SWITCH_VERSION = '0.1.0-beta.46'

/**
 * Whether a linked machine's one-step rollback from `current` to `previous` goes back across the mail switch (D28): the
 * release left reads mail from the message tables and the one gone back to cannot, so mail waiting there would never
 * arrive. A local build counts as at or after the release it was cut from (`0.1.0-beta.46.local.2`).
 */
export function rollbackCrossesMailSwitch(current: string, previous: string): boolean {
  return !isNewerVersion(MAIL_SWITCH_VERSION, current) && isNewerVersion(MAIL_SWITCH_VERSION, previous)
}

/** S17: the refusal of such a rollback, the same for the tool's answer and Settings' error line */
export function mailSwitchRollbackText(machine: string, previous: string, current: string): string {
  return `${machine} cannot go back to Centralu ${previous}: since ${current} its mail is kept in a form ${previous} cannot read, so mail waiting there would never arrive. Update it instead.`
}
