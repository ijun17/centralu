import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { JsonObject, parseJson, readJson, readJsonList, readJsonObjects } from './json.js'
import { flagSetting } from './settings.js'

describe('reading stored JSON (#850)', () => {
  it('parseJson is undefined for nothing stored and for text that is not JSON', () => {
    expect(parseJson(null)).toBeUndefined()
    expect(parseJson(undefined)).toBeUndefined()
    expect(parseJson('')).toBeUndefined()
    expect(parseJson('{"a"')).toBeUndefined()
    expect(parseJson('null')).toBeNull()
    expect(parseJson('[1]')).toEqual([1])
  })

  it('readJson falls back for nothing, not JSON, and the wrong shape', () => {
    for (const raw of [null, '', 'nope', '[]', 'null', '"x"']) expect(readJson(raw, JsonObject, { d: 1 })).toEqual({ d: 1 })
    expect(readJson('{"a":1}', JsonObject, {})).toEqual({ a: 1 })
  })

  it('readJsonList keeps the good elements of a list and reads anything else as empty', () => {
    expect(readJsonList('["a", 1, "b", null]', z.string())).toEqual(['a', 'b'])
    for (const raw of [null, '{', '{"a":1}', '"a"']) expect(readJsonList(raw, z.string())).toEqual([])
  })

  it('readJsonObjects keeps every field of an element it keeps, so a newer build’s field survives a write-back', () => {
    const raw = JSON.stringify([{ name: 'a', extra: true }, ['name'], null, { other: 1 }, { name: 'b' }])
    expect(readJsonObjects(raw, (x) => typeof x.name === 'string')).toEqual([{ name: 'a', extra: true }, { name: 'b' }])
  })
})

describe('flagSetting (#850)', () => {
  function settings(initial: Record<string, string> = {}) {
    const kv = new Map(Object.entries(initial))
    return { kv, appSetting: (k: string) => kv.get(k) ?? null, setAppSetting: (k: string, v: string) => void kv.set(k, v) }
  }

  it('reads true and false as written, and anything else as the default', () => {
    const s = settings({ on: 'true', off: 'false', odd: '1' })
    expect(flagSetting(s, 'on', false).read()).toBe(true)
    expect(flagSetting(s, 'off', true).read()).toBe(false)
    expect(flagSetting(s, 'odd', true).read()).toBe(true)
    expect(flagSetting(s, 'odd', false).read()).toBe(false)
    expect(flagSetting(s, 'never', true).read()).toBe(true)
  })

  it('writes the strings an older build reads', () => {
    const s = settings()
    flagSetting(s, 'k', true).write(false)
    expect(s.kv.get('k')).toBe('false')
    flagSetting(s, 'k', true).write(true)
    expect(s.kv.get('k')).toBe('true')
  })
})
