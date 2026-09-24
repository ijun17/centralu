import { describe, expect, it } from 'vitest'
import { diffFileLabel, diffPlaceAt, renderableDiffRows, toDiffRow } from './diff.js'

/**
 * diff의 행 번호는 파일의 줄 번호가 아니다. 이 시험들이 지키는 건 그 환산 하나다 —
 * "Open in IDE"가 데려가는 자리가 지금 보고 있는 자리와 같아야 한다 (#122).
 */

const DIFF = [
  'diff --git a/src/one.ts b/src/one.ts', // 0
  'index 1111111..2222222 100644', //       1
  '--- a/src/one.ts', //                    2
  '+++ b/src/one.ts', //                    3
  '@@ -1,3 +1,3 @@', //                     4
  ' one', //                                5  → 새 파일 1
  '-two', //                                6  (새 파일에 없다)
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
  it('마커는 몸통에서 떼어 낸다 — 화면은 −를 그리고 클립보드는 -를 받아야 하니까', () => {
    expect(toDiffRow('+added')).toEqual({ kind: 'add', marker: '+', body: 'added' })
    expect(toDiffRow('-gone')).toEqual({ kind: 'del', marker: '-', body: 'gone' })
  })
  it('`---`/`+++` 파일 헤더는 부호가 아니다 — 대시를 떼면 경로가 망가진다', () => {
    expect(toDiffRow('--- a/src/one.ts')).toEqual({ kind: 'ctx', marker: '', body: '--- a/src/one.ts' })
    expect(toDiffRow('+++ b/src/one.ts')).toEqual({ kind: 'ctx', marker: '', body: '+++ b/src/one.ts' })
  })
})

describe('diffFileLabel', () => {
  it('이름이 그대로면 한 번만, 바뀌었으면 어디서 어디로인지 둘 다 적는다', () => {
    expect(diffFileLabel('diff --git a/src/one.ts b/src/one.ts')).toBe('src/one.ts')
    expect(diffFileLabel('diff --git a/old.md b/new.md')).toBe('old.md → new.md')
  })
})

describe('diffPlaceAt', () => {
  it('hunk 헤더 바로 아래 첫 줄이 헤더가 말한 그 줄이다', () => {
    expect(diffPlaceAt(rows, 5)).toEqual({ file: 'src/one.ts', label: 'src/one.ts', line: 1 })
    expect(diffPlaceAt(rows, 10)).toEqual({ file: 'src/one.ts', label: 'src/one.ts', line: 60 })
  })
  it('지워진 줄은 세지 않는다 — 새 파일에 없는 줄이 번호를 먹으면 전부 밀린다', () => {
    expect(diffPlaceAt(rows, 7).line).toBe(2) //  `+TWO`: 사이의 `-two`를 세면 3이 된다
    expect(diffPlaceAt(rows, 8).line).toBe(3)
    expect(diffPlaceAt(rows, 11).line).toBe(61)
    expect(diffPlaceAt(rows, 12).line).toBe(62)
  })
  it('hunk 헤더 자신에 서 있으면 그 hunk가 시작하는 줄이다', () => {
    expect(diffPlaceAt(rows, 9).line).toBe(60)
  })
  it('지워진 줄 위에 서 있으면 그 자리에 남는 새 줄을 가리킨다 — 열 곳은 있어야 한다', () => {
    expect(diffPlaceAt(rows, 6).line).toBe(2)
  })
  it('hunk보다 위(파일 헤더 구역)에는 줄 번호가 없다 — 1번 줄인 척하지 않는다', () => {
    expect(diffPlaceAt(rows, 0)).toEqual({ file: 'src/one.ts', label: 'src/one.ts', line: undefined })
    expect(diffPlaceAt(rows, 3).line).toBeUndefined()
  })
  it('다음 파일로 넘어가면 앞 파일의 줄 수를 끌고 가지 않는다', () => {
    expect(diffPlaceAt(rows, 15)).toEqual({ file: 'new.md', label: 'old.md → new.md', line: 1 })
  })
  it('이름이 바뀐 파일은 b/ 쪽을 연다 — a/ 쪽은 이제 없는 파일이다', () => {
    expect(diffPlaceAt(rows, 15).file).toBe('new.md')
  })
  it('`\\ No newline at end of file`은 줄이 아니다 — 세면 그 뒤가 한 칸씩 밀린다', () => {
    const noEol = renderableDiffRows(
      ['@@ -1,2 +1,2 @@', '+first', '\\ No newline at end of file', '+second'].join('\n'),
    )
    expect(diffPlaceAt(noEol, 3).line).toBe(2)
  })
  it('`diff --git` 없는 단일 파일 diff도 줄 번호는 낸다 — 파일은 부른 쪽이 안다', () => {
    const bare = renderableDiffRows(['@@ -1 +1 @@', '-old()', '+next()'].join('\n'))
    expect(diffPlaceAt(bare, 2)).toEqual({ file: null, label: null, line: 1 })
  })
  it('빈 diff와 범위를 벗어난 색인에서 터지지 않는다', () => {
    expect(diffPlaceAt([], 0)).toEqual({ file: null, label: null })
    expect(diffPlaceAt(rows, 9_999).file).toBe('new.md')
    expect(diffPlaceAt(rows, -3).line).toBeUndefined()
  })
})
