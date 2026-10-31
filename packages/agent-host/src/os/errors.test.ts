import { describe, expect, it } from 'vitest'
import { errnoCode, isMissing } from './errors.js'

describe('errnoCode', () => {
  it('is the code of a failed call, and nothing for what carries none', () => {
    expect(errnoCode(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('ENOENT')
    for (const odd of [null, undefined, 'ENOENT', 7, new Error('x'), { code: 2 }, { code: 'ENOENT' }]) expect(errnoCode(odd)).toBeUndefined()
  })
})

describe('isMissing', () => {
  it('is true for a path that is not there or has a file where a folder should be, and for nothing else', () => {
    const failed = (code: string) => Object.assign(new Error('x'), { code })
    expect([failed('ENOENT'), failed('ENOTDIR')].map(isMissing)).toEqual([true, true])
    expect([failed('EACCES'), new Error('ENOENT'), 'ENOENT', null, { code: 'ENOENT' }].map(isMissing)).toEqual([false, false, false, false, false])
  })
})
