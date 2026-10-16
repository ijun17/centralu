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

// The app's log is masked a line at a time (#838 review): a PEM printed raw went out a line at a time, unmasked
describe('a multi-line secret in the app log, masked line by line', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\nBKcwggSjAgEAAoIBAQDf\n}\n-----END PRIVATE KEY-----'
  it('masks each line long enough to be the key, one line at a time', () => {
    const redact = redactor({ KEY: pem })
    const logged = pem.split('\n').map(redact)
    expect(logged.join('\n')).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEFAASC')
    expect(logged.join('\n')).not.toContain('BKcwggSjAgEAAoIBAQDf')
    // A short line is not a key's: left as it is
    expect(logged[3]).toBe('}')
  })

  // One long line and a short one (#945 review): counting only the long lines took it for a one-line value
  it('masks the one long line of a value whose other lines are short', () => {
    const value = 'abcdefghijklmnopqrstuvwxyz0123\nend'
    const redact = redactor({ K: value })
    expect(value.split('\n').map(redact)).toEqual(['[redacted:K]', 'end'])
  })

  it('a one-line value is not split', () => {
    expect(redactor({ T: 'plain-token-value-1234' })('x plain-token-value-1234 y')).toBe('x [redacted:T] y')
  })
})
