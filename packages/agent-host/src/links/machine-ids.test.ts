import { describe, expect, it } from 'vitest'
import { SessionId } from '@cc/protocol'
import { decodeNumber, encodeNumber, newMachineId, qualify, splitQualified } from './machine-ids.js'

describe('machine-qualified ids (#82)', () => {
  it('a qualified id is still a valid session id, and splits back at its first dot', () => {
    const id = qualify('ubuntu', '7dd9d2ba-8d4e-47e7-9083-299051f6ecba')
    expect(SessionId.safeParse(id).success).toBe(true)
    expect(splitQualified(id)).toEqual({ machine: 'ubuntu', id: '7dd9d2ba-8d4e-47e7-9083-299051f6ecba' })
    // A per-host counter keeps its own shape after the prefix
    expect(splitQualified('m1.term-3')).toEqual({ machine: 'm1', id: 'term-3' })
  })

  it('an id without a machine-shaped prefix is the hub’s own', () => {
    expect(splitQualified('7dd9d2ba-8d4e-47e7-9083-299051f6ecba')).toBeNull()
    expect(splitQualified('term-3')).toBeNull()
    // Not a machine id: starts with a digit, has an upper-case letter, or nothing follows the dot
    expect(splitQualified('1m.x')).toBeNull()
    expect(splitQualified('Ubuntu.x')).toBeNull()
    expect(splitQualified('m1.')).toBeNull()
  })

  it('folds a remote number into a negative one no local row id can be, and back', () => {
    const folded = encodeNumber(1, 7)
    expect(folded).toBeLessThan(0)
    expect(decodeNumber(folded)).toEqual({ slot: 1, n: 7 })
    expect(decodeNumber(encodeNumber(3, 0))).toEqual({ slot: 3, n: 0 })
    // Two machines' rule 7 stay apart
    expect(encodeNumber(1, 7)).not.toBe(encodeNumber(2, 7))
    // A local id is never read as a folded one
    expect(decodeNumber(7)).toBeNull()
    expect(decodeNumber(0)).toBeNull()
  })

  it('derives a machine id from the name, unique among the ones taken', () => {
    expect(newMachineId('Ubuntu server', new Set())).toBe('ubuntu-server')
    expect(newMachineId('ubuntu', new Set(['ubuntu']))).toBe('ubuntu-2')
    expect(newMachineId('My.Box', new Set())).toBe('my-box')
    // Nothing usable in the name: a random one, still a machine id
    expect(newMachineId('서버', new Set())).toMatch(/^m-[0-9a-f]{6}$/)
  })
})
