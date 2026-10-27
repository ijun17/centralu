import { describe, expect, it } from 'vitest'
import { errorMessage } from './error-message.js'

describe('errorMessage', () => {
  it("reads an Error's message, its subclasses' too", () => {
    expect(errorMessage(new Error('disk full'))).toBe('disk full')
    expect(errorMessage(new TypeError('not a function'))).toBe('not a function')
  })

  it('reads the string message of an object that is not an Error here', () => {
    expect(errorMessage({ message: 'from another realm', code: 'E1' })).toBe('from another realm')
  })

  it('writes out anything else that was thrown, where `(e as Error).message` read undefined or threw', () => {
    expect(errorMessage('plain words')).toBe('plain words')
    expect(errorMessage(404)).toBe('404')
    expect(errorMessage(undefined)).toBe('undefined')
    expect(errorMessage(null)).toBe('null')
    expect(errorMessage({ message: 7 })).toBe('[object Object]')
  })

  it('never throws, even for a value that cannot be written out', () => {
    const throwing = {
      toString: () => {
        throw new Error('no')
      },
    }
    expect(errorMessage(Object.create(null))).toBe('(a thrown object that cannot be written out)')
    expect(errorMessage(throwing)).toBe('(a thrown object that cannot be written out)')
  })
})
