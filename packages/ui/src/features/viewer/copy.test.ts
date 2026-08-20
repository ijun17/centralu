import { describe, expect, it } from 'vitest'
import { LINE_END, TRUNCATED_NOTICE, buildCopyText, wholeFileText, type CopyLine } from './copy.js'

const file = (n: number): CopyLine[] => Array.from({ length: n }, (_, i) => ({ text: `line ${i}` }))

describe('clipboard payload', () => {
  /**
   * The bug this closes. Only ~40 rows are ever mounted, so anything that reads the DOM
   * hands back a fragment of a selection this size. Line/column coordinates do not care.
   */
  it('spans rows the DOM never held', () => {
    const out = buildCopyText(file(3000), { line: 10, column: 0 }, { line: 2000, column: LINE_END })
    expect(out.split('\n')).toHaveLength(1991)
    expect(out.startsWith('line 10\nline 11')).toBe(true)
    expect(out.endsWith('line 1999\nline 2000')).toBe(true)
  })

  it('never carries a line number', () => {
    // The gutter is a sibling span in the same row; it is not in `lines` at all, so there
    // is nowhere for `12 const foo` to come from.
    const out = buildCopyText([{ text: 'const foo' }, { text: 'return bar' }], { line: 0, column: 0 }, { line: 1, column: LINE_END })
    expect(out).toBe('const foo\nreturn bar')
  })

  it('cuts the first and last line at the column', () => {
    const lines = [{ text: 'alpha' }, { text: 'bravo' }, { text: 'charlie' }]
    expect(buildCopyText(lines, { line: 0, column: 2 }, { line: 2, column: 5 })).toBe('pha\nbravo\ncharl')
  })

  it('slices within one line', () => {
    expect(buildCopyText([{ text: 'alpha' }], { line: 0, column: 1 }, { line: 0, column: 4 })).toBe('lph')
  })

  it('reads the same dragged upwards', () => {
    const lines = file(5)
    const down = buildCopyText(lines, { line: 1, column: 2 }, { line: 3, column: 3 })
    expect(buildCopyText(lines, { line: 3, column: 3 }, { line: 1, column: 2 })).toBe(down)
  })

  it('clamps carets that point outside the file', () => {
    // Columns arrive from DOM offsets and can outlive the row they were measured in.
    const lines = file(3)
    expect(buildCopyText(lines, { line: -4, column: -9 }, { line: 99, column: LINE_END })).toBe('line 0\nline 1\nline 2')
  })

  it('has nothing to say about an empty file', () => {
    expect(buildCopyText([], { line: 0, column: 0 }, { line: 0, column: LINE_END })).toBe('')
  })

  describe('a diff row keeps its marker', () => {
    // The marker is drawn in its own span, as a typographic − no patch tool accepts, so the
    // clipboard gets the ASCII one from the data instead of whatever the screen shows.
    const diff: CopyLine[] = [
      { text: '@@ -1,2 +1,2 @@' },
      { text: ' keep', prefix: '' },
      { text: 'gone', prefix: '-' },
      { text: 'added', prefix: '+' },
    ]

    it('when the line is taken whole', () => {
      expect(buildCopyText(diff, { line: 0, column: 0 }, { line: 3, column: LINE_END })).toBe(
        '@@ -1,2 +1,2 @@\n keep\n-gone\n+added',
      )
    })

    it('but not when the selection starts mid-line — the marker was not highlighted either', () => {
      expect(buildCopyText(diff, { line: 2, column: 1 }, { line: 3, column: LINE_END })).toBe('one\n+added')
    })
  })
})

describe('select-all payload', () => {
  it('is the file itself', () => {
    expect(wholeFileText('a\nb\n', false)).toBe('a\nb\n')
  })

  /**
   * ⌘A over a partly-read file claims more than the viewer has. Rather than hand over half
   * a file that looks whole, the clipboard carries the same sentence the screen does.
   */
  it('says so when the viewer only holds part of the file', () => {
    expect(wholeFileText('a\nb', true)).toBe(`a\nb\n${TRUNCATED_NOTICE}`)
  })
})
