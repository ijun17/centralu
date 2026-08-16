import { describe, expect, it, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireInstanceLock } from './instance-lock.js'

/**
 * 같은 데이터 폴더를 host 둘이 쓰면 각자 다른 세션 목록을 들고 같은 파일에 쓴다.
 * 그러면 '이미 불러옴' 판정이 어긋나 같은 대화가 목록에 둘 생긴다.
 * 조용히 이상해지는 것보다 뜨지 않고 이유를 말하는 편이 낫다.
 */
const dirs: string[] = []
const dbIn = () => {
  const d = mkdtempSync(join(tmpdir(), 'cc-lock-'))
  dirs.push(d)
  return join(d, 'store.db')
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('host 단일 인스턴스 잠금', () => {
  it('처음 잡으면 성공하고 잠금 파일이 생긴다', () => {
    const db = dbIn()
    const r = acquireInstanceLock(db)
    expect(r.ok).toBe(true)
    expect(existsSync(join(db, '..', 'host.lock'))).toBe(true)
    if (r.ok) r.release()
  })

  it('살아 있는 다른 프로세스가 쥐고 있으면 막는다', () => {
    const db = dbIn()
    // 반드시 살아 있는 pid: 부모(=이 테스트를 띄운 프로세스)
    writeFileSync(join(db, '..', 'host.lock'), String(process.ppid))
    const r = acquireInstanceLock(db)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.heldByPid).toBe(process.ppid)
  })

  it('죽은 주인이 남긴 잠금은 가져간다 (앱이 강제 종료된 경우)', () => {
    const db = dbIn()
    // 존재할 수 없는 pid
    writeFileSync(join(db, '..', 'host.lock'), '999999')
    const r = acquireInstanceLock(db)
    expect(r.ok).toBe(true)
    expect(readFileSync(join(db, '..', 'host.lock'), 'utf8')).toBe(String(process.pid))
  })

  it('풀면 잠금 파일이 사라지고 다음 host가 잡을 수 있다', () => {
    const db = dbIn()
    const first = acquireInstanceLock(db)
    if (first.ok) first.release()
    expect(existsSync(join(db, '..', 'host.lock'))).toBe(false)
    expect(acquireInstanceLock(db).ok).toBe(true)
  })

  it('남의 잠금은 풀지 않는다 (막은 의미가 없어진다)', () => {
    const db = dbIn()
    const mine = acquireInstanceLock(db)
    // 그 사이 다른 host가 가져간 상황
    writeFileSync(join(db, '..', 'host.lock'), String(process.ppid))
    if (mine.ok) mine.release()
    expect(readFileSync(join(db, '..', 'host.lock'), 'utf8')).toBe(String(process.ppid))
  })

  it('메모리 DB는 공유될 일이 없으므로 막지 않는다', () => {
    expect(acquireInstanceLock(':memory:').ok).toBe(true)
  })
})
