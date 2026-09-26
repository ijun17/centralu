import { describe, expect, it, afterEach } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { acquireInstanceLock, processStartTime } from './instance-lock.js'

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
    expect(JSON.parse(readFileSync(join(db, '..', 'host.lock'), 'utf8'))).toEqual({
      pid: process.pid,
      started: processStartTime(process.pid),
    })
  })

  /*
   * 잠금은 exit 이벤트에서만 풀린다 — SIGKILL이나 정전 뒤에는 파일이 남는다. 남은 pid를
   * Centralu와 무관한 프로세스가 다시 쓰고 있으면 pid만으로는 가릴 수 없어 기동이 거절됐고,
   * 닫을 창이 없으니 풀 길도 없었다 (#184). 시작 시각이 다르면 남이다.
   */
  it('pid가 살아 있어도 시작 시각이 다르면 남이 번호를 다시 쓴 것이다 — 가져간다', () => {
    const db = dbIn()
    writeFileSync(join(db, '..', 'host.lock'), JSON.stringify({ pid: process.ppid, started: 'Thu Jan  1 00:00:00 1970' }))
    const r = acquireInstanceLock(db, () => 'Sun Sep 27 00:21:23 2026')
    expect(r.ok).toBe(true)
    expect(JSON.parse(readFileSync(join(db, '..', 'host.lock'), 'utf8')).pid).toBe(process.pid)
  })

  it('pid와 시작 시각이 모두 같으면 막고, 잠금 파일의 자리를 알려 준다', () => {
    const db = dbIn()
    const started = processStartTime(process.ppid)
    expect(started).not.toBeNull()
    writeFileSync(join(db, '..', 'host.lock'), JSON.stringify({ pid: process.ppid, started }))
    const r = acquireInstanceLock(db)
    expect(r).toEqual({ ok: false, heldByPid: process.ppid, lockPath: join(db, '..', 'host.lock') })
  })

  it('지금 그 pid의 시작 시각을 못 읽으면 막는다 — 모를 때 뺏는 쪽이 더 위험하다', () => {
    const db = dbIn()
    writeFileSync(join(db, '..', 'host.lock'), JSON.stringify({ pid: process.ppid, started: 'Thu Jan  1 00:00:00 1970' }))
    expect(acquireInstanceLock(db, () => null).ok).toBe(false)
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

/*
 * 데스크톱 수퍼바이저는 host의 표준출력만 읽는다. 잠금 충돌의 문장이 표준에러로만 나가서
 * 화면에는 이유 대신 "agent-host가 종료되었습니다 (code Some(1))"만 떴다 (#184).
 * 진짜 host를 띄워 어느 통로로 나오는지 본다.
 */
describe('잠금 충돌의 문장이 수퍼바이저에 닿는다', () => {
  it('막힌 host는 이유를 표준출력에도 쓰고 1로 끝난다', () => {
    const db = dbIn()
    // 이 테스트 프로세스가 주인이다 — 살아 있고 시작 시각도 맞다
    writeFileSync(join(db, '..', 'host.lock'), JSON.stringify({ pid: process.pid, started: processStartTime(process.pid) }))
    const root = fileURLToPath(new URL('../../../../', import.meta.url))
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'packages/agent-host/src/main.ts', '--db', db, '--port', '0'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, CI: '1' },
    })
    expect(r.status).toBe(1)
    expect(r.stdout).toContain('Another Centralu is already using this data')
    expect(r.stdout).toContain(`Lock file: ${join(db, '..', 'host.lock')}`)
  }, 60_000)
})
