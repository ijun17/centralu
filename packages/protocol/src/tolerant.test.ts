import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { parseTolerant } from './tolerant.js'
import { parseRpcResult, SessionInfo } from './commands.js'
import { currentSession, missingDefaults, withoutDefaultedFields } from './test-helpers.js'

describe('a client reads an older host (protocol.md §4, #280)', () => {
  it('a session list without the fields added since gets their defaults, backgroundTasks included', () => {
    const old = withoutDefaultedFields(SessionInfo, currentSession('s1')) as Record<string, unknown>
    // What a beta.7 host sent: no backgroundTasks (#305)
    expect(old).not.toHaveProperty('backgroundTasks')
    const [read] = parseRpcResult('sessions.list', [old])
    expect(read!.backgroundTasks).toEqual([])
    expect(missingDefaults(SessionInfo, read)).toEqual([])
  })

  it('one value a newer host invented costs that value only: the rest of the payload still gets its defaults', () => {
    const odd = { ...(withoutDefaultedFields(SessionInfo, currentSession('s1')) as object), state: 'daydreaming' }
    const fine = withoutDefaultedFields(SessionInfo, currentSession('s2'))
    const read = parseRpcResult('sessions.list', [odd, fine])
    expect(read).toHaveLength(2)
    // Kept as it came — what this client did with every value before it parsed any
    expect(read[0]!.state).toBe('daydreaming')
    expect(read[0]!.backgroundTasks).toEqual([])
    expect(read[1]!.backgroundTasks).toEqual([])
    expect(missingDefaults(z.array(SessionInfo), read)).toEqual([])
  })
})

describe('parseTolerant', () => {
  const Item = z.object({ name: z.string(), tags: z.array(z.string()).default([]), level: z.enum(['a', 'b']) })

  it('is a plain parse when the payload fits: defaults applied, unknown fields dropped', () => {
    expect(parseTolerant(Item, { name: 'x', level: 'a', extra: 1 })).toEqual({ name: 'x', tags: [], level: 'a' })
  })

  it('falls back field by field and element by element, never throwing', () => {
    const read = parseTolerant(z.array(Item), [{ name: 'x', level: 'z', extra: 1 }, { name: 'y', level: 'b' }])
    expect(read).toEqual([
      { name: 'x', tags: [], level: 'z' },
      { name: 'y', tags: [], level: 'b' },
    ])
  })

  it('a loose object keeps what it does not declare even when salvaged', () => {
    const Loose = z.looseObject({ n: z.number(), d: z.boolean().default(false) })
    expect(parseTolerant(Loose, { n: 'one', more: true })).toEqual({ n: 'one', d: false, more: true })
  })

  it('a tagged union is salvaged as the branch its tag names', () => {
    const U = z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a'), list: z.array(z.string()).default([]), n: z.number() }),
      z.object({ kind: z.literal('b') }),
    ])
    expect(parseTolerant(U, { kind: 'a', n: 'NaN' })).toEqual({ kind: 'a', list: [], n: 'NaN' })
  })

  it('a value that is not even the right kind is handed on as it came', () => {
    expect(parseTolerant(Item, 'not an object')).toBe('not an object')
    expect(parseTolerant(z.array(Item), null)).toBe(null)
  })
})
