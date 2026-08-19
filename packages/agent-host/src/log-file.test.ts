import { afterEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MAX_LOG_BYTES, hostLogPath, rotateIfLarge, startupBanner, teeStderrToFile } from './log-file.js'

const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'cc-log-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('host 로그 파일', () => {
  it('stderr로 나간 말이 파일에도 남는다', () => {
    const path = hostLogPath(tmp())
    const stop = teeStderrToFile(path)
    try {
      // console.error가 결국 부르는 자리를 직접 쓴다 —
      // vitest는 console을 가로채므로 console.error로는 진짜 경로를 시험하지 못한다
      process.stderr.write('[agent-host] hello\n')
    } finally {
      stop()
    }
    expect(readFileSync(path, 'utf8')).toContain('[agent-host] hello')
  })

  /*
   * 파일로 빼돌리기만 하면 터미널로 띄웠을 때 눈앞에서 사라진다 —
   * 개발 중에는 그게 더 불편하다. 파일은 '또 하나의 청중'이지 대체재가 아니다.
   */
  it('원래 stderr도 그대로 흐른다 (가로채지 않는다)', () => {
    const path = hostLogPath(tmp())
    const seen: string[] = []
    const real = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((c: unknown) => {
      seen.push(String(c))
      return true
    }) as typeof process.stderr.write
    const stop = teeStderrToFile(path)
    try {
      process.stderr.write('보이는가\n')
    } finally {
      stop()
      process.stderr.write = real
    }
    expect(seen.join('')).toContain('보이는가')
    expect(readFileSync(path, 'utf8')).toContain('보이는가')
  })

  it('넘치면 한 세대만 남기고 밀어낸다 (폴더를 조용히 먹지 않는다)', () => {
    const path = hostLogPath(tmp())
    writeFileSync(path, 'x'.repeat(100))
    expect(rotateIfLarge(path, 50)).toBe(true)
    expect(existsSync(`${path}.1`)).toBe(true)
    expect(existsSync(path)).toBe(false)
  })

  it('아직 작으면 그대로 둔다', () => {
    const path = hostLogPath(tmp())
    writeFileSync(path, 'x'.repeat(10))
    expect(rotateIfLarge(path, MAX_LOG_BYTES)).toBe(false)
    expect(existsSync(`${path}.1`)).toBe(false)
  })

  it('쓰는 도중에 넘쳐도 회전하고 계속 쓴다', () => {
    const path = hostLogPath(tmp())
    const stop = teeStderrToFile(path, 64)
    try {
      for (let i = 0; i < 12; i++) process.stderr.write(`line ${i} ${'y'.repeat(20)}\n`)
      // 회전 **뒤에도** 계속 적히는지가 핵심이다 — 여기서 멈추면 조용히 눈이 먼다
      process.stderr.write('after-roll\n')
    } finally {
      stop()
    }
    expect(existsSync(`${path}.1`)).toBe(true)
    expect(readFileSync(path, 'utf8')).toContain('after-roll')
  })

  /*
   * 회전이 close 뒤 rename에서 실패하면, 예전에는 **닫은 fd 번호**가 그대로 남았다.
   * OS는 그 번호를 곧 다른 파일(SQLite WAL·pty)에 재발급하므로 다음 writeSync가
   * 남의 파일에 로그를 쓰는 조용한 오염이 된다. 실패 경로에서도 fd를 비우고
   * 다시 열어, 그 뒤의 줄이 **여전히 이 로그 파일에** 남는지를 본다.
   */
  it('회전이 실패해도 죽은 fd를 붙들지 않고 같은 파일에 계속 쓴다', () => {
    const dir = tmp()
    const path = hostLogPath(dir)
    const stop = teeStderrToFile(path, 64)
    try {
      // rename이 실패하게 만든다 — 디렉토리에 쓰기 권한이 없으면 EACCES
      chmodSync(dir, 0o555)
      for (let i = 0; i < 12; i++) process.stderr.write(`line ${i} ${'y'.repeat(20)}\n`)
      process.stderr.write('after-failed-roll\n')
    } finally {
      chmodSync(dir, 0o755)
      stop()
    }
    // 회전은 못 했지만(한 파일에 그대로) 로그는 계속 이 파일로 흘렀다
    expect(existsSync(`${path}.1`)).toBe(false)
    expect(readFileSync(path, 'utf8')).toContain('after-failed-roll')
  })

  /*
   * "지금 도는 앱이 어느 커밋 빌드냐"에 바이너리 mtime과 커밋 시각을 맞춰 답해야 했다.
   * 로그가 스스로 말하면 그 추측이 통째로 없어진다.
   */
  it('기동 배너가 빌드·DB·pid를 스스로 말한다', () => {
    const b = startupBanner({ build: 'abc1234', db: '/x/store.db', pid: 42 })
    expect(b).toContain('abc1234')
    expect(b).toContain('/x/store.db')
    expect(b).toContain('42')
  })
})
