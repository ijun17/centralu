import { describe, expect, it } from 'vitest'
import { asObj, filled, finite, isFilled, isObj, jsonObject, str, trimmed, tryParseJson } from './json-value.js'

describe('reading JSON another program sent (#850)', () => {
  it('names each meaning once: an object is never a list, text may be empty or must not be blank', () => {
    expect([{}, { a: 1 }, [], null, 'x', 1].map(isObj)).toEqual([true, true, false, false, false, false])
    expect(asObj([1, 2])).toEqual({})
    expect(asObj({ a: 1 })).toEqual({ a: 1 })
    expect([str(''), str(' a '), str(1), str(null, 'none')]).toEqual(['', ' a ', '', 'none'])
    expect([trimmed(' a '), trimmed('  '), trimmed(''), trimmed(1)]).toEqual(['a', undefined, undefined, undefined])
    expect([filled('a'), filled(' '), filled(''), filled(1), filled(null)]).toEqual(['a', ' ', null, null, null])
    expect([isFilled('a'), isFilled(''), isFilled(0)]).toEqual([true, false, false])
    expect([finite(0), finite(-1.5), finite(Number.NaN), finite(Infinity), finite('1')]).toEqual([0, -1.5, undefined, undefined, undefined])
  })

  it('reads JSON text as its value, and as undefined when it is not JSON, so null stays a value', () => {
    expect([tryParseJson('{"a":1}'), tryParseJson('null'), tryParseJson('[1]'), tryParseJson('"x"')]).toEqual([{ a: 1 }, null, [1], 'x'])
    expect([tryParseJson(''), tryParseJson('{"a"'), tryParseJson('nope')]).toEqual([undefined, undefined, undefined])
  })

  it('reads a call\'s arguments as an object whether they came as one or as JSON text of one (#843)', () => {
    expect([jsonObject({ a: 1 }), jsonObject('{"a":1}'), jsonObject(JSON.stringify('{"a":1}'))]).toEqual([{ a: 1 }, { a: 1 }, { a: 1 }])
    expect([jsonObject('not json'), jsonObject('[1]'), jsonObject([1]), jsonObject(undefined), jsonObject('"a"')]).toEqual([{}, {}, {}, {}, {}])
  })
})
