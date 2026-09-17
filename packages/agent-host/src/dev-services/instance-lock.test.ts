import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { acquireInstanceLock } from './instance-lock.js'

/**
 * 같은 데이터 폴더를 host 둘이 쓰면 각자 다른 세션 목록을 들고 같은 파일에 쓴다.
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
  it('처음 잡으면 성공하고 진단 파일과 DELETE mode 소유권 DB가 생긴다', () => {
    const db = dbIn()
    const r = acquireInstanceLock(db)
    expect(r.ok).toBe(true)
    const lockPath = join(db, '..', 'host.lock')
    expect(JSON.parse(readFileSync(lockPath, 'utf8'))).toMatchObject({ pid: process.pid, ownerToken: expect.any(String) })
    if (r.ok) r.release()
    const ownership = new Database(join(db, '..', 'host-ownership.sqlite'))
    expect(ownership.pragma('journal_mode', { simple: true })).toBe('delete')
    ownership.close()
  })

  it('살아 있는 legacy 숫자 잠금은 같은 pid라도 보수적으로 막는다', () => {
    const db = dbIn()
    writeFileSync(join(db, '..', 'host.lock'), String(process.pid))
    const r = acquireInstanceLock(db)
    expect(r).toMatchObject({ ok: false, heldByPid: process.pid })
  })

  it('죽은 legacy 숫자 잠금과 malformed 진단 파일은 소유권 DB 획득 뒤 교체한다', () => {
    const db = dbIn()
    writeFileSync(join(db, '..', 'host.lock'), '999999')
    const first = acquireInstanceLock(db)
    expect(first.ok).toBe(true)
    if (first.ok) first.release()
    writeFileSync(join(db, '..', 'host.lock'), '{broken')
    const second = acquireInstanceLock(db)
    expect(second.ok).toBe(true)
    if (second.ok) second.release()
  })

  it('풀면 진단 파일이 사라지고 다음 host가 잡을 수 있으며 double release는 안전하다', () => {
    const db = dbIn()
    const first = acquireInstanceLock(db)
    expect(first.ok).toBe(true)
    if (first.ok) {
      first.release()
      first.release()
    }
    expect(existsSync(join(db, '..', 'host.lock'))).toBe(false)
    const second = acquireInstanceLock(db)
    expect(second.ok).toBe(true)
    if (second.ok) second.release()
  })

  it('남의 새 진단 토큰은 풀지 않는다', () => {
    const db = dbIn()
    const mine = acquireInstanceLock(db)
    writeFileSync(join(db, '..', 'host.lock'), JSON.stringify({ pid: process.ppid, ownerToken: 'other' }))
    if (mine.ok) mine.release()
    expect(JSON.parse(readFileSync(join(db, '..', 'host.lock'), 'utf8'))).toMatchObject({ ownerToken: 'other' })
  })

  it('메모리 DB는 공유될 일이 없으므로 막지 않는다', () => {
    expect(acquireInstanceLock(':memory:').ok).toBe(true)
  })

  it('동시 child process 경쟁에서 정확히 하나만 소유한다', async () => {
    const db = dbIn()
    const script = fileURLToPath(new URL('./instance-lock-child.mjs', import.meta.url))
    const results = await Promise.all([0, 1, 2, 3].map(() => runChild(script, db)))
    const winners = results.filter((result) => result.includes('acquired'))
    const losers = results.filter((result) => result.includes('blocked'))
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(3)
  })

  it('소유 process가 SIGKILL로 죽으면 SQLite 핸들 해제로 재획득된다', () => {
    const db = dbIn()
    const script = fileURLToPath(new URL('./instance-lock-child.mjs', import.meta.url))
    const child = spawnSync(process.execPath, ['--import', 'tsx', script, db, 'hold'], { encoding: 'utf8', timeout: 2000 })
    expect(child.stdout).toContain('acquired')
    expect(existsSync(join(db, '..', 'host.lock'))).toBe(true)
    expect(existsSync(join(db, '..', 'host-ownership.sqlite'))).toBe(true)
    const r = acquireInstanceLock(db)
    expect(r.ok).toBe(true)
    if (r.ok) r.release()
    expect(existsSync(join(db, '..', 'host-ownership.sqlite'))).toBe(true)
  })

  it('소유권 DB가 corrupt면 fail closed 한다', () => {
    const db = dbIn()
    writeFileSync(join(db, '..', 'host-ownership.sqlite'), 'not sqlite')
    const r = acquireInstanceLock(db)
    expect(r).toMatchObject({ ok: false, heldByPid: null, reason: expect.stringContaining('ownership database unavailable') })
    if (!r.ok) expect(r.reason).not.toBe('ownership database locked')
  })

  it('이미 잡힌 SQLite 소유권은 stale 진단 파일보다 우선하며 loser 반환 뒤에도 해제 가능하다', () => {
    const db = dbIn()
    writeFileSync(join(db, '..', 'host.lock'), JSON.stringify({ pid: 999999, ownerToken: 'stale-before' }))
    const owner = acquireInstanceLock(db)
    expect(owner.ok).toBe(true)
    writeFileSync(join(db, '..', 'host.lock'), JSON.stringify({ pid: 424242, ownerToken: 'stale-during' }))
    const loser = acquireInstanceLock(db)
    expect(loser).toMatchObject({ ok: false, heldByPid: 424242, reason: 'ownership database locked' })
    if (owner.ok) owner.release()
    const next = acquireInstanceLock(db)
    expect(next.ok).toBe(true)
    if (next.ok) next.release()
  })

  it('진단 파일 쓰기 실패는 소유권 획득과 해제를 깨뜨리지 않는다', () => {
    const db = dbIn()
    mkdirSync(join(db, '..', 'host.lock'))
    const r = acquireInstanceLock(db)
    expect(r.ok).toBe(true)
    if (r.ok) r.release()
  })
})


function runChild(script: string, db: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', script, db, 'wait'], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.on('error', reject)
    child.on('close', () => resolve(output))
  })
}
