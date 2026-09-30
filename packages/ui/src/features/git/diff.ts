/**
 * Where a diff's text is split up exactly the way the screen draws it.
 *
 * Pulled out of the component for one reason — **"the line currently on screen" is a
 * computation, and a computation has to be measurable.** A diff's row number is not a file's
 * line number. Only after reading `@@ -a,b +c,d @@` and, below it, counting only the lines that
 * actually survive in the new file does "here, in the IDE" come out.
 */

export type DiffRowKind = 'file' | 'add' | 'del' | 'hunk' | 'ctx'
export type DiffRow = { readonly kind: DiffRowKind; readonly marker: string; readonly body: string }

/** Where the top of the screen currently is in the diff — the name for the band and the line number to hand to the IDE */
export type DiffPlace = {
  /** The b/ side path from `diff --git`. null for a single-file diff with no header */
  readonly file: string | null
  /** The name to draw in the band. `before → after` if the name changed */
  readonly label: string | null
  /** Line number in the new file. undefined if no hunk header was found */
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
 * Whether the row survives in the new file. A line removed with `-` is not counted, and
 * `\ No newline at end of file` is a note git attaches, not a line — counting it would throw
 * every hunk off by one.
 */
function onNewSide(row: DiffRow): boolean {
  if (row.kind === 'add') return true
  return row.kind === 'ctx' && !row.body.startsWith('\\ ')
}

/**
 * Which file, and which line of it, row `index` corresponds to.
 *
 * Scans backward exactly once: the first hunk header it meets is the base for the line number,
 * and the `diff --git` that comes further back is the file. While passing through, it counts
 * **only the lines that survive in the new file**.
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
