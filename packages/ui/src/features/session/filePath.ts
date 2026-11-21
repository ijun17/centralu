/**
 * Which backticked words of an agent are files the person can open (#39): only inline code, no whitespace (which
 * keeps fences out), an extension (the viewer opens no directory; `Makefile` loses), inside the project. No
 * existence check, an RPC per span per render: a wrong guess says so in the viewer (`viewer-error`).
 */

import { wireSegments } from '@cc/protocol/client'

export type FileRef = {
  /** Project-relative, as `openFile` wants it */
  path: string
  line: number | null
}

/**
 * No `:` (rules out `https://…` and `node:fs/promises` once `:line` is off). No `\` (#47): `openFile`
 * takes POSIX wire paths, and a lone `\` is likelier prose (`\n`).
 */
const PATH_CHARS = /^[A-Za-z0-9._@+/-]+$/

/** Starts with a letter, so `1.2.3` and `v0.1.0` are not files */
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/

const LOCATION = /^(.*?):(\d+)(?::\d+)?$/

/**
 * A null `projectRoot` (the Assistant) links nothing: a root guessed from the selected project
 * would open another repository's file of the same name.
 */
export function parseFileRef(raw: string, projectRoot: string | null): FileRef | null {
  if (!projectRoot) return null

  let body = raw
  let line: number | null = null
  const loc = LOCATION.exec(raw)
  if (loc) {
    body = loc[1]!
    line = Number(loc[2]) || null
  }

  if (!PATH_CHARS.test(body)) return null
  if (!EXTENSION.test(body)) return null
  // `..` is relative to the file being discussed, which is unknown
  if (wireSegments(body).includes('..')) return null

  const root = projectRoot.replace(/\/+$/, '')
  let path = body
  if (path.startsWith('/')) {
    if (!path.startsWith(`${root}/`)) return null
    path = path.slice(root.length + 1)
  }
  if (path.startsWith('./')) path = path.slice(2)
  if (!path) return null

  // A bare `.ts` or `.env` is mostly a file type in prose; `src/.gitignore` links
  if (!path.includes('/') && path.startsWith('.')) return null

  return { path, line }
}

export type TitlePiece = { text: string; ref?: FileRef }

/**
 * A tool card's title cut at the files the call named (`ToolSummary.paths`), linked by `parseFileRef`'s
 * rule as a reply's are; the pieces always join back to the title.
 */
export function titlePieces(title: string, paths: readonly string[] | undefined, projectRoot: string | null): TitlePiece[] {
  const found: { at: number; end: number; ref: FileRef }[] = []
  for (const p of paths ?? []) {
    const ref = parseFileRef(p, projectRoot)
    if (!ref) continue
    // After the previous one, so pieces never overlap
    const from = found.length > 0 ? found[found.length - 1]!.end : 0
    const at = title.indexOf(p, from)
    if (at < 0) continue
    found.push({ at, end: at + p.length, ref })
  }
  const pieces: TitlePiece[] = []
  let cursor = 0
  for (const f of found) {
    if (f.at > cursor) pieces.push({ text: title.slice(cursor, f.at) })
    pieces.push({ text: title.slice(f.at, f.end), ref: f.ref })
    cursor = f.end
  }
  if (cursor < title.length || pieces.length === 0) pieces.push({ text: title.slice(cursor) })
  return pieces
}
