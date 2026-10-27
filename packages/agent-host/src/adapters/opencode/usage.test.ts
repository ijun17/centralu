import { describe, expect, it } from 'vitest'
import { STATS_RECORDED as RECORDED } from './recordings/stats.test-helpers.js'
import { openCodeUsageReader, parseAmount, parseCount, parseStats } from './usage.js'

describe('when the totals were read (asOf)', () => {
  it('stamps the totals with the time the read ended, and keeps that time while they are returned stale', async () => {
    let clock = 1_000
    const run = async () => {
      clock += 12_000
      return RECORDED
    }
    const ask = openCodeUsageReader(run, () => clock)
    const first = await ask({ settle: true })
    expect(first.totals?.asOf).toBe(13_000)
    clock += 5 * 60_000
    // Stale: the same totals come back at once with the time they were read, not the time they were asked
    const stale = await ask()
    expect(stale.totals?.asOf).toBe(13_000)
  })

  it('stamps nothing on output with no totals', async () => {
    const ask = openCodeUsageReader(async () => 'nothing here')
    expect(await ask({ settle: true })).toEqual({ plan: null })
  })

  it('stands on the totals a former run kept across a restart, with their own time', async () => {
    const never = new Promise<string>(() => {})
    const kept = parseStats(RECORDED)
    const seed = { ...kept, totals: { ...kept.totals!, asOf: 42 } }
    const ask = openCodeUsageReader(() => never)
    expect((await ask({ seed })).totals?.asOf).toBe(42)
  })
})

/** One table as `opencode stats` boxes it, with the two count rows written the way a computer's language writes them */
const table = (sessions: string, messages: string) =>
  [`│Sessions${sessions.padStart(40)} │`, `│Messages${messages.padStart(40)} │`, `│Input${'257.0K'.padStart(43)} │`, `│Total Cost${'$12.50'.padStart(38)} │`].join('\n')
const counts = (out: string) => {
  const rows = parseStats(out).totals?.rows ?? []
  return rows.filter((r) => r.unit === 'count').map((r) => r.value)
}

describe("OpenCode's usage: local totals from `opencode stats` (#1623)", () => {
  it('reads the recorded output into totals, labelled as all time', () => {
    expect(parseStats(RECORDED)).toEqual({
      plan: null,
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
    const labels = (parseStats(RECORDED).totals?.rows ?? []).map((r) => r.label)
    expect(labels.join(' ')).not.toMatch(/Avg|Median|Days|bash/)
  })

  it('finds a row by its label wherever the table puts it', () => {
    const out = ['│Total Cost                       $12.50 │', '│Sessions                      1,204 │', '│Input                           1.2M │'].join('\n')
    expect(parseStats(out).totals?.rows).toEqual([
      { id: 'sessions', label: 'Sessions', value: 1204, unit: 'count' },
      { id: 'input', label: 'Input', value: 1_200_000, unit: 'tokens' },
      { id: 'cost', label: 'Cost', value: 12.5, unit: 'usd' },
    ])
  })

  it('shows a row it printed in a form it cannot read as unread (null), never as a number, and does not take another row for it', () => {
    const out = ['│Output                      not a number │', '│Sessions per day                     3 │', '│Messages                          126 │'].join('\n')
    expect(parseStats(out).totals?.rows).toEqual([
      { id: 'messages', label: 'Messages', value: 126, unit: 'count' },
      { id: 'output', label: 'Output', value: null, unit: 'tokens' },
    ])
  })

  it('gives no totals, rather than a wrong one, for output it does not know', () => {
    expect(parseStats('')).toEqual({ plan: null })
    expect(parseStats('Error: database is locked').totals).toBeUndefined()
  })

  it('reads a token or cost amount with a suffix or a currency sign', () => {
    expect(parseAmount('257.0K')).toBe(257000)
    expect(parseAmount('$0.00')).toBe(0)
    expect(parseAmount('1,234')).toBe(1234)
    expect(parseAmount('2.5B')).toBe(2_500_000_000)
    expect(parseAmount('n/a')).toBeNull()
    expect(parseAmount('')).toBeNull()
  })
})

describe('the count rows, written in the language of the computer (RV1625)', () => {
  // What `toLocaleString()` writes for 1204 and 1204567 in each language; the digits can only be grouped, never a decimal
  const WRITTEN: [string, string, number][] = [
    ['en-US', '1,204', 1204],
    ['de-DE', '1.204', 1204],
    ['fr-FR', '1\u202f204', 1204],
    ['fr-FR (no-break space, older ICU)', '1\u00a0204', 1204],
    ['de-CH', '1’204', 1204],
    ["de-CH (apostrophe)", "1'204", 1204],
    ['ru-RU or a plain space', '1 204', 1204],
    ['ko-KR', '1,204', 1204],
    ['en-US', '1,204,567', 1204567],
    ['de-DE', '1.204.567', 1204567],
    ['fr-FR', '1\u202f204\u202f567', 1204567],
    ['de-CH', '1’204’567', 1204567],
    ['hi-IN (lakh grouping)', '12,04,567', 1204567],
    ['hi-IN (lakh grouping)', '1,20,400', 120400],
    ['any', '28', 28],
    ['any', '0', 0],
    ['any', '999', 999],
  ]
  for (const [locale, text, value] of WRITTEN) {
    it(`reads ${text} (${locale}) as ${value}`, () => {
      expect(parseCount(text)).toBe(value)
      expect(counts(table(text, text))).toEqual([value, value])
    })
  }

  // Not a grouped whole number: a decimal, a mix of separators, a group that is not three digits, a letter, another script
  for (const text of ['1.2', '1,2', '12.34', '1.204,5', '1,204.5', '1.204,567', '1,2045', '1 20 4', '1.20', '1204.567', '1,,204', ',204', '1,', '1e3', '١٢٠٤', '1 204 5', '12,3,456', '1,234,56', '']) {
    it(`does not read ${JSON.stringify(text)} as a number`, () => {
      expect(parseCount(text)).toBeNull()
    })
  }

  it('shows an unreadable count as unread in the table, and keeps the readable rows', () => {
    const rows = parseStats(table('1.204,5', '1.204')).totals?.rows ?? []
    expect(rows.find((r) => r.id === 'sessions')?.value).toBeNull()
    expect(rows.find((r) => r.id === 'messages')?.value).toBe(1204)
    expect(rows.find((r) => r.id === 'input')?.value).toBe(257000)
    expect(rows.find((r) => r.id === 'cost')?.value).toBe(12.5)
  })

  it("agrees with this computer's own languages where it has them", () => {
    for (const locale of ['en-US', 'de-DE', 'fr-FR', 'de-CH', 'ko-KR', 'hi-IN']) {
      for (const n of [7, 1204, 120400, 1204567]) {
        const text = n.toLocaleString(locale)
        // A runtime without the language's data writes it another way: nothing to say about it
        if (!/^[\d.,\u00a0\u202f '’]+$/.test(text)) continue
        expect(parseCount(text), `${locale} ${text}`).toBe(n)
      }
    }
  })
})
