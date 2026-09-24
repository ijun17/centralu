/**
 * diff 텍스트를 화면이 그리는 모양 그대로 쪼개는 곳.
 *
 * 컴포넌트에서 떼어낸 이유는 하나다 — **"지금 보고 있는 줄"은 계산이고, 계산은 재어 볼 수
 * 있어야 한다.** diff의 행 번호는 파일의 줄 번호가 아니다. `@@ -a,b +c,d @@`를 읽고,
 * 그 아래에서 새 파일에 실제로 남는 줄만 세어야 비로소 "IDE에서 여기"가 나온다.
 */

export type DiffRowKind = 'file' | 'add' | 'del' | 'hunk' | 'ctx'
export type DiffRow = { readonly kind: DiffRowKind; readonly marker: string; readonly body: string }

/** 지금 화면 맨 위가 diff의 어디인가 — 밴드에 쓸 이름과 IDE에 넘길 줄 번호 */
export type DiffPlace = {
  /** `diff --git`의 b/ 쪽 경로. 헤더 없는 단일 파일 diff면 null */
  readonly file: string | null
  /** 밴드에 그릴 이름. 이름이 바뀌었으면 `before → after` */
  readonly label: string | null
  /** 새 파일 기준 줄 번호. hunk 헤더를 못 찾았으면 undefined */
  readonly line?: number
}

export function toDiffRow(line: string): DiffRow {
  const kind: DiffRowKind = line.startsWith('diff --git ')
    ? 'file'
    : line.startsWith('+') && !line.startsWith('+++')
      ? 'add'
      : line.startsWith('-') && !line.startsWith('---')
        ? 'del'
        : line.startsWith('@@')
          ? 'hunk'
          : 'ctx'
  const marked = kind === 'add' || kind === 'del'
  // The clipboard gets the ASCII marker. The screen gets the typographic one, in GitPanel.
  return { kind, marker: marked ? line.charAt(0) : '', body: marked ? line.slice(1) : line }
}

export function renderableDiffRows(diff: string): readonly DiffRow[] {
  return diff.split('\n').map(toDiffRow)
}

export function diffFileLabel(line: string): string {
  const paths = diffFilePaths(line)
  if (!paths) return line
  return paths.before === paths.after ? paths.after : `${paths.before} → ${paths.after}`
}

function diffFilePaths(line: string): { before: string; after: string } | null {
  const m = /^diff --git a\/(.*) b\/(.*)$/.exec(line)
  if (!m) return null
  return { before: m[1] ?? '', after: m[2] ?? '' }
}

function hunkNewStart(body: string): number | null {
  const m = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(body)
  return m ? Number(m[1]) : null
}

/**
 * 새 파일에 남는 줄인가. `-`로 지워진 줄은 세지 않고, `\ No newline at end of file`은
 * git이 붙이는 주석이라 줄이 아니다 — 이걸 세면 hunk 하나마다 한 칸씩 어긋난다.
 */
function onNewSide(row: DiffRow): boolean {
  if (row.kind === 'add') return true
  return row.kind === 'ctx' && !row.body.startsWith('\\ ')
}

/**
 * `index`번 행이 어느 파일의 몇 번째 줄인가.
 *
 * 뒤로 한 번만 훑는다: 먼저 만나는 hunk 헤더가 줄 번호의 기준이고, 그보다 더 뒤에 있는
 * `diff --git`이 파일이다. 사이를 지나며 **새 파일에 남는 줄만** 센다.
 */
export function diffPlaceAt(rows: readonly DiffRow[], index: number): DiffPlace {
  if (rows.length === 0) return { file: null, label: null }
  const at = Math.min(Math.max(index, 0), rows.length - 1)
  let newSide = 0
  let line: number | undefined
  let hunkSeen = false
  for (let i = at; i >= 0; i--) {
    const row = rows[i]!
    if (row.kind === 'file') {
      return { file: diffFilePaths(row.body)?.after ?? null, label: diffFileLabel(row.body), line }
    }
    if (hunkSeen) continue
    if (row.kind === 'hunk') {
      hunkSeen = true
      const start = hunkNewStart(row.body)
      if (start !== null) line = start + newSide
    } else if (i !== at && onNewSide(row)) newSide++
  }
  return { file: null, label: null, line }
}
