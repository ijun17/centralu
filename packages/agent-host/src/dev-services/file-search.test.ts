import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { score, searchFiles } from './file-search.js'

/**
 * `@ses`라고 칠 때 사람이 찾는 건 대개 `SessionView.tsx`다.
 * 경로 여기저기 흩어진 글자보다 **파일 이름에서의 매치**가 위에 와야 한다.
 */
describe('파일 퍼지 점수', () => {
  const rank = (paths: string[], q: string) =>
    paths
      .map((p) => ({ p, s: score(p, q) }))
      .filter((x): x is { p: string; s: number } => x.s !== null)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.p)

  it('파일 이름 매치가 경로 매치보다 위다', () => {
    const out = rank(
      ['packages/session/core/util.ts', 'packages/ui/src/features/session/SessionView.tsx'],
      'session',
    )
    expect(out[0]).toBe('packages/ui/src/features/session/SessionView.tsx')
  })

  it('이름 앞에서 시작하는 쪽이 위다', () => {
    const out = rank(['src/UserSession.ts', 'src/SessionView.tsx'], 'session')
    expect(out[0]).toBe('src/SessionView.tsx')
  })

  it('얕은 경로가 살짝 위다 (같은 조건이면)', () => {
    const out = rank(['a/b/c/d/e/App.tsx', 'src/App.tsx'], 'app.tsx')
    expect(out[0]).toBe('src/App.tsx')
  })

  it('흩어진 글자도 받아준다 (부분 수열)', () => {
    expect(score('src/SessionView.tsx', 'ssnvw')).not.toBeNull()
    expect(score('src/SessionView.tsx', 'zzz')).toBeNull()
  })

  it('빈 질의는 전부 통과시킨다', () => {
    expect(score('anything.ts', '')).toBe(0)
  })
})

/**
 * 한글 이름 (#176). git의 줄 단위 출력은 한글 경로를 `"\355\225\234…"`로 감싸서 `@한글`이
 * 아무것도 못 찾았고, 저장소가 아닌 폴더에서는 macOS가 NFD로 돌려준 이름이 NFC 검색어와
 * 맞지 않았다.
 */
describe('searchFiles — 한글 파일 이름', () => {
  const dirs: string[] = []
  const tmp = () => {
    const d = mkdtempSync(join(tmpdir(), 'cc-search-'))
    dirs.push(d)
    return d
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  it('저장소 안의 한글 파일을 이름 그대로 찾는다', async () => {
    const d = tmp()
    execFileSync('git', ['init', '-q'], { cwd: d })
    writeFileSync(join(d, '한글파일.md'), '')
    writeFileSync(join(d, 'plain.md'), '')

    expect((await searchFiles(d, '한글')).map((h) => h.path)).toEqual(['한글파일.md'])
    expect((await searchFiles(d, '')).map((h) => h.path).sort()).toEqual(['plain.md', '한글파일.md'])
  })

  it('저장소가 아닌 폴더에서 NFD로 저장된 이름도 NFC 검색어로 찾는다', async () => {
    const d = tmp()
    writeFileSync(join(d, '회의록.md'.normalize('NFD')), '')

    expect((await searchFiles(d, '회의록'.normalize('NFC'))).map((h) => h.path)).toEqual(['회의록.md'.normalize('NFC')])
  })
})
