import { NO_PATH, type ApprovalDetail, type NormalizedEvent } from '@cc/protocol'

/**
 * A change to one file, as both adapters describe it for an approval card (#843): its path, a diff to read, and what
 * the change does to the file when the tool says (a new file, a delete, a move). Codex's `fileChange` items carry it
 * (`fileChangesOf`); Claude's Edit, Write and NotebookEdit calls are read into it (`claudeFileChange`).
 */
export type FileChange = { path: string; diff: string; change?: 'add' | 'update' | 'delete' | 'move'; movePath?: string }

const CHANGE_TOOL = { add: 'Create', update: 'Edit', delete: 'Delete', move: 'Move' } as const

/** The card's name (#2060), in RowApproval.tsx's words: change both */
export function fileChangeTool(changes: readonly FileChange[]): string {
  const kinds = new Set(changes.map((c) => c.change ?? 'update'))
  const [only] = kinds
  return kinds.size === 1 && only ? CHANGE_TOOL[only] : 'Edit'
}

/** How much of the diff an approval card carries, the same for both tools */
export const DIFF_PREVIEW_CHARS = 4000

/**
 * The card for one or more file changes. The card prints the path and then the preview, so a single file's
 * preview is its diff alone; with several files each diff is headed by its own path, or the hunks of two files
 * would read as one. `(no path)` when nothing names a file — an empty string looks like a card that failed to
 * draw rather than a request that did not say.
 */
export function fileEditDetail(changes: readonly FileChange[]): ApprovalDetail {
  const named = changes.filter((c) => c.path)
  const diff =
    named.length > 1
      ? named.map((c) => `${c.path}\n${c.diff}`).join('\n\n')
      : changes.map((c) => c.diff).filter(Boolean).join('\n')
  // One file's own kind of change (a delete, a move) is said on its card; several files are one card that opens
  const one = named.length === 1 ? named[0]! : null
  return {
    kind: 'file_edit',
    path: named[0]?.path || NO_PATH,
    diffPreview: diff.slice(0, DIFF_PREVIEW_CHARS),
    multi: named.length > 1,
    ...(one?.change ? { change: one.change } : {}),
    ...(one?.movePath ? { movePath: one.movePath } : {}),
  }
}

/** Text as diff lines, each prefixed with `-` or `+`; nothing for empty text */
export function diffLines(prefix: '-' | '+', text: string): string {
  if (!text) return ''
  return text
    .replace(/\n$/, '')
    .split('\n')
    .map((line) => `${prefix}${line}`)
    .join('\n')
}

/** Lines of the file around a change an ACP card keeps, so the change reads in place */
const DIFF_CONTEXT = 2

/**
 * A change given as the whole text before and after (an ACP `diff` content), as diff lines: what the two share at the
 * start and the end is trimmed to a few lines of context, so a change deep in a long file is still on the card. Old text
 * absent means a new file.
 */
export function lineDiff(oldText: string | null | undefined, newText: string | null | undefined): string {
  const lines = (t: string | null | undefined) => (t ? t.replace(/\n$/, '').split('\n') : [])
  const before = lines(oldText)
  const after = lines(newText)
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head++
  let tail = 0
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail++
  if (head + tail === before.length && head + tail === after.length) return ''
  const context = (from: number, to: number) => after.slice(from, to).map((l) => ` ${l}`)
  return [
    ...context(Math.max(0, head - DIFF_CONTEXT), head),
    ...before.slice(head, before.length - tail).map((l) => `-${l}`),
    ...after.slice(head, after.length - tail).map((l) => `+${l}`),
    ...context(after.length - tail, Math.min(after.length, after.length - tail + DIFF_CONTEXT)),
  ].join('\n')
}

/**
 * The paths a call changes, reported as `files_touched` only once the call went through (#843).
 *
 * Claude's paths are known when the call is made and Codex's when its item completes, but either way a file is
 * marked "edited by agent" (conflict detection and highlighting, FR-2, FR-5) only by a result that is ok: marking
 * it when the call is made would mark a file whose edit the person denied. A call whose result
 * never comes leaves nothing marked. Bounded: a session's calls are many, its open edits few.
 */
export class TouchedFiles {
  private readonly open = new Map<string, string[]>()

  constructor(private readonly sessionId: string) {}

  call(callId: string, paths: readonly string[]): void {
    if (!callId || paths.length === 0) return
    this.open.set(callId, [...paths])
    if (this.open.size > 256) this.open.delete(this.open.keys().next().value!)
  }

  /** The call's result came: the paths it changed, if it went through */
  result(callId: string, ok: boolean): NormalizedEvent[] {
    const paths = this.open.get(callId)
    if (!paths) return []
    this.open.delete(callId)
    return ok ? [{ type: 'files_touched', sessionId: this.sessionId, paths }] : []
  }
}
