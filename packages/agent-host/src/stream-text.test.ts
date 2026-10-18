import { describe, expect, it } from 'vitest'
import { LineTail, Tail, lineSplitter, withStderrTail } from './stream-text.js'

/** '실' is three bytes (EC 8B A4): a cut after the fourth byte is a cut inside '패' */
const korean = Buffer.from('실패: 한글', 'utf8')

describe('Tail', () => {
  it('keeps the last characters written, however much is written', () => {
    const t = new Tail(10)
    for (let i = 0; i < 1000; i++) t.push('0123456789')
    t.push('abc')
    expect(t.text).toBe('3456789abc')
    expect(t.text.length).toBe(10)
  })

  it('keeps everything while under the bound', () => {
    const t = new Tail(10)
    t.push('ab')
    t.push('cd')
    expect(t.text).toBe('abcd')
  })

  it('keeps a character whole when a chunk ends inside it', () => {
    const t = new Tail(100)
    t.push(korean.subarray(0, 4))
    t.push(korean.subarray(4))
    expect(t.text).toBe('실패: 한글')
  })
})

describe('lineSplitter', () => {
  function split(chunks: (Buffer | string)[], opts?: { maxLine?: number }) {
    const lines: string[] = []
    const s = lineSplitter((l) => lines.push(l), opts)
    for (const c of chunks) s.push(c)
    return { lines, s }
  }

  it('hands over each line without its newline, and a CRLF line without its carriage return', () => {
    const { lines, s } = split(['a\r\nb', '\nc\r', '\n', 'tail'])
    expect(lines).toEqual(['a', 'b', 'c'])
    s.flush()
    expect(lines).toEqual(['a', 'b', 'c', 'tail'])
    s.flush()
    expect(lines).toHaveLength(4)
  })

  it('keeps a character whole when a chunk ends inside it', () => {
    const line = Buffer.concat([korean, Buffer.from('\n')])
    expect(split([line.subarray(0, 4), line.subarray(4)]).lines).toEqual(['실패: 한글'])
  })

  it('hands over an unfinished line past maxLine, and has no bound without one', () => {
    expect(split(['x'.repeat(10), 'y'], { maxLine: 10 }).lines).toEqual(['x'.repeat(10) + 'y'])
    expect(split(['x'.repeat(100_000)]).lines).toEqual([])
  })

  it('lets `cut` keep the end of an unfinished line back for the next chunk', () => {
    const lines: string[] = []
    const s = lineSplitter((l) => lines.push(l), { maxLine: 10, cut: (p) => ({ line: p.slice(0, -3), keep: p.slice(-3) }) })
    s.push('abcdefghijkl')
    s.push('mn\n')
    expect(lines).toEqual(['abcdefghi', 'jklmn'])
  })
})

describe('LineTail', () => {
  it('keeps the last lines, each cut to its bound', () => {
    const t = new LineTail(2, 3)
    for (const l of ['one', 'two', 'three']) t.push(l)
    expect(t.snapshot()).toEqual(['two', 'thr…'])
    expect(t.text).toBe('two\nthr…')
  })
})

describe('withStderrTail', () => {
  it('adds what the process kept, and leaves a message that has it or a process that keeps none alone', () => {
    const proc = { stderrTail: () => '  boom\n' }
    expect(withStderrTail('exited', proc)).toBe('exited. stderr: boom')
    expect(withStderrTail('exited. stderr: x', proc)).toBe('exited. stderr: x')
    expect(withStderrTail('exited', {})).toBe('exited')
    expect(withStderrTail('exited', { stderrTail: () => '' })).toBe('exited')
  })
})
