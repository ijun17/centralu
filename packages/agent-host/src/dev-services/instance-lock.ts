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
 */

export type LockResult = { ok: true; release: () => void } | { ok: false; heldByPid: number }

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

export function acquireInstanceLock(dbPath: string): LockResult {
  // 메모리 DB는 공유될 일이 없다
  if (dbPath === ':memory:') return { ok: true, release: () => {} }

  const lockPath = join(dirname(dbPath), 'host.lock')

  try {
    const held = Number(readFileSync(lockPath, 'utf8').trim())
    if (alive(held) && held !== process.pid) return { ok: false, heldByPid: held }
    // 죽은 주인이 남긴 파일은 그냥 가져간다 (앱이 강제 종료됐을 때)
  } catch {
    // 파일이 없으면 처음 잡는 것이다
  }

  writeFileSync(lockPath, String(process.pid))
  let released = false
  return {
    ok: true,
    release: () => {
      if (released) return
      released = true
      try {
        // 내 것일 때만 지운다 — 남의 잠금을 치우면 막은 의미가 없다
        if (Number(readFileSync(lockPath, 'utf8').trim()) === process.pid) unlinkSync(lockPath)
      } catch {
        // 이미 사라졌으면 할 일이 없다
      }
    },
  }
}
