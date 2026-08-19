import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { APP_ID, APP_NAME, APP_SLUG, APP_VERSION } from '../packages/protocol/src/brand.js'

/** 옛 이름을 일부러 아는 줄에 다는 표식 — 이 파일이 그 줄을 건너뛴다 */
const LEGACY_MARK = 'legacy-name'

/**
 * 이름 계약.
 *
 * 앱 이름은 TypeScript가 닿지 못하는 곳에도 박힌다 — `index.html`, `tauri.conf.json`,
 * `Cargo.toml`, 실행 스크립트. **거기서 어긋나도 빌드는 통과한다.** 배포 앱을 열어봐야 안다.
 * 그래서 상수로 묶는 대신 여기서 확인한다: 화면 문구는 리터럴로 읽기 좋게 두되,
 * 정적 파일이 `brand.ts`와 다르면 이 테스트가 파일 이름을 대며 실패한다.
 */

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')
const json = (p: string) => JSON.parse(read(p)) as Record<string, unknown>

describe('이름은 한 곳에서 정한다', () => {
  it('창 제목과 번들 이름이 APP_NAME과 같다', () => {
    const tauri = json('apps/desktop/src-tauri/tauri.conf.json')
    expect(tauri.productName).toBe(APP_NAME)
    expect((tauri.app as { windows: { title: string }[] }).windows[0]?.title).toBe(APP_NAME)
  })

  it('번들 식별자가 APP_ID와 같다', () => {
    expect(json('apps/desktop/src-tauri/tauri.conf.json').identifier).toBe(APP_ID)
  })

  it('브라우저 탭 제목 두 곳이 APP_NAME과 같다', () => {
    for (const p of ['apps/desktop/index.html', 'apps/web/index.html']) {
      expect(read(p), p).toContain(`<title>${APP_NAME}</title>`)
    }
  })

  it('버전이 세 곳에서 같다', () => {
    expect(json('apps/desktop/src-tauri/tauri.conf.json').version).toBe(APP_VERSION)
    expect(json('apps/desktop/package.json').version).toBe(APP_VERSION)
    expect(read('apps/desktop/src-tauri/Cargo.toml')).toContain(`version = "${APP_VERSION}"`)
  })

  it('npm 패키지 이름·버전이 brand.ts를 따른다', () => {
    // 발행은 되돌릴 수 없다(npm은 24시간 뒤 unpublish를 막는다). 어긋난 채로 나가지 않게
    // 여기서 먼저 잡는다 — 릴리스 스크립트도 같은 값을 써서 다시 적는다.
    const main = json('packaging/npm/centralu/package.json')
    const arch = json('packaging/npm/darwin-arm64/package.json')
    expect(main.name).toBe(APP_SLUG)
    expect(main.version).toBe(APP_VERSION)
    expect(arch.version).toBe(APP_VERSION)
    expect(arch.name).toBe(`${APP_SLUG}-darwin-arm64`)
    // 껍데기와 알맹이는 **정확히 같은 버전**이어야 한다 (범위로 두면 따로 놀 수 있다)
    expect((main.optionalDependencies as Record<string, string>)[arch.name as string]).toBe(APP_VERSION)
    // 아키텍처 패키지가 담는 번들 이름도 APP_NAME을 따른다
    expect(arch.files).toContain(`${APP_NAME}.app`)
  })

  it('빌드한 .app을 여는 스크립트가 실제 번들 이름을 가리킨다', () => {
    // productName이 바뀌면 번들 파일 이름도 바뀐다 — 스크립트가 옛 경로면 조용히 안 열린다
    const scripts = json('package.json').scripts as Record<string, string>
    for (const [name, cmd] of Object.entries(scripts)) {
      if (cmd.includes('bundle/macos/')) expect(cmd, name).toContain(`bundle/macos/${APP_NAME}.app`)
    }
  })

  it('옛 이름이 어디에도 남아 있지 않다', () => {
    /*
     * 개명에서 가장 흔한 실패는 "몇 군데를 놓치는 것"이고, 놓친 곳은 대개 주석·테스트
     * 제목처럼 아무도 안 보는 자리에 오래 남는다. 추적 중인 파일 전체를 한 번에 본다.
     *
     * 데이터 폴더(`.control-center`)는 예외다 — 이름을 바꾸면 사용자의 대화 기록이
     * 통째로 안 보이게 되므로 **일부러** 옛 이름을 유지한다 (brand.ts의 DATA_DIR 참조).
     */
    const files = execFileSync('git', ['ls-files'], { encoding: 'utf8' }).trim().split('\n')
    const offenders: string[] = []
    for (const f of files) {
      if (f === 'tooling/brand.test.ts') continue
      let text: string
      try {
        text = read(f)
      } catch {
        continue // 바이너리·심링크
      }
      const stale = text
        .split('\n')
        .map((line, i) => ({ line, i: i + 1 }))
        .filter(({ line }) => /control[ _-]?center/i.test(line))
        /*
         * 예외를 **목록으로 기르지 않는다.**
         *
         * 한때 데이터 폴더·DB 테이블·저장소 폴더가 여기 예외로 적혀 있었다. 그런 목록은
         * 자라기만 하고, 자란 목록은 결국 "옛 이름을 찾는다"는 검사를 무력하게 만든다.
         * 그래서 둘은 마이그레이션으로 없앴고(폴더는 rename, 테이블은 ALTER TABLE),
         * 남은 자리 — 개명을 **수행하느라** 옛 이름을 알아야 하는 코드 — 는
         * 그 줄에 `legacy-name` 표식을 달게 했다. 예외가 테스트가 아니라 현장에 적힌다.
         */
        .filter(({ line }) => !line.includes(LEGACY_MARK))
        // 저장소 폴더 이름은 사용자의 로컬 디렉토리다 (문서의 구조도에 경로로 등장한다)
        .filter(({ line }) => line.trim() !== 'control-center/')
      if (stale.length > 0) offenders.push(`${f}:${stale.map((s) => s.i).join(',')}`)
    }
    expect(offenders).toEqual([])
  })
})
