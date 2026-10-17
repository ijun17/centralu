import { describe, expect, it } from 'vitest'
import { asError, rethrowAsError, toError } from './to-error.js'

describe('toError (#972 item 2)', () => {
  it('keeps an Error, and makes the reason of a string or an object with a message the message', () => {
    const e = new Error('kept')
    expect(toError(e)).toBe(e)
    expect(toError('Rust said no').message).toBe('Rust said no')
    expect(toError({ message: 'plugin said no' }).message).toBe('plugin said no')
    expect(toError(42).message).toBe('42')
  })

  it('rethrows and wraps a sync throw or a rejection as an Error', async () => {
    expect(() => rethrowAsError('x')).toThrow(Error)
    await expect(asError(() => { throw 'sync' })).rejects.toThrow('sync')
    await expect(asError(() => Promise.reject('async'))).rejects.toThrow('async')
    await expect(asError(() => 7)).resolves.toBe(7)
  })
})
