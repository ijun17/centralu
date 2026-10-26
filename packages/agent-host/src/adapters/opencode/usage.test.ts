import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseAmount, parseStats } from './usage.js'

/** The real output of `opencode stats` (1.19.4, Windows): boxed tables, no JSON form */
const RECORDED = readFileSync(join(import.meta.dirname, 'recordings', 'stats.txt'), 'utf8')

describe("OpenCode's usage: local totals from `opencode stats` (#1623)", () => {
  it('reads the recorded output into totals, labelled as all time, and says the tool has no limits', () => {
    expect(parseStats(RECORDED)).toEqual({
      plan: null,
      windows: [],
      daily: [],
      noLimits: true,
      totals: {
        scope: 'all time',
        rows: [
          { id: 'sessions', label: 'Sessions', value: 28, unit: 'count' },
          { id: 'messages', label: 'Messages', value: 126, unit: 'count' },
          { id: 'input', label: 'Input', value: 257000, unit: 'tokens' },
          { id: 'output', label: 'Output', value: 2800, unit: 'tokens' },
          { id: 'cache-read', label: 'Cache read', value: 462700, unit: 'tokens' },
          { id: 'cache-write', label: 'Cache write', value: 0, unit: 'tokens' },
          { id: 'cost', label: 'Cost', value: 0, unit: 'usd' },
        ],
      },
    })
  })

  it('leaves the averages and the tool counts out: they are not what was used', () => {
    const labels = parseStats(RECORDED).totals!.rows.map((r) => r.label)
    expect(labels.join(' ')).not.toMatch(/Avg|Median|Days|bash/)
  })

  it('finds a row by its label wherever the table puts it, and keeps what is a number', () => {
    const table = ['│Total Cost                       $12.50 │', '│Sessions                      1,204 │', '│Input                           1.2M │', '│Output                      not a number │'].join('\n')
    expect(parseStats(table).totals!.rows).toEqual([
      { id: 'sessions', label: 'Sessions', value: 1204, unit: 'count' },
      { id: 'input', label: 'Input', value: 1_200_000, unit: 'tokens' },
      { id: 'cost', label: 'Cost', value: 12.5, unit: 'usd' },
    ])
  })

  it('gives no totals, rather than a wrong one, for output it does not know', () => {
    expect(parseStats('')).toEqual({ plan: null, windows: [], daily: [], noLimits: true })
    expect(parseStats('Error: database is locked').totals).toBeUndefined()
  })

  it('reads an amount with a suffix, a currency sign or a thousands comma', () => {
    expect(parseAmount('257.0K')).toBe(257000)
    expect(parseAmount('$0.00')).toBe(0)
    expect(parseAmount('1,234')).toBe(1234)
    expect(parseAmount('2.5B')).toBe(2_500_000_000)
    expect(parseAmount('n/a')).toBeNull()
    expect(parseAmount('')).toBeNull()
  })
})
