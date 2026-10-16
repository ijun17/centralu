import { describe, expect, it } from 'vitest'
import { describeArgs } from './runs.js'
import { redactor } from './secrets.js'

/*
 * A run record keeps an app call's arguments as JSON (#838), where a value with a line break or a quote is spelled
 * escaped. Only the raw value was masked, so a multi-line key passed as an argument stayed in the record whole.
 */
describe('a secret is masked in a run record however JSON spells it', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B\n-----END PRIVATE KEY-----'
  const quoted = 'pa"ss\\word\ttab'

  it('a multi-line key and one with quotes, a backslash and a tab are masked in the kept arguments', () => {
    const redact = redactor({ KEY: pem, PASS: quoted })
    const kept = describeArgs({ key: pem, nested: { pass: quoted }, note: 'ok' }, redact)
    expect(kept.json).not.toContain('MIIEvQIBADANBgkqhkiG9w0B')
    expect(kept.json).not.toContain('ss\\\\word')
    expect(kept.json).toContain('[redacted:KEY]')
    expect(kept.json).toContain('[redacted:PASS]')
    expect(kept.summary).not.toContain('MIIEvQIBADANBgkqhkiG9w0B')
  })

  it('the raw value is still masked in plain text, such as an app log', () => {
    expect(redactor({ KEY: pem })(`loaded ${pem} from env`)).toBe('loaded [redacted:KEY] from env')
  })

  it('a value JSON spells as it is has one form, masked once', () => {
    expect(redactor({ T: 'plain-token' })(JSON.stringify({ t: 'plain-token' }))).toBe('{"t":"[redacted:T]"}')
  })
})
