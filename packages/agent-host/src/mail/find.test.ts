import { describe, expect, it } from 'vitest'
import { FIND_LIMIT, entryOf, findAnswer, named, ranked, type FoundEntry } from './find.js'

/**
 * The directory search a session runs with `mail find` (#2067 item 3, docs/plans/linked-mail.md §8): the ranking, the
 * name lookup `mail send` uses across machines, and the cost of an answer, which stays the same however many sessions
 * there are.
 */

const MACHINES = ['Desk', 'Laptop', 'Build box', null] as const
const PROJECTS = ['centralu', 'website', 'billing', 'infra', null] as const
const NAMES = ['PR review', 'Fix flaky launcher test', 'Release notes', 'Billing export', 'Refactor the mail store', 'Docs pass', 'Investigate slow start']

/** `n` sessions spread over four computers and five projects, as a person with several machines has them */
function directory(n: number): FoundEntry[] {
  return Array.from({ length: n }, (_, i) =>
    entryOf(
      { id: `01JD${String(i).padStart(22, '0')}`, name: `${NAMES[i % NAMES.length]} ${i}`, kind: i === 0 ? 'assistant' : 'worker', state: i % 3 === 0 ? 'working' : 'idle', askedBy: i % 4 === 0 ? 'p' : null, createdAt: 1_000 + i },
      {
        address: `session:hub-1a2b3c4d/${MACHINES[i % 4] ? `m${i % 4}.` : ''}01JD${String(i).padStart(22, '0')}`,
        project: PROJECTS[i % PROJECTS.length] ?? null,
        machine: MACHINES[i % MACHINES.length] ?? null,
      },
    ),
  )
}

/** The answer to a query that every session matches, as the costliest one */
const answerFor = (n: number) => {
  const all = directory(n)
  const found = ranked(all, '')
  return findAnswer({ query: '', found, matched: found.length, total: all.length, away: [] })
}

/** The repository's token estimate (characters ÷ 4, docs/tool-cost.md) */
const tokens = (text: string) => Math.ceil(text.length / 4)

describe('finding the recipient (#2067 item 3)', () => {
  it('ranks by the words: the name above the project, the machine and the role; every word must match', () => {
    const all = directory(40)
    const byName = ranked(all, 'review')
    expect(byName.every((e) => e.name.toLowerCase().includes('review'))).toBe(true)
    // A word that matches the name outranks one that matches only the project
    const mixed = ranked(all, 'billing')
    expect(mixed[0]!.name).toMatch(/^Billing export/)
    // Two words narrow: a name word and a machine
    expect(ranked(all, 'review laptop').every((e) => e.machine === 'Laptop' && e.name.startsWith('PR review'))).toBe(true)
    expect(ranked(all, 'review nowhere')).toEqual([])
    // Among equal matches, a session at work comes first, then the most recent
    const equal = ranked(all, 'docs')
    expect(equal.findIndex((e) => !e.busy)).toBeGreaterThan(equal.findLastIndex((e) => e.busy))
    // The role is a word too
    expect(ranked(all, 'assistant').map((e) => e.role)).toEqual(['assistant'])
  })

  it('the exact name in any case is what `mail send` resolves, and two of it are both returned', () => {
    const all = [...directory(10), { ...directory(1)[0]!, address: 'session:hub-99999999/x', name: 'pr REVIEW 0' }]
    expect(named(all, 'PR review 0').map((e) => e.address)).toEqual([directory(1)[0]!.address, 'session:hub-99999999/x'])
    expect(named(all, 'PR review')).toEqual([])
  })

  it('caps the answer, says how many more, and names a computer that could not be searched', () => {
    const all = directory(30)
    const found = ranked(all, 'session')
    expect(found.length).toBeGreaterThan(FIND_LIMIT)
    const text = findAnswer({ query: 'session', found, matched: found.length, total: 30, away: [{ name: 'Build box', why: 'not reachable right now' }] })
    const lines = text.split('\n')
    expect(lines[0]).toBe(`${found.length} of 30 sessions match "session". Mail one by its address.`)
    expect(lines.filter((l) => l.startsWith('session:'))).toHaveLength(Math.min(FIND_LIMIT, found.length))
    expect(lines.at(-2)).toBe(`${found.length - FIND_LIMIT} more: add a word (a project, a machine or a role) to narrow it.`)
    expect(lines.at(-1)).toBe('Not searched: Build box (not reachable right now).')
    // Each line carries the exact address to mail
    expect(lines[1]).toMatch(/^session:hub-1a2b3c4d\/\S+ "/)
  })

  it('costs the same at 10, 50 and 200 sessions: a few hundred tokens', () => {
    const cost = [10, 50, 200].map((n) => ({ n, chars: answerFor(n).length, tokens: tokens(answerFor(n)) }))
    // The measurement in docs/plans/linked-mail.md §8
    expect(cost.map((c) => c.tokens).every((t) => t <= 300)).toBe(true)
    expect(cost[2]!.chars - cost[0]!.chars).toBeLessThan(80)
  })

  it('stays as small with the longest names and 30 computers that could not be searched (#2067 review)', () => {
    const long = (what: string, n: number) => `${what} `.repeat(n).slice(0, n)
    const all = directory(200).map((e, i) => ({ ...e, name: long(`${e.name} with a long name`, 120), project: long(`project ${i}`, 80), machine: e.machine === null ? null : long(`machine ${e.machine}`, 80) }))
    const away = Array.from({ length: 30 }, (_, i) => ({ name: long(`Computer ${i}`, 80), why: long('it runs an older Centralu; update it there', 160) }))
    const found = ranked(all, '')
    const text = findAnswer({ query: long('a query', 200), found, matched: found.length, total: all.length, away })
    const lines = text.split('\n')
    expect(lines.filter((l) => l.startsWith('Not searched'))).toHaveLength(4)
    expect(lines.at(-1)).toBe('Not searched either: 27 more computers.')
    // The measurement in docs/plans/linked-mail.md §8
    expect(text.length).toBeLessThanOrEqual(2_000)
    expect(tokens(text)).toBeLessThanOrEqual(500)
  })
})
