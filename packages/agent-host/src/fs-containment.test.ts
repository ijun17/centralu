import { execFileSync } from 'node:child_process'
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ToolName } from '@cc/protocol'
import type { AgentAdapter } from './adapters/contract.js'
import { Store } from './dev-services/store.js'
import { SessionManager } from './sessions/manager.js'
import { createRpcHandler } from './rpc.js'

/**
 * 프로젝트 안의 링크를 밟고 밖으로 나가지 않는다 — **RPC 문에서** (#86).
 *
 * 같은 규칙을 검사하는 테스트가 이미 여럿 있다: fs.test.ts, watch.test.ts, git.test.ts,
 * fs-read-safety.test.ts. 전부 dev-service 함수를 직접 부른다. 그래서 덮이지 않는 것이
 * 하나 남는다 — **웹뷰가 실제로 두드리는 문이 그 함수에 닿는가.** 매니저가 가드를 지나지
 * 않는 헬퍼로 갈아 끼워지거나, 새 fs 메서드가 하나 늘어나면 위 테스트는 전부 초록인 채로
 * 구멍이 열린다. #86은 함수 하나가 아니라 **표면 다섯 개**를 묶은 항목이므로, 그 다섯이
 * 바깥에서 두드려도 닫혀 있다는 증거가 한 자리에 있어야 한다.
 *
 * 저장소를 `git init`으로 진짜로 만든다. 평범한 임시 디렉토리에서는 `git ls-files`도
 * `check-ignore`도 빈손으로 돌아와서, 새는 것이 없어서가 아니라 볼 것이 없어서 초록이 된다.
 *
 * 미끼는 세 모양이다. 링크를 가드에 물어보는 방식이 모양마다 다르기 때문이다:
 *   leakfile        마지막 조각이 밖의 파일
 *   nest/leak/…     중간 조각이 밖의 디렉토리
 *   link/../evil    링크를 따라간 **뒤** `..`로 올라가는 경로 (#119이 닫은 갈라짐)
 */

let fixture = ''
let root = ''
let outside = ''
let rpc: ReturnType<typeof createRpcHandler>
let projectId = ''

const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' })

/** 세 미끼를 모두 통과시켜 보는 자리 — 하나만 막혀도 나머지가 창문이면 소용이 없다 */
const ESCAPING_DIRS = ['leak', 'nest/leak', 'link/../evil'] as const
const ESCAPING_FILES = ['leakfile', 'leak/secret.txt', 'nest/leak/secret.txt', 'link/../evil/secret.txt'] as const

beforeEach(async () => {
  fixture = realpathSync(mkdtempSync(join(tmpdir(), 'cc-contain-')))
  root = join(fixture, 'project')
  outside = join(fixture, 'outside')
  mkdirSync(root)
  mkdirSync(outside)
  writeFileSync(join(outside, 'secret.txt'), 'OUTSIDE-SECRET\n')

  git(['init', '-q'])
  git(['config', 'user.email', 't@t'])
  git(['config', 'user.name', 't'])

  writeFileSync(join(root, 'inside.txt'), 'inside\n')
  mkdirSync(join(root, 'dst'))
  symlinkSync(outside, join(root, 'leak'), 'dir')
  symlinkSync(join(outside, 'secret.txt'), join(root, 'leakfile'))
  mkdirSync(join(root, 'nest'))
  symlinkSync(outside, join(root, 'nest', 'leak'), 'dir')
  // 링크의 대상이 링크 자신보다 깊다 — 가드와 syscall이 갈라지던 모양 (#119)
  mkdirSync(join(root, 'sub', 'deep'), { recursive: true })
  mkdirSync(join(root, 'sub', 'evil'))
  symlinkSync(join(root, 'sub', 'deep'), join(root, 'link'), 'dir')
  symlinkSync(outside, join(root, 'evil'), 'dir')
  // 저장소가 링크를 추적하게 둔다 — 체크아웃이 심는 링크가 이 항목의 위협 모델이다
  git(['add', '-A'])
  git(['commit', '-qm', 'plant'])

  const adapters = new Map<ToolName, AgentAdapter>()
  const mgr = new SessionManager(new Store(), adapters, () => {})
  rpc = createRpcHandler(mgr, adapters)
  projectId = ((await rpc('projects.add', { path: root })) as { id: string }).id
})

afterEach(async () => {
  // 워처를 남겨 두면 지운 디렉토리를 붙들고 프로세스가 안 끝난다
  await rpc('fs.watch', { projectId, paths: [] })
  rmSync(fixture, { recursive: true, force: true })
})

describe('표면 1 — 읽기', () => {
  it('밖을 가리키는 링크를 지나는 읽기는 전부 거절한다', async () => {
    for (const path of ESCAPING_FILES) {
      await expect(rpc('fs.readFile', { projectId, path }), path).rejects.toThrow(/outside the project/i)
    }
  })

  it('프로젝트 안의 파일은 평소처럼 읽힌다', async () => {
    await expect(rpc('fs.readFile', { projectId, path: 'inside.txt' })).resolves.toMatchObject({ text: 'inside\n' })
  })
})

describe('표면 2 — 목록', () => {
  it('밖을 가리키는 디렉토리는 나열하지 않는다', async () => {
    for (const path of ESCAPING_DIRS) {
      await expect(rpc('fs.listDir', { projectId, path }), path).rejects.toThrow(/outside the project/i)
    }
  })

  /**
   * 루트 목록에서 링크는 **파일로** 나온다(`isDir: false`). readdir의 Dirent는 lstat이라
   * 링크를 따라가지 않기 때문인데, 이것이 곧 트리가 그 항목을 펼치려 들지 않는다는 뜻이다.
   * 밖의 이름이 목록에 섞여 나오지 않는 것이 여기서 볼 것이다.
   */
  it('루트 목록에 밖의 이름이 섞이지 않는다', async () => {
    const entries = (await rpc('fs.listDir', { projectId, path: '' })) as { name: string; isDir: boolean }[]
    expect(entries.map((e) => e.name)).not.toContain('secret.txt')
    expect(entries.find((e) => e.name === 'leak')?.isDir).toBe(false)
  })
})

describe('표면 3 — 감시', () => {
  it('밖을 가리키는 디렉토리에는 워처를 걸지 않는다', async () => {
    const res = (await rpc('fs.watch', { projectId, paths: [...ESCAPING_DIRS] })) as { watched: number }
    expect(res).toEqual({ watched: 0 })
  })

  it('프로젝트 안의 디렉토리는 평소처럼 감시한다', async () => {
    await expect(rpc('fs.watch', { projectId, paths: ['sub'] })).resolves.toEqual({ watched: 1 })
  })
})

describe('표면 4 — 쓰기 목적지', () => {
  it('밖을 가리키는 폴더로 옮기지 않는다', async () => {
    for (const toDir of ESCAPING_DIRS) {
      await expect(rpc('fs.move', { projectId, from: 'inside.txt', toDir }), toDir).rejects.toThrow(
        /outside the project/i,
      )
    }
    expect(readFileSync(join(root, 'inside.txt'), 'utf8')).toBe('inside\n')
    expect(readdirSync(outside)).toEqual(['secret.txt'])
  })

  it('밖을 가리키는 링크 자체를 옮기지 않는다', async () => {
    await expect(rpc('fs.move', { projectId, from: 'leakfile', toDir: 'dst' })).rejects.toThrow(
      /outside the project/i,
    )
    expect(readdirSync(join(root, 'dst'))).toEqual([])
  })

  it('밖을 가리키는 폴더에 파일을 만들지 않는다', async () => {
    const dataBase64 = Buffer.from('PWNED\n').toString('base64')
    for (const toDir of ESCAPING_DIRS) {
      await expect(
        rpc('fs.importFile', { projectId, toDir, name: 'planted.txt', dataBase64 }),
        toDir,
      ).rejects.toThrow(/outside the project/i)
    }
    expect(readdirSync(outside)).toEqual(['secret.txt'])
    expect(existsSync(join(fixture, 'planted.txt'))).toBe(false)
  })
})

describe('표면 5 — OS로 넘기는 경로', () => {
  /**
   * 휴지통·Finder에서 보기·IDE에서 열기가 모두 이 한 문을 지난다(`fs.resolve`). 셸에게는
   * 프로젝트라는 개념이 없으므로, 밖으로 나가는 경로가 여기서 만들어지면 그다음은 없다.
   */
  it('밖을 가리키는 경로의 절대 경로는 만들어 주지 않는다', async () => {
    for (const path of [...ESCAPING_FILES, ...ESCAPING_DIRS]) {
      await expect(rpc('fs.resolve', { projectId, path }), path).rejects.toThrow(/outside the project/i)
    }
  })

  it('프로젝트 안의 파일은 정규화된 절대 경로로 넘어간다', async () => {
    await expect(rpc('fs.resolve', { projectId, path: 'inside.txt' })).resolves.toEqual({
      path: realpathSync(join(root, 'inside.txt')),
    })
  })
})

/**
 * 하드링크는 **이 가드가 답할 수 없는 자리**다 — 그래서 막지 않고, 막지 않는다는 것을 못 박는다.
 *
 * 심볼릭 링크는 따라갈 대상이 있어서 "밖"이라고 말할 수 있다. 하드링크는 대상이 없다:
 * 디렉토리 항목 자체가 프로젝트 안에 있고, 바깥의 그 파일과 **같은 inode의 다른 이름**일
 * 뿐이다. 검사한 문자열이 곧 사용되는 문자열이라는 규칙은 여기서 이미 지켜져 있다.
 *
 * 링크 수(`nlink > 1`)로 거절하면 어떻게 되는지가 이 결정의 근거다. 이 저장소를
 * `git clone --local`로 복제하면 파일 670개 중 214개가 nlink 2다 — git이 `.git/objects`를
 * 하드링크로 잇기 때문이고, pnpm도 clonefile이 없는 파일시스템에서는 같은 방식으로 잇는다.
 * 평범한 복제본의 3분의 1을 "열 수 없는 파일"로 만드는 값이다.
 *
 * 그래서 방어는 다른 자리에 있다: 하드링크를 휴지통에 보내면 **프로젝트 쪽 이름만** 지워지고
 * 바깥 파일은 그대로다. `fs.resolve`가 프로젝트 안의 경로를 돌려준다는 것이 그 증거다.
 */
describe('하드링크 — 경로로는 답할 수 없는 한계', () => {
  it('OS로 넘어가는 경로는 프로젝트 안의 이름이다 — 휴지통이 바깥 파일을 지우지 않는다', async () => {
    linkSync(join(outside, 'secret.txt'), join(root, 'hard.txt'))
    await expect(rpc('fs.resolve', { projectId, path: 'hard.txt' })).resolves.toEqual({
      path: join(root, 'hard.txt'),
    })
  })
})
