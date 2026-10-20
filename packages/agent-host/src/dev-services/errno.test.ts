import { describe, expect, it } from 'vitest'
import { errnoCode } from './errno.js'

describe('errnoCode', () => {
  it('is the code of a failed call, and nothing for what carries none', () => {
    expect(errnoCode(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe('ENOENT')
    for (const odd of [null, undefined, 'ENOENT', 7, new Error('x'), { code: 2 }]) expect(errnoCode(odd)).toBeUndefined()
  })
})
