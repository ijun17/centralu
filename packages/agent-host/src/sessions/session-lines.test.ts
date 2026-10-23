import type { StoredMessage } from '@cc/protocol'
import { describe, expect, it } from 'vitest'
import { budgetOf, fitLines, fitMachineLines, sessionLines } from './session-lines.js'

const row = (seq: number, payload: Record<string, unknown>): StoredMessage => ({ sessionId: 's1', seq, role: 'user', kind: 'text', payload, ts: Date.UTC(2026, 9, 21, 9, 30) })

describe('a user line in read_session says who wrote it', () => {
  it('a script’s first message carries the script’s label, and is not the person’s (§8.1)', () => {
    const lines = sessionLines([row(1, { text: 'Triage the build', fromScript: { credential: 'ci runner' } }), row(2, { text: 'my own words' })])
    expect(lines[0]!.fields).toMatchObject({ role: 'user', fromScript: 'ci runner', text: 'Triage the build' })
    expect(lines[1]!.fields).not.toHaveProperty('fromScript')
    expect(lines[1]!.fields).not.toHaveProperty('from')
    // The marks of an app's and a session's message are as they were
    const others = sessionLines([row(3, { text: 'a', fromApp: { appId: 'x', projectId: null, name: 'Slider' } }), row(4, { text: 'b', from: { sessionId: 'w', name: 'Worker' } })])
    expect(others[0]!.fields).toMatchObject({ fromApp: 'Slider' })
    expect(others[1]!.fields).toMatchObject({ from: 'Worker' })
  })
})

describe('the budget of one read (#1480)', () => {
  const lines = (n: number, size: number) => sessionLines(Array.from({ length: n }, (_, i) => row(i + 1, { text: `${i + 1}`.padEnd(size, 'x') })))

  it('takes maxChars within 2,000 and 40,000, 12,000 when not given', () => {
    expect([budgetOf(undefined), budgetOf(5), budgetOf(3000.9), budgetOf(1e9)]).toEqual([12_000, 2000, 3000, 40_000])
  })

  it('shows the newest lines that fit, whole, and names the line that reads on', () => {
    const out = fitLines(lines(10, 1000), null, 3500)
    expect(out).toHaveLength(4)
    expect(JSON.parse(out[0]!).note).toContain('7 older lines of this read are not shown')
    expect(JSON.parse(out[0]!).note).toContain('around=7 reads on')
    expect(JSON.parse(out.at(-1)!).text.startsWith('10x')).toBe(true)
    // Everything fits: no note
    expect(fitLines(lines(3, 100), null, 3500)).toHaveLength(3)
  })

  it('always shows the newest line, even when it alone is past the budget', () => {
    const out = fitLines(lines(3, 2000), null, 2000)
    expect(out).toHaveLength(2)
    expect(JSON.parse(out[1]!).text.startsWith('3x')).toBe(true)
  })

  it('fills outward from the spot of a read around it, and notes both ends', () => {
    const out = fitLines(lines(20, 1000), 10, 4500)
    const texts = out.map((l) => JSON.parse(l) as { text?: string; note?: string })
    expect(texts[0]!.note).toContain('older lines')
    expect(texts.at(-1)!.note).toContain('newer lines')
    const shown = texts.filter((t) => t.text).map((t) => Number(t.text!.split('x')[0]))
    expect(shown).toContain(11)
    expect(shown.length).toBe(4)
    expect(shown).toEqual([...shown].sort((a, b) => a - b))
  })

  it('bounds the lines of a machine that did not, newest first, with a note that cannot name the read on', () => {
    const out = fitMachineLines(Array.from({ length: 10 }, (_, i) => `${i}`.padEnd(1000, 'x')), 3500)
    expect(out).toHaveLength(4)
    expect(JSON.parse(out[0]!).note).toContain('7 older lines of this read are not shown')
    expect(fitMachineLines(['a', 'b'], 3500)).toEqual(['a', 'b'])
  })
})
