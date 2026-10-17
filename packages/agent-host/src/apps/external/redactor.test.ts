import { describe, expect, it } from 'vitest'
import { canonicalJson, describeArgs, RunRow, type RunLedger } from './runs.js'
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

  /*
   * #838 item 13, checked again: a value holding the secret already JSON-escaped (JSON passed as text, an app answering
   * with JSON) was escaped a second time when the record was written, a spelling neither masked form matched.
   */
  it('a secret already JSON-escaped inside a value is masked, in the arguments and in a failed result', () => {
    const secret = 'qu"ote\\Secret-7781'
    const redact = redactor({ PASS: secret })
    const asText = JSON.stringify({ token: secret })
    const kept = describeArgs({ body: asText }, redact)
    expect(kept.json).not.toContain('Secret-7781')
    expect(kept.json).toContain('[redacted:PASS]')
    let failure: { result: string | null } | null = null
    const ledger = { begin: () => {}, end: () => {}, link: () => {}, keepFailure: (f: { result: string | null }) => void (failure = f) } as unknown as RunLedger
    const head = { id: 'r1', projectId: null, appId: 'a', kind: 'tool', tool: 't', callerKind: 'agent', callerSessionId: null, parentRunId: null, createdAt: 0 }
    const row = new RunRow(ledger, head as ConstructorParameters<typeof RunRow>[1], {}, redact)
    row.close('error', 'failed', { content: [{ type: 'text', text: asText }], isError: true })
    expect(failure!.result).not.toContain('Secret-7781')
    expect(failure!.result).toContain('[redacted:PASS]')
  })

  // Review of #1075: copied into a plain object, a parsed `__proto__` key went to the prototype setter and was lost
  it('keeps a key named __proto__, in the arguments, a failed result and a canonical hash', () => {
    const redact = redactor({ PASS: 'hunter2-secret' })
    const value = JSON.parse('{"__proto__":{"token":"hunter2-secret"},"isError":true}') as Record<string, unknown>
    expect(describeArgs(value, redact).json).toBe('{"__proto__":{"token":"[redacted:PASS]"},"isError":true}')
    let failure: { result: string | null } | null = null
    const ledger = { begin: () => {}, end: () => {}, link: () => {}, keepFailure: (f: { result: string | null }) => void (failure = f) } as unknown as RunLedger
    const head = { id: 'r2', projectId: null, appId: 'a', kind: 'tool', tool: 't', callerKind: 'agent', callerSessionId: null, parentRunId: null, createdAt: 0 }
    new RunRow(ledger, head as ConstructorParameters<typeof RunRow>[1], {}, redact).close('error', 'failed', value as never)
    expect(failure!.result).toBe('{"__proto__":{"token":"[redacted:PASS]"},"isError":true}')
    expect(canonicalJson(JSON.parse('{"__proto__":{"a":1}}'))).not.toBe(canonicalJson(JSON.parse('{"__proto__":{"a":2}}')))
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
