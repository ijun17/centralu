import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { baseName, importFile, listDir, moveEntry, resolveExisting, safeJoin } from './fs.js'

/**
 * 파일을 **바꾸는** 쪽의 검사 (#18, #19).
 *
 * 읽기에서 경로 검사를 빠뜨리면 남의 파일이 보인다. 쓰기에서 빠뜨리면 남의 파일이
 * **없어진다** — 그래서 여기 있는 것들은 편의 함수가 아니라 안전장치이고, 파일 시스템
 * 없이도 돌아가는 순수 함수로 떼어 둔 이유도 그것이다.
 *
 * 모든 실물 조작은 `mkdtemp`로 만든 임시 디렉토리 안에서만 일어난다. 이 파일이 다루는
 * 것이 '지우기'와 '옮기기'인 이상, 테스트가 그 밖으로 나가는 일은 없어야 한다.
 */

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-fs-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('safeJoin — 프로젝트 밖으로 나가지 않는다', () => {
  it('안쪽 경로는 그대로 붙는다', () => {
    expect(safeJoin(root, 'src/a.ts')).toBe(join(root, 'src/a.ts'))
  })

  it('빈 경로는 루트 자신이다 (트리의 첫 목록이 이걸로 온다)', () => {
    expect(safeJoin(root, '')).toBe(root)
  })

  it.each([
    ['../etc/passwd', '한 단계 위'],
    ['../../etc/passwd', '두 단계 위'],
    ['src/../../outside.txt', '들어갔다 나오기'],
    ['/etc/passwd', '절대 경로'],
  ])('%s 는 거절한다 (%s)', (rel) => {
    expect(() => safeJoin(root, rel)).toThrow(/outside the project/)
  })

  /**
   * 이름이 루트로 **시작만** 하는 형제 디렉토리는 안쪽이 아니다.
   *
   * `startsWith(root)`로만 검사하면 `/tmp/cc-fs-1` 프로젝트에서 `/tmp/cc-fs-12`가 통과한다.
   * 구분자까지 붙여 봐야 하는 이유이고, 문자열 검사로 경로를 판정할 때 가장 흔히 새는 자리다.
   */
  it('루트와 이름이 겹치는 옆 디렉토리는 안쪽이 아니다', () => {
    const sibling = `${root}-sibling`
    mkdirSync(sibling)
    try {
      expect(() => safeJoin(root, `../${sibling.split('/').pop()}/x.txt`)).toThrow(/outside the project/)
    } finally {
      rmSync(sibling, { recursive: true, force: true })
    }
  })
})

describe('baseName — 이름 자리에 경로가 들어오지 못한다', () => {
  it('마지막 조각만 남는다', () => {
    expect(baseName('src/app/a.ts')).toBe('a.ts')
    expect(baseName('a.ts')).toBe('a.ts')
  })

  it('올라가는 이름은 이름이 아니다', () => {
    expect(() => baseName('..')).toThrow(/Not a file name/)
    expect(() => baseName('')).toThrow(/Not a file name/)
    // `../../x` 처럼 생겼어도 이름 자리에서는 `x`가 된다 — 목적지 밖으로 못 나간다
    expect(baseName('../../x')).toBe('x')
  })
})

describe('moveEntry', () => {
  it('파일을 폴더로 옮긴다', async () => {
    writeFileSync(join(root, 'a.ts'), 'hello')
    mkdirSync(join(root, 'src'))
    const res = await moveEntry(root, 'a.ts', 'src')
    expect(res).toEqual({ path: 'src/a.ts', moved: true })
    expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe('hello')
    expect((await listDir(root, '')).map((e) => e.name)).toEqual(['src'])
  })

  it('폴더는 안에 든 것과 함께 간다', async () => {
    mkdirSync(join(root, 'pkg/sub'), { recursive: true })
    mkdirSync(join(root, 'dest'))
    writeFileSync(join(root, 'pkg/sub/deep.ts'), 'x')
    await moveEntry(root, 'pkg', 'dest')
    expect(readFileSync(join(root, 'dest/pkg/sub/deep.ts'), 'utf8')).toBe('x')
  })

  /**
   * **덮어쓰기는 없다.** 여기 있는 파일이 에이전트가 지금 고치고 있는 것인지 이쪽은 알 수
   * 없고, 조용히 갈아치우는 것은 되돌릴 방법이 하나도 없는 유일한 결과다.
   */
  it('자리가 차 있으면 옮기지 않고 무엇과 부딪혔는지 말한다', async () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'a.ts'), 'new')
    writeFileSync(join(root, 'src/a.ts'), 'old')
    await expect(moveEntry(root, 'a.ts', 'src')).rejects.toThrow('src/a.ts already exists')
    // 원본도 목적지도 그대로여야 한다 — 반쯤 옮겨진 상태가 가장 나쁘다
    expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe('old')
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('new')
  })

  it('제자리에 놓는 것은 실패가 아니라 moved:false다', async () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/a.ts'), 'x')
    expect(await moveEntry(root, 'src/a.ts', 'src')).toEqual({ path: 'src/a.ts', moved: false })
    expect(readFileSync(join(root, 'src/a.ts'), 'utf8')).toBe('x')
  })

  it('폴더를 자기 안으로는 못 넣는다', async () => {
    mkdirSync(join(root, 'pkg/sub'), { recursive: true })
    await expect(moveEntry(root, 'pkg', 'pkg/sub')).rejects.toThrow(/into itself/)
  })

  it('출발지가 프로젝트 밖이면 거절한다', async () => {
    await expect(moveEntry(root, '../outside.txt', '')).rejects.toThrow(/outside the project/)
  })

  it('목적지가 프로젝트 밖이면 거절한다', async () => {
    writeFileSync(join(root, 'a.ts'), 'x')
    await expect(moveEntry(root, 'a.ts', '../..')).rejects.toThrow(/outside the project/)
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('x')
  })

  it('프로젝트 자신은 못 옮긴다', async () => {
    mkdirSync(join(root, 'sub'))
    await expect(moveEntry(root, '', 'sub')).rejects.toThrow(/Cannot move the project itself/)
  })
})

describe('importFile — 밖에서 끌어온 파일', () => {
  it('폴더 안에 쓰고 새 경로를 돌려준다', async () => {
    mkdirSync(join(root, 'assets'))
    const res = await importFile(root, 'assets', 'shot.png', Buffer.from('bytes'))
    expect(res).toEqual({ path: 'assets/shot.png' })
    expect(readFileSync(join(root, 'assets/shot.png'), 'utf8')).toBe('bytes')
  })

  it('이름에 경로가 섞여 와도 목적지 밖으로 못 나간다', async () => {
    mkdirSync(join(root, 'assets'))
    const res = await importFile(root, 'assets', '../../evil.txt', Buffer.from('x'))
    expect(res.path).toBe('assets/evil.txt')
  })

  it('같은 이름이 이미 있으면 덮지 않는다', async () => {
    writeFileSync(join(root, 'shot.png'), 'original')
    await expect(importFile(root, '', 'shot.png', Buffer.from('new'))).rejects.toThrow(/already exists/)
    expect(readFileSync(join(root, 'shot.png'), 'utf8')).toBe('original')
  })

  it('목적지가 폴더가 아니면 거절한다', async () => {
    writeFileSync(join(root, 'a.ts'), 'x')
    await expect(importFile(root, 'a.ts', 'b.ts', Buffer.from('y'))).rejects.toThrow(/not a folder/)
  })

  it('목적지가 프로젝트 밖이면 거절한다', async () => {
    await expect(importFile(root, '..', 'evil.txt', Buffer.from('x'))).rejects.toThrow(/outside the project/)
  })
})

describe('resolveExisting — 셸에 넘길 절대 경로', () => {
  it('있는 파일의 절대 경로를 준다', async () => {
    writeFileSync(join(root, 'a.ts'), 'x')
    expect(await resolveExisting(root, 'a.ts')).toBe(join(root, 'a.ts'))
  })

  /** 없는 경로를 셸에 넘기면 아무 일도 일어나지 않는다 — 그 침묵을 여기서 막는다 */
  it('없는 파일은 거절한다', async () => {
    await expect(resolveExisting(root, 'gone.ts')).rejects.toThrow(/no longer there/)
  })

  it('프로젝트 밖은 거절한다 (휴지통이 남의 파일을 삼키지 않게)', async () => {
    await expect(resolveExisting(root, '../..')).rejects.toThrow(/outside the project/)
  })
})
