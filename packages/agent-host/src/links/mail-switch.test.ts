import { describe, expect, it } from 'vitest'
import { MAIL_SWITCH_VERSION, mailSwitchRollbackText, rollbackCrossesMailSwitch } from './mail-switch.js'

/** A rollback across the release that moved mail to the message tables strands that machine's mail (docs/plans/mailbox.md D28, S17) */
describe('rollbackCrossesMailSwitch', () => {
  it('is the switch release, or later, going back to one before it', () => {
    expect(MAIL_SWITCH_VERSION).toBe('0.1.0-beta.46')
    expect(rollbackCrossesMailSwitch('0.1.0-beta.46', '0.1.0-beta.45')).toBe(true)
    expect(rollbackCrossesMailSwitch('0.1.0-beta.47', '0.1.0-beta.44')).toBe(true)
    expect(rollbackCrossesMailSwitch('0.1.0', '0.1.0-beta.45')).toBe(true)
  })

  it('is not a step within one side of it', () => {
    expect(rollbackCrossesMailSwitch('0.1.0-beta.47', '0.1.0-beta.46')).toBe(false)
    expect(rollbackCrossesMailSwitch('0.1.0-beta.45', '0.1.0-beta.44')).toBe(false)
    expect(rollbackCrossesMailSwitch('0.2.0', '0.1.0')).toBe(false)
  })

  it('orders prereleases as releases do: numerically, below the release, and a local build at the release it was cut from', () => {
    // beta.100 is after beta.46, not before it as text would sort it
    expect(rollbackCrossesMailSwitch('0.1.0-beta.100', '0.1.0-beta.9')).toBe(true)
    expect(rollbackCrossesMailSwitch('0.1.0-beta.100', '0.1.0-beta.46')).toBe(false)
    // An alpha of the same core is before any beta
    expect(rollbackCrossesMailSwitch('0.1.0-beta.46', '0.1.0-alpha.50')).toBe(true)
    expect(rollbackCrossesMailSwitch('0.1.0-beta.46.local.2', '0.1.0-beta.45')).toBe(true)
    expect(rollbackCrossesMailSwitch('0.1.0-beta.46.local.2', '0.1.0-beta.46')).toBe(false)
    expect(rollbackCrossesMailSwitch('0.1.0-beta.45.local.3', '0.1.0-beta.45')).toBe(false)
  })
})

describe('mailSwitchRollbackText', () => {
  it('is S17', () => {
    expect(mailSwitchRollbackText('Box', '0.1.0-beta.45', '0.1.0-beta.46')).toBe(
      'Box cannot go back to Centralu 0.1.0-beta.45: since 0.1.0-beta.46 its mail is kept in a form 0.1.0-beta.45 cannot read, so mail waiting there would never arrive. Update it instead.',
    )
  })
})
