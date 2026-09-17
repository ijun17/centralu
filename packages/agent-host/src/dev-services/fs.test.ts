import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { baseName, importFile, listDir, moveEntry, readTextFile, resolveExisting, safeJoin } from './fs.js'

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
const extraDirs: string[] = []

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-fs-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  for (const d of extraDirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function outsideDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'cc-fs-outside-'))
  extraDirs.push(d)
  return d
}

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

  /**
   * Which characters are separators has two answers, and this asserts the one this machine can
   * see (#47). The wire is POSIX, so `/` is settled by the protocol; `\` is settled by the
   * platform, and here it is an ordinary character in a file name — so a file really called
   * `a\b.txt` keeps its name and can still be moved.
   *
   * The other half cannot be run from here: on Windows `basename` reads that same string as a
   * path, and `baseName` refuses it rather than quietly moving the file to `b.txt`. What is
   * checkable on every platform is the invariant behind both answers — whatever comes back is
   * never something this machine would read as a path.
   */
  it('구분자 판정은 플랫폼에게 묻는다 — 여기서 `\\`는 이름의 일부다', () => {
    expect(baseName('src/a\\b.txt')).toBe('a\\b.txt')
    for (const input of ['src/app/a.ts', 'a\\b.txt', '../../.ssh/authorized_keys', 'x.md']) {
      let name: string
      try {
        name = baseName(input)
      } catch {
        continue // 거절도 맞는 답이다 (Windows에서 두 번째가 그렇다)
      }
      expect(name).not.toContain(sep)
    }
  })
})

describe('listDir — 저장소가 아닌 프로젝트', () => {
  /**
   * 프로젝트는 git 저장소가 아니어도 된다 — 시작 안내가 그렇게 적어 놓았다.
   *
   * 저장소가 아니면 `git check-ignore`는 아무것도 읽지 않고 바로 죽고, 우리가 쓰던 목록은
   * 닫힌 파이프에 떨어진다(EPIPE). 답 자체는 문제가 없다(무시된 파일은 없다). 문제는 그
   * EPIPE를 아무도 안 듣고 있으면 **호스트 프로세스가 통째로 죽는다**는 것 — 그 안에 든
   * 세션 전부와 함께.
   *
   * 목록이 파이프 버퍼(실측 65,536바이트)를 넘겨야 확실히 재현된다. 그 아래에서는 우리
   * 쓰기가 git이 사라지기 전에 끝나서 그냥 지나가고, 그래서 이 버그가 몇 주를 살아남았다.
   * CI의 리눅스 러너 둘은 훨씬 작은 크기에서 타이밍만으로 걸렸다.
   */
  it('파일이 많아도 목록이 나온다 — git이 먼저 죽어도 호스트는 산다', async () => {
    const long = 'n'.repeat(200)
    const names = Array.from({ length: 400 }, (_, i) => `${String(i).padStart(4, '0')}-${long}.txt`)
    // 400 × 206바이트 ≈ 82KB — 버퍼를 확실히 넘긴다
    expect(names.join('\n').length).toBeGreaterThan(65_536)
    for (const n of names) writeFileSync(join(root, n), '')

    const entries = await listDir(root, '')
    expect(entries).toHaveLength(names.length)
    // 저장소가 아니니 무시되는 것도 없다 — 못 물어봤다고 전부 무시로 칠하면 트리가 빈다
    expect(entries.every((e) => !e.ignored)).toBe(true)
  })
})

describe('readTextFile — 이미지 미리보기', () => {
  it('지원하는 래스터 이미지는 텍스트가 아니라 MIME·base64로 돌려준다', async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    writeFileSync(join(root, 'logo.png'), bytes)

    await expect(readTextFile(root, 'logo.png')).resolves.toEqual({
      text: '',
      truncated: false,
      binary: true,
      bytes: 4,
      image: { mime: 'image/png', data: bytes.toString('base64') },
    })
  })

  it('SVG는 그림 미리보기와 텍스트 읽기를 함께 돌려준다', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
    writeFileSync(join(root, 'logo.svg'), svg)

    await expect(readTextFile(root, 'logo.svg')).resolves.toEqual({
      text: svg,
      truncated: false,
      binary: false,
      bytes: Buffer.byteLength(svg),
      image: { mime: 'image/svg+xml', data: Buffer.from(svg).toString('base64') },
    })
  })

  it('프로젝트 이미지는 상한을 넘기면 바이트를 전송하지 않고 이유를 말한다', async () => {
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(root, 'large.png'), Buffer.alloc(10_000_001))

    await expect(readTextFile(root, 'large.png')).resolves.toMatchObject({
      text: '',
      binary: true,
      bytes: 10_000_001,
      previewError: expect.stringMatching(/too large/i),
    })
  })
})

describe('심볼릭 링크는 프로젝트 루트 안으로만 해석된다', () => {
  it('Given 중간 경로가 밖을 가리키는 링크 When 목록을 열면 Then 프로젝트 밖이라 거절한다', async () => {
    const outside = outsideDir()
    mkdirSync(join(outside, 'nested'))
    writeFileSync(join(outside, 'nested', 'secret.txt'), 'leak')
    symlinkSync(outside, join(root, 'linked'), 'dir')

    await expect(listDir(root, 'linked/nested')).rejects.toThrow(/outside the project/i)
  })

  it('Given 마지막 경로가 밖의 파일을 가리키는 링크 When 셸 경로를 만들면 Then 프로젝트 밖이라 거절한다', async () => {
    const outside = outsideDir()
    writeFileSync(join(outside, 'secret.txt'), 'leak')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'secret.txt'))

    await expect(resolveExisting(root, 'secret.txt')).rejects.toThrow(/outside the project/i)
  })

  it('Given 옮길 대상이 밖으로 향한 링크 When 이동하면 Then 밖의 파일을 옮기지 않는다', async () => {
    const outside = outsideDir()
    writeFileSync(join(outside, 'secret.txt'), 'leak')
    mkdirSync(join(root, 'dst'))
    symlinkSync(join(outside, 'secret.txt'), join(root, 'secret.txt'))

    await expect(moveEntry(root, 'secret.txt', 'dst')).rejects.toThrow(/outside the project/i)
  })

  it('Given 이동 목적 폴더가 밖을 가리키는 링크 When 이동하면 Then 밖에 쓰지 않는다', async () => {
    const outside = outsideDir()
    writeFileSync(join(root, 'a.ts'), 'inside')
    symlinkSync(outside, join(root, 'drop'), 'dir')

    await expect(moveEntry(root, 'a.ts', 'drop')).rejects.toThrow(/outside the project/i)
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('inside')
  })

  it('Given 가져오기 목적 폴더가 링크 When 파일을 쓰면 Then 링크 밖에 만들지 않는다', async () => {
    const outside = outsideDir()
    symlinkSync(outside, join(root, 'drop'), 'dir')

    await expect(importFile(root, 'drop', 'a.ts', Buffer.from('inside'))).rejects.toThrow(/outside the project/i)
  })

  it('Given 읽을 파일이 링크 When 텍스트를 열면 Then 링크 대상을 읽지 않는다', async () => {
    const outside = outsideDir()
    writeFileSync(join(outside, 'secret.txt'), 'leak')
    symlinkSync(join(outside, 'secret.txt'), join(root, 'secret.txt'))

    await expect(readTextFile(root, 'secret.txt')).rejects.toThrow(/outside the project/i)
  })

  it('Given 끊어진 링크 When 셸 경로를 만들면 Then 사라진 파일로 거절한다', async () => {
    symlinkSync(join(root, 'missing.txt'), join(root, 'dangling.txt'))

    await expect(resolveExisting(root, 'dangling.txt')).rejects.toThrow(/no longer there/i)
  })

  it('Given 링크가 프로젝트 안을 가리키면 When 파일을 읽으면 Then 일반 파일처럼 허용한다', async () => {
    mkdirSync(join(root, 'actual'))
    writeFileSync(join(root, 'actual', 'inside.txt'), 'inside')
    symlinkSync(join(root, 'actual'), join(root, 'linked'), 'dir')

    await expect(readTextFile(root, 'linked/inside.txt')).resolves.toMatchObject({ text: 'inside', binary: false })
  })

  it('Given 링크가 프로젝트 안을 가리키면 When 목록을 열면 Then pnpm식 내부 링크도 따라간다', async () => {
    mkdirSync(join(root, 'store/pkg'), { recursive: true })
    writeFileSync(join(root, 'store/pkg', 'index.js'), 'export {}')
    mkdirSync(join(root, 'node_modules'))
    symlinkSync(join(root, 'store/pkg'), join(root, 'node_modules/pkg'), 'dir')

    await expect(listDir(root, 'node_modules/pkg')).resolves.toEqual([
      { name: 'index.js', path: 'node_modules/pkg/index.js', isDir: false, ignored: false },
    ])
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
    expect(await resolveExisting(root, 'a.ts')).toBe(realpathSync(join(root, 'a.ts')))
  })

  /** 없는 경로를 셸에 넘기면 아무 일도 일어나지 않는다 — 그 침묵을 여기서 막는다 */
  it('없는 파일은 거절한다', async () => {
    await expect(resolveExisting(root, 'gone.ts')).rejects.toThrow(/no longer there/)
  })

  it('프로젝트 밖은 거절한다 (휴지통이 남의 파일을 삼키지 않게)', async () => {
    await expect(resolveExisting(root, '../..')).rejects.toThrow(/outside the project/)
  })
})
