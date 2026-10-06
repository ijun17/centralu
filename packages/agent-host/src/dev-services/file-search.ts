import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { wireJoin } from '@cc/protocol'
import { runGit, type GitTrust } from './git-exec.js'

/**
 * File search for `@` autocomplete.
 *
 * **Why this is built ourselves:** the Claude SDK does not expose file suggestions through a
 * public API, and Codex's fuzzyFileSearch requires launching app-server — launching a process on
 * every keystroke cannot serve a responsive typing experience. Worse, if each tool gave different
 * results, the same project would show different files depending on the session, which is more
 * confusing still. So one implementation is used for both.
 *
 * The list comes from git (`ls-files`) — it follows .gitignore as-is, so node_modules and build
 * output never mix in. When this is not a repository, a shallow walk is used instead.
 */

/** The maximum number of files held at once. A larger repository only sees the first portion */
const MAX_FILES = 20_000
/** How long before the list is read again. It is not reread while someone is still typing */
const TTL_MS = 15_000
/** The maximum depth to walk when this is not a repository */
const WALK_DEPTH = 6

type Index = { files: string[]; at: number }
const cache = new Map<string, Index>()

/** Drops the index on a test or a project change */
export function invalidateFileIndex(root?: string): void {
  if (root) cache.delete(root)
  else cache.clear()
}

/** How many roots have an index held (tests) */
export function heldFileIndexes(): number {
  return cache.size
}

async function gitFiles(root: string, trust: GitTrust): Promise<string[] | null> {
  try {
    /*
     * Tracked files plus new files that are not ignored = everything a person might want to open.
     * Read with `-z` (#176): line-based output, depending on `core.quotePath`, wrapped a Korean
     * name as `"\355\225\234…"`, so `@한글` found nothing, and whatever path it did pick turned out
     * to be a file that did not exist. `-z` splits names with NUL, with no quoting at all.
     * Before trust it runs none of the repository's programs (`core.fsmonitor` ran here, #407).
     */
    const stdout = await runGit(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      allowRepoPrograms: trust.trusted === true,
    })
    const files = stdout.split('\0').filter(Boolean)
    return files.length > 0 ? files.slice(0, MAX_FILES) : null
  } catch {
    return null
  }
}

/** The fallback for when this is not a repository. Only the common noisy directories are skipped */
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', 'target', '.next', '.venv', '__pycache__'])

/**
 * The relative path is built as a wire path (`/`) while walking, not taken from `relative()`,
 * which answers in the OS's separator: on Windows the walk returned `src\a.ts`, against the rule
 * that relative paths on the wire are POSIX (docs/protocol.md), and `score()` and the result's
 * name, which cut at `/`, took the whole path for the name (#14).
 */
async function walk(root: string): Promise<string[]> {
  const out: string[] = []
  const queue: { dir: string; rel: string; depth: number }[] = [{ dir: root, rel: '', depth: 0 }]
  while (queue.length > 0 && out.length < MAX_FILES) {
    const { dir, rel, depth } = queue.shift()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.env') continue
      if (e.isDirectory()) {
        if (SKIP.has(e.name) || depth >= WALK_DEPTH) continue
        queue.push({ dir: join(dir, e.name), rel: wireJoin(rel, e.name), depth: depth + 1 })
      } else {
        // The macOS filesystem sometimes returns a Korean name as NFD (decomposed jamo). What an
        // IME actually types is NFC, so a substring comparison would not match (#176). A git
        // repository does not have this problem, because git itself returns NFC
        // (`core.precomposeUnicode`) — so the walk normalizes to the same shape too.
        out.push(wireJoin(rel, e.name).normalize('NFC'))
        if (out.length >= MAX_FILES) break
      }
    }
  }
  return out
}

async function indexOf(root: string, trust: GitTrust): Promise<string[]> {
  const now = Date.now()
  const hit = cache.get(root)
  if (hit && now - hit.at < TTL_MS) return hit.files
  // A stale index is never read again, so it is swept here rather than kept until the same root is searched (#392)
  for (const [r, index] of cache) if (now - index.at >= TTL_MS) cache.delete(r)
  const files = (await gitFiles(root, trust)) ?? (await walk(root))
  cache.set(root, { files, at: Date.now() })
  return files
}

export type FileHit = { path: string; name: string }

/**
 * The fuzzy match score. Higher ranks higher. null if there is no match.
 *
 * When a person types `@ses`, what they are usually looking for is `SessionView.tsx`, not letters
 * scattered across a path like `packages/…/s…e…s`. So **a match in the file name is scored far
 * higher than a match in the path.**
 */
export function score(path: string, query: string): number | null {
  if (!query) return 0
  const lowerPath = path.toLowerCase()
  const q = query.toLowerCase()
  const name = path.slice(path.lastIndexOf('/') + 1)
  const lowerName = name.toLowerCase()

  // 1) An exact substring in the name scores highest. The earlier it starts, the higher
  const inName = lowerName.indexOf(q)
  if (inName >= 0) return 1000 - inName * 10 - depthPenalty(path)

  // 2) An exact substring anywhere in the path scores next
  const inPath = lowerPath.indexOf(q)
  if (inPath >= 0) return 600 - Math.min(inPath, 40) - depthPenalty(path)

  // 3) Accepted even scattered across the name (a subsequence) — the more contiguous, the higher
  const sub = subsequenceScore(lowerName, q)
  if (sub !== null) return 400 + sub - depthPenalty(path)

  const subPath = subsequenceScore(lowerPath, q)
  if (subPath !== null) return 100 + subPath - depthPenalty(path)

  return null
}

/** A deeper path is nudged back slightly — the shallower one is usually what was being looked for */
function depthPenalty(path: string): number {
  let slashes = 0
  for (const c of path) if (c === '/') slashes++
  return Math.min(slashes * 2, 30)
}

function subsequenceScore(haystack: string, needle: string): number | null {
  let hi = 0
  let streak = 0
  let best = 0
  for (const ch of needle) {
    const found = haystack.indexOf(ch, hi)
    if (found === -1) return null
    streak = found === hi ? streak + 1 : 1
    best += streak
    hi = found + 1
  }
  return Math.min(best * 4, 150)
}

export async function searchFiles(root: string, query: string, limit = 20, trust: GitTrust = {}): Promise<FileHit[]> {
  const files = await indexOf(root, trust)
  // The list is kept normalized to NFC — the query also has to be the same shape for Korean to compare correctly (#176)
  const q = query.trim().normalize('NFC')

  // An empty query cannot give a sense of "recent," so the shallowest results are shown first
  const scored: { path: string; s: number }[] = []
  for (const path of files) {
    const s = score(path, q)
    if (s !== null) scored.push({ path, s })
  }
  scored.sort((a, b) => (b.s === a.s ? a.path.length - b.path.length : b.s - a.s))
  return scored.slice(0, limit).map(({ path }) => ({ path, name: path.slice(path.lastIndexOf('/') + 1) }))
}
