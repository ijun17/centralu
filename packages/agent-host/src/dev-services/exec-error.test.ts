import { describe, expect, it } from 'vitest'
import { execFailure } from './exec-error.js'

describe('execFailure', () => {
  it('reads what a failed call carries, and only in the kind it is expected in', () => {
    const e = Object.assign(new Error('Command failed'), { code: 128, stderr: 'fatal: x', stdout: 'out', timedOut: true })
    expect(execFailure(e)).toMatchObject({ code: 128, stderr: 'fatal: x', stdout: 'out', message: 'Command failed', timedOut: true })
    expect(execFailure({ stderr: Buffer.from('bytes'), timedOut: 'yes', message: 3 })).toMatchObject({ stderr: undefined, timedOut: undefined, message: undefined })
  })

  it('reads what is not an object as a failure with nothing in it', () => {
    for (const odd of [null, undefined, 'boom', 7]) expect(execFailure(odd)).toEqual({})
  })
})
