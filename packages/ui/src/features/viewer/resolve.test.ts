import { describe, expect, it } from 'vitest'
import { suffixMatches } from './resolve.js'

/**
 * A relative path an agent wrote → the real file inside the project (user's observation,
 * 2026-09-07). An actual case: `Media/ImageSearch.cs` ↔ `WzComparerR2.Cli/Media/ImageSearch.cs`.
 */
describe('suffixMatches', () => {
  const files = [
    'WzComparerR2.Cli/Media/ImageSearch.cs',
    'Tools/Media/ImageSearch.cs',
    'WzComparerR2.Common/OldMedia/ImageSearch.cs',
    'docs/README.md',
  ]

  it('matches a truncated-at-the-front path by its tail', () => {
    expect(suffixMatches(files, 'WzComparerR2.Cli/Media/ImageSearch.cs')).toEqual([
      'WzComparerR2.Cli/Media/ImageSearch.cs',
    ])
  })

  it('matches only at segment boundaries — OldMedia/ImageSearch.cs is not a candidate', () => {
    expect(suffixMatches(files, 'Media/ImageSearch.cs')).toEqual([
      'Tools/Media/ImageSearch.cs',
      'WzComparerR2.Cli/Media/ImageSearch.cs',
    ])
  })

  it('several stay several — shallowest first (picking is the person\'s job)', () => {
    const many = ['a/b/c/x.ts', 'a/x.ts', 'q/a/x.ts']
    expect(suffixMatches(many, 'x.ts')).toEqual(['a/x.ts', 'q/a/x.ts', 'a/b/c/x.ts'])
  })

  it('an exact match, if there is one, comes first', () => {
    expect(suffixMatches(['deep/nest/x.ts', 'x.ts'], 'x.ts')[0]).toBe('x.ts')
  })

  it('an empty value or an absolute path matches nothing — an empty tail would match every path', () => {
    expect(suffixMatches(files, '')).toEqual([])
    expect(suffixMatches(files, '/etc/passwd')).toEqual([])
  })

  it('none found means none — it does not make one up', () => {
    expect(suffixMatches(files, 'Media/Nope.cs')).toEqual([])
  })
})
