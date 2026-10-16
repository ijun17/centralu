import { describe, expect, it } from 'vitest'
import { asObj, finite, isObj, str, trimmed } from './json-value.js'

describe('reading JSON another program sent (#850)', () => {
  it('names each meaning once: an object is never a list, text may be empty or must not be blank', () => {
    expect([{}, { a: 1 }, [], null, 'x', 1].map(isObj)).toEqual([true, true, false, false, false, false])
    expect(asObj([1, 2])).toEqual({})
    expect(asObj({ a: 1 })).toEqual({ a: 1 })
    expect([str(''), str(' a '), str(1), str(null, 'none')]).toEqual(['', ' a ', '', 'none'])
    expect([trimmed(' a '), trimmed('  '), trimmed(''), trimmed(1)]).toEqual(['a', undefined, undefined, undefined])
    expect([finite(0), finite(-1.5), finite(Number.NaN), finite(Infinity), finite('1')]).toEqual([0, -1.5, undefined, undefined, undefined])
  })
})
