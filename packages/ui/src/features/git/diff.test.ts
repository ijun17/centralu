import { describe, expect, it } from 'vitest'
import { diffFileLabel, diffPlaceAt, renderableDiffRows, toDiffRow } from './diff.js'

/**
 * A diff's row number is not a file's line number. What these tests guard is exactly that
 * conversion — where "Open in IDE" takes the person has to match where they are currently
 * looking (#122).
 */

const DIFF = [
  'diff --git a/src/one.ts b/src/one.ts', // 0
  'index 1111111..2222222 100644', //       1
  '--- a/src/one.ts', //                    2
  '+++ b/src/one.ts', //                    3
  '@@ -1,3 +1,3 @@', //                     4
  ' one', //                                5  → new file line 1
  '-two', //                                6  (not in the new file)
  '+TWO', //                                7  → 2
  ' three', //                              8  → 3
  '@@ -40,2 +60,3 @@', //                   9
  ' forty', //                             10  → 60
  '+added', //                             11  → 61
  ' forty-two', //                         12  → 62
  'diff --git a/old.md b/new.md', //       13
  '@@ -1 +1 @@', //                        14
  '+renamed', //                           15  → 1
].join('\n')

const rows = renderableDiffRows(DIFF)

describe('toDiffRow', () => {
  it('the marker is split off from the body — the screen has to draw − while the clipboard gets -', () => {
    expect(toDiffRow('+added')).toEqual({ kind: 'add', marker: '+', body: 'added' })
    expect(toDiffRow('-gone')).toEqual({ kind: 'del', marker: '-', body: 'gone' })
  })
  it('`---`/`+++` file headers are not a sign — stripping the dashes would break the path', () => {
    expect(toDiffRow('--- a/src/one.ts')).toEqual({ kind: 'ctx', marker: '', body: '--- a/src/one.ts' })
    expect(toDiffRow('+++ b/src/one.ts')).toEqual({ kind: 'ctx', marker: '', body: '+++ b/src/one.ts' })
  })
})

describe('diffFileLabel', () => {
  it('once if the name stayed the same, both sides if it changed', () => {
    expect(diffFileLabel('diff --git a/src/one.ts b/src/one.ts')).toBe('src/one.ts')
    expect(diffFileLabel('diff --git a/old.md b/new.md')).toBe('old.md → new.md')
  })
})

describe('diffPlaceAt', () => {
  it('the first line right below a hunk header is the line the header named', () => {
    expect(diffPlaceAt(rows, 5)).toEqual({ file: 'src/one.ts', label: 'src/one.ts', line: 1 })
    expect(diffPlaceAt(rows, 10)).toEqual({ file: 'src/one.ts', label: 'src/one.ts', line: 60 })
  })
  it('a removed line is not counted — counting a line absent from the new file would shift everything after it', () => {
    expect(diffPlaceAt(rows, 7).line).toBe(2) //  `+TWO`: counting the `-two` in between would make it 3
    expect(diffPlaceAt(rows, 8).line).toBe(3)
    expect(diffPlaceAt(rows, 11).line).toBe(61)
    expect(diffPlaceAt(rows, 12).line).toBe(62)
  })
  it('standing on the hunk header itself gives the line that hunk starts at', () => {
    expect(diffPlaceAt(rows, 9).line).toBe(60)
  })
  it('standing above a removed line points at the new line that survives in its place — there has to be somewhere to open', () => {
    expect(diffPlaceAt(rows, 6).line).toBe(2)
  })
  it('above the hunk (the file header area) there is no line number — it does not pretend to be line 1', () => {
    expect(diffPlaceAt(rows, 0)).toEqual({ file: 'src/one.ts', label: 'src/one.ts', line: undefined })
    expect(diffPlaceAt(rows, 3).line).toBeUndefined()
  })
  it('crossing into the next file does not carry over the previous file line count', () => {
    expect(diffPlaceAt(rows, 15)).toEqual({ file: 'new.md', label: 'old.md → new.md', line: 1 })
  })
  it('a renamed file opens the b/ side — the a/ side is now a file that no longer exists', () => {
    expect(diffPlaceAt(rows, 15).file).toBe('new.md')
  })
  it('`\\ No newline at end of file` is not a line — counting it would shift everything after it by one', () => {
    const noEol = renderableDiffRows(
      ['@@ -1,2 +1,2 @@', '+first', '\\ No newline at end of file', '+second'].join('\n'),
    )
    expect(diffPlaceAt(noEol, 3).line).toBe(2)
  })
  it('a single-file diff with no `diff --git` still produces a line number — the file is known by the caller', () => {
    const bare = renderableDiffRows(['@@ -1 +1 @@', '-old()', '+next()'].join('\n'))
    expect(diffPlaceAt(bare, 2)).toEqual({ file: null, label: null, line: 1 })
  })
  it('does not blow up on an empty diff or an out-of-range index', () => {
    expect(diffPlaceAt([], 0)).toEqual({ file: null, label: null })
    expect(diffPlaceAt(rows, 9_999).file).toBe('new.md')
    expect(diffPlaceAt(rows, -3).line).toBeUndefined()
  })
})
