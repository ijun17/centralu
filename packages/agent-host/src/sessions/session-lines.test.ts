import type { StoredMessage } from '@cc/protocol'
import { describe, expect, it } from 'vitest'
import { budgetOf, fitLines, fitMachineLines, lineCutOf, sessionLines } from './session-lines.js'

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
  const parsed = (out: string[]) => out.map((l) => JSON.parse(l) as { text?: string; note?: string; shown?: string })
  const total = (out: string[]) => out.reduce((sum, l) => sum + l.length + 1, 0)
  const numbers = (out: string[]) => parsed(out).filter((l) => l.text !== undefined).map((l) => Number(l.text!.split('x')[0]))

  it('takes maxChars within 2,000 and 40,000, 12,000 when not given', () => {
    expect([budgetOf(undefined), budgetOf(5), budgetOf(3000.9), budgetOf(1e9)]).toEqual([12_000, 2000, 3000, 40_000])
  })

  it('shows the newest lines that fit, notes counted, and the note names what is older than the oldest shown', () => {
    const out = fitLines(lines(10, 1000), 'back', 3500)
    expect(total(out)).toBeLessThanOrEqual(3500)
    expect(numbers(out)).toEqual([8, 9, 10])
    const note = parsed(out)[0]!.note!
    expect(note).toContain('7 older lines of this read are not shown')
    // Not around: that centres on a line and shows half of what was shown. `before` reads only what is older
    expect(note).toContain('before=8 reads on')
    expect(fitLines(lines(3, 100), 'back', 3500)).toHaveLength(3)
  })

  it('a read on from a note shows nothing twice, back to the start and forward to the end', () => {
    const all = lines(20, 1000)
    const shownBack: number[] = []
    let upto = all.length
    for (let i = 0; i < 20 && upto > 0; i++) {
      const out = fitLines(all.slice(0, upto), 'back', 3500)
      shownBack.unshift(...numbers(out))
      const note = parsed(out)[0]!.note
      upto = note === undefined || !parsed(out)[0]!.note!.includes('before=') ? 0 : Number(/before=(\d+)/.exec(note)![1]) - 1
    }
    expect(shownBack).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    const shownForward: number[] = []
    let at = 0
    for (let i = 0; i < 20 && at < all.length; i++) {
      const out = fitLines(all.slice(at), 'forward', 3500)
      shownForward.push(...numbers(out))
      const note = parsed(out).at(-1)!.note
      at = note === undefined ? all.length : Number(/from=(\d+)/.exec(note)![1]) - 1
    }
    expect(shownForward).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
  })

  it('always shows the first line, even when it alone is past the budget', () => {
    const out = fitLines(lines(3, 2000), 'back', 2000)
    expect(numbers(out)).toEqual([3])
  })

  it('fills outward from the spot of a read around it, and each end that is left out names its own read on', () => {
    const out = fitLines(lines(20, 1000), { around: 10 }, 4500)
    const texts = parsed(out)
    expect(total(out)).toBeLessThanOrEqual(4500)
    expect(numbers(out)).toContain(11)
    expect(numbers(out)).toEqual([...numbers(out)].sort((a, b) => a - b))
    const first = numbers(out)[0]!
    const last = numbers(out).at(-1)!
    expect(texts[0]!.note).toContain(`before=${first} `)
    expect(texts.at(-1)!.note).toContain(`from=${last + 1} `)
  })

  it('shows more of a long line as maxChars grows: 2,000 at the default, a sixth of the budget above, 8,000 at most', () => {
    expect([lineCutOf(2000), lineCutOf(12_000), lineCutOf(24_000), lineCutOf(40_000), lineCutOf(100_000)]).toEqual([2000, 2000, 4000, 6666, 8000])
    const one = lines(1, 20_000)
    expect(parsed(fitLines(one, 'back', 12_000))[0]!.shown).toBe('characters 0-2000 of 20000')
    expect(parsed(fitLines(one, 'back', 40_000))[0]!.shown).toBe('characters 0-6666 of 20000')
  })

  it('bounds the lines of a machine that did not, newest first, with a note that cannot name the read on', () => {
    const out = fitMachineLines(Array.from({ length: 10 }, (_, i) => `${i}`.padEnd(1000, 'x')), 3500, null)
    expect(total(out)).toBeLessThanOrEqual(3500)
    expect(out).toHaveLength(4)
    expect(JSON.parse(out[0]!).note).toContain('7 older lines of this read are not shown')
    expect(JSON.parse(out[0]!).note).toContain('recall')
    expect(fitMachineLines(['a', 'b'], 3500, null)).toEqual(['a', 'b'])
  })

  it('keeps the lines nearest the spot of a read around it from a machine that did not, and its own notes', () => {
    const body = Array.from({ length: 30 }, (_, i) => `${i}`.padEnd(1000, 'x'))
    const out = fitMachineLines(body, 4500, 15)
    expect(total(out)).toBeLessThanOrEqual(4500)
    const kept = out.filter((l) => !l.startsWith('{"note"')).map((l) => Number(l.split('x')[0]))
    expect(kept).toContain(15)
    expect(kept.every((n) => Math.abs(n - 15) <= 2)).toBe(true)
    // A machine's own notes at the ends stay and are counted
    const own = ['{"note":"older"}', ...body, '{"note":"newer"}']
    const bounded = fitMachineLines(own, 4500, 15)
    expect(bounded[0]).toBe('{"note":"older"}')
    expect(bounded.at(-1)).toBe('{"note":"newer"}')
    expect(total(bounded)).toBeLessThanOrEqual(4500)
  })
})

describe('tool calls left out of a read (#1480)', () => {
  const call = (seq: number): StoredMessage => ({ sessionId: 's1', seq, role: 'assistant', kind: 'tool_call', payload: { summary: { tool: 'Bash', title: 'echo' } }, ts: Date.UTC(2026, 9, 21, 9, 30) })
  const said = (seq: number, text: string): StoredMessage => ({ ...row(seq, { text }), role: 'assistant' })
  const turn = [said(1, 'section one'), call(2), said(3, 'section two'), call(4), said(5, 'the end of the turn')]

  it('keeps the texts a call separated as separate lines with "none", so the end of a turn is a line of its own', () => {
    const none = sessionLines(turn, { tools: 'none' })
    expect(none.map((l) => l.fields.text)).toEqual(['section one', 'section two', 'the end of the turn'])
    expect(none.map((l) => l.seq)).toEqual([1, 3, 5])
    // The lines "titles" shows, less the tool lines
    expect(sessionLines(turn, { tools: 'titles' }).filter((l) => l.fields.role !== 'tool').map((l) => l.fields.text)).toEqual(none.map((l) => l.fields.text))
    // Two texts with no call between them are still one line
    expect(sessionLines([said(1, 'a'), said(2, 'b')], { tools: 'none' })).toHaveLength(1)
  })
})
