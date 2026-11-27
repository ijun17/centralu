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
 * takes POSIX wire paths, and a lone `\` is likelier prose (`\n`). Unicode letters/digits are allowed so
 * non-ASCII filenames inside the project link as cleanly as ASCII ones.
 */
const PATH_CHARS = /^[\p{L}\p{M}\p{N}._@+/-]+$/u

/** Starts with a letter, so `1.2.3` and `v0.1.0` are not files */
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,9}$/

const LOCATION = /^(.*?):(\d+)(?::\d+)?$/
const HASH_LINE = /^L(\d+)(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i
const HASH_LINE_SUFFIX = /#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/i
const COLON_LINE_SUFFIX = /:\d+(?::\d+)?$/
const SCHEME = /^[a-z][a-z0-9+.-]+:/i
const IMAGE_LINK_EXT = /\.(?:png|jpe?g|gif|webp)$/i

function hasControlChar(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

function tryDecode(href: string): string {
  try {
    return decodeURIComponent(href)
  } catch {
    return href
  }
}

/**
 * Strips a local `file:` scheme (`file:///…` or `file://localhost/…`); returns null for off-machine hosts
 * (`file://server/share`) and UNC spellings (`file:////server/share`, `file:///%2Fserver/share`).
 */
function stripLocalFileScheme(raw: string): string | null {
  if (!/^file:/i.test(raw)) return raw
  if (/^file:\/\/\/[A-Za-z]:(?:[\\/]|%5c)/i.test(raw)) return raw.slice('file:///'.length)
  if (/^file:\/\/localhost\//i.test(raw)) {
    const rest = raw.slice('file://localhost'.length)
    if (/^\/(?:[\\/]|%2f|%5c)/i.test(rest)) return null
    return /^\/[A-Za-z]:(?:[\\/]|%5c)/i.test(rest) ? rest.slice(1) : rest
  }
  if (/^file:\/\/\//i.test(raw)) {
    const rest = raw.slice('file://'.length)
    if (/^\/(?:[\\/]|%2f|%5c)/i.test(rest)) return null
    return rest
  }
  return null
}

function relativeToRoot(body: string, projectRoot: string): string | null {
  // Home paths, UNC/device paths, and drive-relative paths (`C:foo`) are never project-relative
  if (body === '~' || /^~[\\/]/.test(body)) return null
  if (body.startsWith('//') || body.startsWith('\\\\')) return null
  if (/^[A-Za-z]:(?![\\/])/.test(body)) return null
  const root = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const normalized = /^[A-Za-z]:[\\/]/.test(body) || projectRoot.includes('\\') ? body.replace(/\\/g, '/') : body
  let path = normalized
  if (path.startsWith('/')) {
    if (!path.startsWith(`${root}/`)) return null
    path = path.slice(root.length + 1)
  } else if (/^[A-Za-z]:\//.test(path)) {
    if (path.length <= root.length || path.slice(0, root.length + 1).toLowerCase() !== `${root.toLowerCase()}/`) {
      return null
    }
    path = path.slice(root.length + 1)
  }
  if (path.startsWith('./')) path = path.slice(2)
  if (!path) return null
  // A bare `.ts` or `.env` is mostly a file type in prose; `src/.gitignore` links
  if (!path.includes('/') && path.startsWith('.')) return null
  return path
}

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
    body = loc[1] ?? raw
    line = Number(loc[2]) || null
  }

  if (!PATH_CHARS.test(body)) return null
  if (!EXTENSION.test(body)) return null
  // `..` is relative to the file being discussed, which is unknown
  if (wireSegments(body).includes('..')) return null

  const path = relativeToRoot(body, projectRoot)
  return path ? { path, line } : null
}

/**
 * Parses an explicit Markdown link destination (`[label](href)`) pointing to a file inside `projectRoot`.
 * Unlike bare backticks (`parseFileRef`), an explicit link may carry `file://`, `#L10-L20` anchors, spaces,
 * and non-ASCII characters without risking false matches on prose.
 */
export function parseMarkdownFileRef(rawHref: string, projectRoot: string | null): FileRef | null {
  if (!projectRoot) return null
  const s = rawHref.trim()
  if (!s || s.startsWith('#') || s.startsWith('?') || s.startsWith('//') || s.startsWith('\\\\') || hasControlChar(s)) {
    return null
  }
  const isFileScheme = /^file:/i.test(s)
  if (SCHEME.test(s) && !isFileScheme) return null

  const hashAt = s.indexOf('#')
  const pathPart = hashAt >= 0 ? s.slice(0, hashAt) : s
  const fragment = hashAt >= 0 ? s.slice(hashAt + 1) : ''
  const unschemed = stripLocalFileScheme(pathPart)
  if (!unschemed) return null

  let body = tryDecode(unschemed)
  if (isFileScheme && /^\/[A-Za-z]:[\\/]/.test(body)) body = body.slice(1)
  if (hasControlChar(body) || body.startsWith('//') || body.startsWith('\\\\')) return null
  if (!isFileScheme && SCHEME.test(body)) return null

  let line: number | null = null
  const hashMatch = HASH_LINE.exec(fragment)
  if (hashMatch) line = Number(hashMatch[1]) || null

  if (line === null) {
    const loc = LOCATION.exec(body)
    if (loc) {
      body = loc[1] ?? body
      line = Number(loc[2]) || null
    }
  }

  if (!EXTENSION.test(body)) return null
  if (wireSegments(body.replace(/\\/g, '/')).includes('..')) return null

  const path = relativeToRoot(body, projectRoot)
  return path ? { path, line } : null
}

/**
 * The local path a Markdown link `[label](href)` names, or null when it is a web/mail URL, an unsafe scheme
 * (`javascript:`, `data:`), an off-machine `file://host/…` or UNC path, a fragment `#anchor`, or a bare word.
 * `file:` URLs are returned raw so `%23`/`%3F`/`%25`/`%2F` are never corrupted or double-decoded before `fileURLToPath`.
 */
export function localLinkPath(rawHref: string): string | null {
  const s = rawHref.trim()
  if (!s || s.startsWith('#') || s.startsWith('?') || s.startsWith('//') || s.startsWith('\\\\') || hasControlChar(s)) {
    return null
  }
  if (SCHEME.test(s)) {
    if (!/^file:/i.test(s)) return null
    const unschemed = stripLocalFileScheme(s)
    if (unschemed === null) return null
    const decodedCheck = tryDecode(unschemed)
    if (hasControlChar(decodedCheck) || decodedCheck.startsWith('//') || decodedCheck.startsWith('\\\\')) return null
    return s
  }
  const decoded = tryDecode(s)
  if (
    hasControlChar(decoded) ||
    decoded.startsWith('#') ||
    decoded.startsWith('?') ||
    decoded.startsWith('//') ||
    decoded.startsWith('\\\\') ||
    SCHEME.test(decoded)
  ) {
    return null
  }
  const bare = decoded.replace(HASH_LINE_SUFFIX, '').replace(COLON_LINE_SUFFIX, '')
  const hasNamedExt = EXTENSION.test(bare) && (bare.includes('/') || bare.includes('\\') || !bare.startsWith('.'))
  const looksLikePath =
    decoded.startsWith('/') ||
    decoded.startsWith('~/') ||
    decoded.startsWith('~\\') ||
    decoded.startsWith('./') ||
    decoded.startsWith('../') ||
    /^[A-Za-z]:[\\/]/.test(decoded) ||
    decoded.includes('/') ||
    hasNamedExt
  return looksLikePath ? decoded : null
}

/** Whether a local link path names a raster image format `messages.image` can preview in-app */
export function isImageLinkPath(written: string): boolean {
  const bare = (/^file:/i.test(written) ? written.replace(/#.*$/, '') : written.replace(HASH_LINE_SUFFIX, '')).replace(
    COLON_LINE_SUFFIX,
    '',
  )
  return IMAGE_LINK_EXT.test(bare)
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
