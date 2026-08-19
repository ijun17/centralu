import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateLegacyDataDir } from './data-dir.js'

/**
 * 이 함수는 **사용자의 대화 기록이 든 폴더**를 옮긴다.
 * 그래서 시험하는 것은 "옮겨지는가"보다 **"어떤 경우에 손대지 않는가"**다.
 */
let root = ''
const seed = (dir: string, body: string) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'store.db'), body)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cc-datadir-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('데이터 폴더 이사', () => {
  it('옛 폴더만 있으면 통째로 옮긴다 (내용 그대로)', () => {
    const from = join(root, '.control-center') // legacy-name
    const to = join(root, '.centralu')
    seed(from, '진짜 대화 기록')
    writeFileSync(join(from, 'store.db-wal'), 'WAL도 함께')

    expect(migrateLegacyDataDir(from, to)).toBe(true)

    expect(existsSync(from)).toBe(false)
    expect(readFileSync(join(to, 'store.db'), 'utf8')).toBe('진짜 대화 기록')
    // WAL을 두고 가면 수십 MB의 최근 대화가 사라진다 — 폴더째 옮기는 이유다
    expect(readFileSync(join(to, 'store.db-wal'), 'utf8')).toBe('WAL도 함께')
  })

  it('새 폴더가 이미 있으면 **아무것도 안 한다**', () => {
    const from = join(root, '.control-center') // legacy-name
    const to = join(root, '.centralu')
    seed(from, '옛 기록')
    seed(to, '새 기록')

    expect(migrateLegacyDataDir(from, to)).toBe(false)

    // 합치는 것은 우리가 판단할 일이 아니다 — 어느 쪽이 진짜인지 모른다. 둘 다 남긴다
    expect(readFileSync(join(to, 'store.db'), 'utf8')).toBe('새 기록')
    expect(readFileSync(join(from, 'store.db'), 'utf8')).toBe('옛 기록')
  })

  it('옛 폴더가 없으면 조용히 넘어간다 (새로 설치한 사람)', () => {
    expect(migrateLegacyDataDir(join(root, '.control-center'), join(root, '.centralu'))).toBe(false) // legacy-name
    expect(existsSync(join(root, '.centralu'))).toBe(false)
  })

  it('옮기지 못해도 옛 폴더를 손상시키지 않는다', () => {
    const from = join(root, '.control-center') // legacy-name
    seed(from, '지켜야 할 기록')
    // 옮길 수 없는 목적지 (부모가 파일이라 디렉토리를 만들 수 없다)
    const blocker = join(root, 'blocker')
    writeFileSync(blocker, 'x')

    expect(migrateLegacyDataDir(from, join(blocker, 'nested', '.centralu'))).toBe(false)

    // 실패했으면 원본은 그대로여야 한다 — 반쪽만 남는 상태를 만들지 않는다
    expect(readFileSync(join(from, 'store.db'), 'utf8')).toBe('지켜야 할 기록')
  })
})
