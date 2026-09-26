import { execFileSync } from 'node:child_process'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 한 데이터 폴더에는 host 하나만.
 *
 * 두 host가 같은 store.db를 붙잡으면 각자 메모리에 세션 목록을 들고 있으면서
 * 같은 파일에 쓴다. 한쪽이 만든 세션을 다른 쪽은 모르므로,
 * **'이미 불러옴' 판정이 어긋나 같은 대화가 목록에 둘 생긴다** —
 * 실제로 겪은 중복 세션이 이 구조에서 나올 수 있다.
 * SQLite 잠금 경합은 덤이다.
 *
 * 그래서 잠금 파일 하나로 막고, 막힌 이유를 분명히 말한다.
 *
 * **잠금 파일에는 pid와 그 프로세스의 시작 시각을 함께 적는다** (#184). 잠금은 `exit`
 * 이벤트에서만 풀리므로 SIGKILL(앱 종료 때 host가 3초 안에 못 끝낸 경우)이나 정전 뒤에는
 * 파일이 남는다. pid만 적으면 그 번호를 Centralu와 무관한 프로세스가 다시 쓰고 있을 때
 * 기동이 거절되고, 닫을 창이 없으니 사람은 풀 길을 모른다. 같은 pid라도 시작 시각이
 * 다르면 남이다.
 */

export type LockResult = { ok: true; release: () => void } | { ok: false; heldByPid: number; lockPath: string }

/** 잠금 파일의 내용. 옛 host가 쓴 파일은 pid 숫자 하나다 */
type Holder = { pid: number; started: string | null }

/** 그 pid가 아직 살아 있나 (신호 0은 존재만 확인한다) */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM이면 남의 프로세스지만 **살아 있다** — 죽었다고 보면 안 된다
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * 그 pid의 시작 시각. 모르면 null.
 *
 * `ps -o lstart=`의 모양은 로캘을 따른다(한국어 로캘이면 "2026년 9월 27일 …"). 잠금을 쓴
 * host와 읽는 host의 로캘이 다르면 같은 프로세스를 남으로 보고 잠금을 뺏게 되므로 C로 고정한다.
 */
export function processStartTime(pid: number): string | null {
  if (process.platform === 'win32') return null
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, LC_ALL: 'C' },
    }).trim()
    return out || null
  } catch {
    return null
  }
}

function parseHolder(raw: string): Holder {
  const text = raw.trim()
  if (/^\d+$/.test(text)) return { pid: Number(text), started: null }
  try {
    const v = JSON.parse(text) as { pid?: unknown; started?: unknown }
    return {
      pid: typeof v.pid === 'number' ? v.pid : NaN,
      started: typeof v.started === 'string' ? v.started : null,
    }
  } catch {
    return { pid: NaN, started: null }
  }
}

/**
 * 적힌 주인이 아직 그 프로세스인가.
 *
 * 시작 시각이 적혀 있고 지금 그 pid의 시작 시각을 읽을 수 있으면 둘을 맞춰 본다. 어느 한쪽을
 * 모르면(옛 파일, ps 실패) 살아 있는지만 본다 — 모를 때 잠금을 뺏는 쪽보다 막는 쪽이 안전하다.
 */
function stillHeld(holder: Holder, startOf: (pid: number) => string | null): boolean {
  if (!alive(holder.pid) || holder.pid === process.pid) return false
  if (holder.started === null) return true
  const now = startOf(holder.pid)
  return now === null || now === holder.started
}

export function acquireInstanceLock(
  dbPath: string,
  startOf: (pid: number) => string | null = processStartTime,
): LockResult {
  // 메모리 DB는 공유될 일이 없다
  if (dbPath === ':memory:') return { ok: true, release: () => {} }

  const lockPath = join(dirname(dbPath), 'host.lock')

  try {
    const held = parseHolder(readFileSync(lockPath, 'utf8'))
    if (stillHeld(held, startOf)) return { ok: false, heldByPid: held.pid, lockPath }
    // 죽은 주인(또는 번호만 같은 남)이 남긴 파일은 그냥 가져간다 (앱이 강제 종료됐을 때)
  } catch {
    // 파일이 없으면 처음 잡는 것이다
  }

  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, started: startOf(process.pid) }))
  let released = false
  return {
    ok: true,
    release: () => {
      if (released) return
      released = true
      try {
        // 내 것일 때만 지운다 — 남의 잠금을 치우면 막은 의미가 없다
        if (parseHolder(readFileSync(lockPath, 'utf8')).pid === process.pid) unlinkSync(lockPath)
      } catch {
        // 이미 사라졌으면 할 일이 없다
      }
    },
  }
}

/** 잠금에 막혔을 때의 문장. 닫을 것이 없는 사람도 풀 수 있게 잠금 파일의 자리를 적는다 (#184) */
export function lockConflictMessage(heldByPid: number, lockPath: string): string {
  return (
    `[agent-host] Another Centralu is already using this data (pid ${heldByPid}).\n` +
    `  Two hosts on the same folder will desync session lists.\n` +
    `  Close the running window first, or use pnpm app:dev while developing (it uses a separate data folder).\n` +
    `  Lock file: ${lockPath}`
  )
}
