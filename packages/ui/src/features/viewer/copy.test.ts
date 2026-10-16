import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LINE_END, TRUNCATED_NOTICE, buildCopyText, selectedText, wholeFileText, type CopyLine } from './copy.js'

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

/**
 * `selectedText` reads a DOM selection; these tests give it a stand-in for one: a pane of rows 20px tall from y=100 to
 * y=300 (10 rows showing, 0 to 9), with 12 lines in the file, and elements outside it that sit above, beside or below.
 * Every node has a place in the document (`at`), which is what `compareDocumentPosition` answers from: the sidebar and the
 * chat come before the pane, the header too, the evidence panel after it.
 */
describe('selectedText', () => {
  beforeEach(() => {
    vi.stubGlobal('Node', { TEXT_NODE: 3, DOCUMENT_POSITION_PRECEDING: 2, DOCUMENT_POSITION_FOLLOWING: 4 })
    // A text node is measured by a range over its own text; the stand-ins carry that box as `rect`
    vi.stubGlobal('document', {
      createRange: () => {
        let node: any
        return { selectNodeContents: (n: unknown) => (node = n), getBoundingClientRect: () => node.rect }
      },
    })
  })
  afterEach(() => vi.unstubAllGlobals())

  const lines: CopyLine[] = Array.from({ length: 12 }, (_, i) => ({ text: `line ${i}` }))
  const rect = (top: number, bottom: number, left = 0, right = 200) => ({ top, bottom, height: bottom - top, left, right, width: right - left })
  /** Gives a stand-in node its place in the document */
  const placed = <T extends object>(at: number, node: T): T & { at: number; compareDocumentPosition: (o: { at: number }) => number } =>
    Object.assign(node, { at, compareDocumentPosition: (o: { at: number }) => (o.at < at ? 2 : 4) })

  const rows = Array.from({ length: 12 }, (_, i) => {
    const code: any = {}
    const text: any = placed(100 + i, { nodeType: 3, parentElement: code, contains: () => false, rect: rect(100 + i * 20, 120 + i * 20, 300, 700) })
    const row: any = {
      dataset: { line: String(i) },
      getBoundingClientRect: () => rect(100 + i * 20, 120 + i * 20),
      querySelector: () => code,
    }
    code.closest = () => row
    code.contains = (n: unknown) => n === text
    return { row, text }
  })
  /** The element that holds the rows: inside the pane, on no row */
  const rowsBox = placed(99, { nodeType: 1, closest: () => null, contains: () => false, getBoundingClientRect: () => rect(100, 300, 300, 700) })
  const root: any = {
    getBoundingClientRect: () => rect(100, 300, 300, 700),
    querySelectorAll: () => rows.map((r) => r.row),
    contains: (n: unknown) => n === rowsBox || n === band || rows.some((r) => r.text === n),
  }

  /** A text node outside the pane, standing at the given vertical span */
  /** The text's own box, and (when it differs) the box of its parent element, which can be much taller */
  const outside = (at: number, top: number, bottom: number, left = 0, right = 200, parent = rect(top, bottom, left, right)): any =>
    placed(at, {
      nodeType: 3,
      contains: () => false,
      rect: rect(top, bottom, left, right),
      parentElement: { closest: () => null, getBoundingClientRect: () => parent },
    })
  /** An element as an end of a selection (an offset counts its children): a container beside the pane */
  const container = (at: number, top: number, bottom: number, left: number, right: number): any =>
    placed(at, { nodeType: 1, closest: () => null, contains: () => false, getBoundingClientRect: () => rect(top, bottom, left, right) })
  /** `body`: it holds the pane, and it is as big as the window */
  const body = placed(0, { nodeType: 1, closest: () => null, contains: () => true, getBoundingClientRect: () => rect(0, 800, 0, 1000) })
  /** The header (before the pane in the document) and the footer below it (after) */
  const above = outside(10, 20, 40)
  const below = outside(300, 400, 420)
  /** The chat next to the pane, before it in the document: in the lower half of the pane's height, but beside it */
  const beside = outside(20, 240, 260)
  /** The sidebar, before the pane, and the evidence panel, after it: both level with the pane */
  const sidebar = outside(5, 150, 170)
  const evidence = outside(400, 150, 170, 800, 1000)
  /** The diff's sticky file band: inside the pane, on no row, at its top */
  const band = placed(98, { nodeType: 1, closest: () => null, contains: () => false, getBoundingClientRect: () => rect(100, 124, 300, 700) })

  const select = (anchorNode: unknown, anchorOffset: number, focusNode: unknown, focusOffset: number, touched: number[], intersects = true) =>
    ({
      rangeCount: 1,
      isCollapsed: false,
      anchorNode,
      anchorOffset,
      focusNode,
      focusOffset,
      getRangeAt: () => ({ intersectsNode: () => intersects }),
      containsNode: (row: unknown) => touched.some((i) => rows[i]!.row === row),
    }) as unknown as Selection
  const copy = (selection: Selection, lastAnchor: { line: number; column: number } | null = null) =>
    selectedText({ selection, root, lines, lastAnchor })
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i)

  it('copies from the anchor to the focus when both are in rows', () => {
    expect(copy(select(rows[2]!.text, 0, rows[4]!.text, 6, range(2, 4)))).toBe('line 2\nline 3\nline 4')
  })

  it('copies the rows the selection touches when both ends are outside, never an empty string', () => {
    // A select-all of the page: the start above the pane, the end below it, the rows in the middle
    expect(copy(select(above, 0, below, 0, range(0, 11)))).toBe(lines.map((l) => l.text).join('\n'))
  })

  it('copies from the top of the touched rows for a drag from the chat beside the pane into row 5, not from row 5 down', () => {
    expect(copy(select(beside, 0, rows[5]!.text, 6, range(0, 5)))).toBe('line 0\nline 1\nline 2\nline 3\nline 4\nline 5')
  })

  it('copies the rows before the anchor for a drag from row 5 out to the chat before the pane', () => {
    expect(copy(select(rows[5]!.text, 0, beside, 0, range(0, 5)))).toBe('line 0\nline 1\nline 2\nline 3\nline 4\n')
  })

  it('copies from the first row to the anchor for a drag from row 5 col 3 left into the sidebar, not the tail of row 5', () => {
    expect(copy(select(rows[5]!.text, 3, sidebar, 0, range(0, 5)))).toBe('line 0\nline 1\nline 2\nline 3\nline 4\nlin')
  })

  it('copies from the focus to the last row for a drag from the evidence panel up into row 5 col 3, not just "lin"', () => {
    expect(copy(select(evidence, 0, rows[5]!.text, 3, range(5, 11)))).toBe(['e 5', ...range(6, 11).map((i) => `line ${i}`)].join('\n'))
  })

  it('copies down to the last touched row for a drag from row 5 out to the evidence panel', () => {
    expect(copy(select(rows[5]!.text, 0, evidence, 0, range(5, 11)))).toBe(range(5, 11).map((i) => `line ${i}`).join('\n'))
  })

  it('takes the first line showing for a reverse drag up over the diff\'s sticky band', () => {
    expect(copy(select(rows[8]!.text, 2, band, 0, range(0, 8)))).toBe([...range(0, 7).map((i) => `line ${i}`), 'li'].join('\n'))
  })

  it('stops at the last line showing for a drag from row 5 out below the pane', () => {
    expect(copy(select(rows[5]!.text, 0, below, 0, range(5, 11)))).toBe(range(5, 9).map((i) => `line ${i}`).join('\n'))
  })

  it('starts at the first line showing for a drag from row 5 out above the pane', () => {
    expect(copy(select(rows[5]!.text, 0, above, 0, range(0, 5)))).toBe('line 0\nline 1\nline 2\nline 3\nline 4\n')
  })

  it('reads the edge by where the text stands for text laid over the pane, even when it comes before the pane in the document', () => {
    // The composer's text across the pane's lower half: a drag from row 3 down to it ends at the last line showing
    const overlay = outside(50, 280, 300, 400, 500)
    expect(copy(select(rows[3]!.text, 0, overlay, 0, range(3, 11)))).toBe(range(3, 9).map((i) => `line ${i}`).join('\n'))
  })

  it('reads the edge by where the text stands when the selection touches no row at all (#424)', () => {
    const overlay = outside(50, 280, 300, 400, 500)
    expect(copy(select(rows[5]!.text, 0, overlay, 0, []))).toBe(range(5, 9).map((i) => `line ${i}`).join('\n'))
  })

  it('uses the remembered anchor when the anchor was walked out of the rows and the focus is in them', () => {
    expect(copy(select(above, 0, rows[6]!.text, 4, range(0, 6)), { line: 3, column: 0 })).toBe('line 3\nline 4\nline 5\nline')
  })

  it('uses the remembered anchor when the scrolling walked it onto the rows container, whatever the focus is on', () => {
    expect(copy(select(rowsBox, 0, below, 0, range(0, 11)), { line: 3, column: 0 })).toBe(range(3, 9).map((i) => `line ${i}`).join('\n'))
  })

  it('does not borrow the remembered anchor when the selection began outside the pane and ends outside it too', () => {
    expect(copy(select(above, 0, below, 0, range(0, 11)), { line: 3, column: 0 })).toBe(lines.map((l) => l.text).join('\n'))
  })

  it('copies the touched rows for a page-wide select-all, whatever anchor an earlier click in the pane left behind', () => {
    // A caret at row 7 col 2 was remembered; a click on a sidebar button leaves it; select-all runs from body to body
    expect(copy(select(body, 0, body, 3, range(0, 11)), { line: 7, column: 2 })).toBe(lines.map((l) => l.text).join('\n'))
  })

  it('reads an element end (a container beside the pane, with an offset) by the document order', () => {
    expect(copy(select(rows[5]!.text, 3, container(5, 150, 170, 0, 200), 2, range(0, 5)))).toBe('line 0\nline 1\nline 2\nline 3\nline 4\nlin')
    expect(copy(select(container(400, 150, 170, 800, 1000), 2, rows[5]!.text, 3, range(5, 11)))).toBe(['e 5', ...range(6, 11).map((i) => `line ${i}`)].join('\n'))
  })

  it('copies from the composer laid over the pane\'s lower half up into row 5 as the pane\'s bottom edge to row 5', () => {
    // The composer comes before the pane in the document, yet what is drawn over the lower half is the lower end
    const composer = outside(50, 280, 300, 400, 500)
    expect(copy(select(composer, 0, rows[5]!.text, 3, range(5, 11)))).toBe(['e 5', ...range(6, 9).map((i) => `line ${i}`)].join('\n'))
  })

  it('takes the top edge for text laid over the pane\'s upper half', () => {
    const banner = outside(50, 110, 130, 400, 500)
    expect(copy(select(rows[5]!.text, 0, banner, 0, range(0, 5)))).toBe('line 0\nline 1\nline 2\nline 3\nline 4\n')
  })

  it('counts a node that straddles the pane\'s edge as over the pane', () => {
    const half = outside(50, 280, 300, 250, 350)
    expect(copy(select(rows[3]!.text, 0, half, 0, range(3, 11)))).toBe(range(3, 9).map((i) => `line ${i}`).join('\n'))
  })

  it('measures text by its own line, not by a tall parent that straddles the pane\'s middle', () => {
    const tall = outside(50, 110, 130, 400, 500, rect(100, 420, 400, 500))
    expect(copy(select(rows[5]!.text, 0, tall, 0, range(0, 5)))).toBe('line 0\nline 1\nline 2\nline 3\nline 4\n')
  })

  it('does not read a node with no box (hidden, display: contents) as above the pane', () => {
    const hidden = container(400, 0, 0, 0, 0)
    // Beside nothing: the document order says it comes after, so the copy runs to the last touched row
    expect(copy(select(rows[5]!.text, 0, hidden, 0, range(5, 11)))).toBe(range(5, 11).map((i) => `line ${i}`).join('\n'))
  })

  it('leaves a selection that does not reach the pane to the browser', () => {
    expect(copy(select(above, 0, beside, 0, [], false), { line: 3, column: 0 })).toBeNull()
  })

  it('leaves a collapsed selection alone', () => {
    const sel = { ...select(rows[1]!.text, 2, rows[1]!.text, 2, [1]), isCollapsed: true } as unknown as Selection
    expect(copy(sel)).toBeNull()
  })
})
