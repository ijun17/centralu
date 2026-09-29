import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { score, searchFiles } from './file-search.js'

/**
 * When someone types `@ses`, what they are usually looking for is `SessionView.tsx`.
 * **A match in the file name** has to rank above letters scattered across the path.
 */
describe('file fuzzy score', () => {
  const rank = (paths: string[], q: string) =>
    paths
      .map((p) => ({ p, s: score(p, q) }))
      .filter((x): x is { p: string; s: number } => x.s !== null)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.p)

  it('a file-name match ranks above a path match', () => {
    const out = rank(
      ['packages/session/core/util.ts', 'packages/ui/src/features/session/SessionView.tsx'],
      'session',
    )
    expect(out[0]).toBe('packages/ui/src/features/session/SessionView.tsx')
  })

  it('a match starting earlier in the name ranks higher', () => {
    const out = rank(['src/UserSession.ts', 'src/SessionView.tsx'], 'session')
    expect(out[0]).toBe('src/SessionView.tsx')
  })

  it('a shallower path ranks slightly higher (all else equal)', () => {
    const out = rank(['a/b/c/d/e/App.tsx', 'src/App.tsx'], 'app.tsx')
    expect(out[0]).toBe('src/App.tsx')
  })

  it('accepts scattered letters too (a subsequence)', () => {
    expect(score('src/SessionView.tsx', 'ssnvw')).not.toBeNull()
    expect(score('src/SessionView.tsx', 'zzz')).toBeNull()
  })

  it('an empty query lets everything through', () => {
    expect(score('anything.ts', '')).toBe(0)
  })
})

/**
 * A Korean name (#176). git's line-based output wrapped a Korean path as `"\355\225\234…"`, so
 * `@한글` found nothing, and in a folder that was not a repository, a name macOS returned as NFD
 * did not match an NFC query.
 */
describe('searchFiles — Korean file names', () => {
  const dirs: string[] = []
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'cc-search-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('finds a Korean file in the repository under its exact name', async () => {
    const d = tmp()
    execFileSync('git', ['init', '-q'], { cwd: d })
    writeFileSync(join(d, '한글파일.md'), '')
    writeFileSync(join(d, 'plain.md'), '')

    expect((await searchFiles(d, '한글')).map((h) => h.path)).toEqual(['한글파일.md'])
    expect((await searchFiles(d, '')).map((h) => h.path).sort()).toEqual(['plain.md', '한글파일.md'])
  })

  it('finds a name stored as NFD with an NFC query, in a folder that is not a repository', async () => {
    const d = tmp()
    writeFileSync(join(d, '회의록.md'.normalize('NFD')), '')

    expect((await searchFiles(d, '회의록'.normalize('NFC'))).map((h) => h.path)).toEqual(['회의록.md'.normalize('NFC')])
  })
})
