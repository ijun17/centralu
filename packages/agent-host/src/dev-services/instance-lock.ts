import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 한 데이터 폴더에는 host 하나만.
 *
 * 권위는 전용 SQLite 파일의 BEGIN EXCLUSIVE 핸들이고, host.lock은 사람이 읽는 진단이다.
 * 같은 프로세스/다른 프로세스/강제 종료 모두 OS SQLite 잠금 규칙을 따르게 한다.
 */

export type LockResult =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly heldByPid: number | null; readonly reason: string }

type LockMetadata = { readonly pid: number; readonly ownerToken: string }

/** 그 pid가 아직 살아 있나 (신호 0은 존재만 확인한다) */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    if (err instanceof Error && 'code' in err) return err.code === 'EPERM'
    return false
  }
}

export function acquireInstanceLock(dbPath: string): LockResult {
  // 메모리 DB는 공유될 일이 없다
  if (dbPath === ':memory:') return { ok: true, release: () => {} }

  const root = dirname(dbPath)
  const lockPath = join(root, 'host.lock')
  const legacyPid = readLegacyLivePid(lockPath)
  if (legacyPid !== null) {
    return { ok: false, heldByPid: legacyPid, reason: 'legacy live host.lock' }
  }

  const ownershipPath = join(root, 'host-ownership.sqlite')
  let db: Database.Database | null = null
  try {
    db = new Database(ownershipPath, { timeout: 0 })
    const journalMode = db.pragma('journal_mode = DELETE', { simple: true })
    if (journalMode !== 'delete') {
      throw new Error(`ownership database requires journal_mode DELETE but SQLite returned ${String(journalMode)}`)
    }
    db.pragma('busy_timeout = 0')
    db.exec('BEGIN EXCLUSIVE')
  } catch (err) {
    if (db !== null) {
      try {
        db.close()
      } catch {
        // The acquire path is already failing. Preserve the actionable primary reason.
      }
    }
    return { ok: false, heldByPid: readDiagnosticPid(lockPath), reason: lockFailureReason(err) }
  }

  const ownerToken = randomUUID()
  const metadata = JSON.stringify({ pid: process.pid, ownerToken } satisfies LockMetadata)
  try {
    writeFileSync(lockPath, metadata)
  } catch {
    // host.lock is diagnostic only. The SQLite exclusive transaction is authority.
  }
  let released = false

  return {
    ok: true,
    release: () => {
      if (released) return
      released = true
      try {
        const current = readMetadata(lockPath)
        if (current?.ownerToken === ownerToken) unlinkSync(lockPath)
      } catch {
        // 진단 파일 정리는 best-effort다. SQLite 핸들 종료가 실제 해제다.
      } finally {
        db.close()
      }
    },
  }
}

function readLegacyLivePid(lockPath: string): number | null {
  if (!existsSync(lockPath)) return null
  let text: string
  try {
    text = readFileSync(lockPath, 'utf8').trim()
  } catch {
    return null
  }
  if (!/^\d+$/.test(text)) return null
  const pid = Number(text)
  return alive(pid) ? pid : null
}

function readDiagnosticPid(lockPath: string): number | null {
  const metadata = readMetadata(lockPath)
  if (metadata && Number.isInteger(metadata.pid) && metadata.pid > 0) return metadata.pid
  const legacy = readLegacyLivePid(lockPath)
  return legacy
}

function readMetadata(lockPath: string): LockMetadata | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (!isRecord(raw)) return null
    const pid = raw.pid
    const ownerToken = raw.ownerToken
    if (typeof pid !== 'number' || typeof ownerToken !== 'string') return null
    return { pid, ownerToken }
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function lockFailureReason(err: unknown): string {
  if (err instanceof Error && 'code' in err && (err.code === 'SQLITE_BUSY' || err.code === 'SQLITE_LOCKED')) return 'ownership database locked'
  if (err instanceof Error) return `ownership database unavailable: ${err.message}`
  return 'ownership database unavailable: unknown ownership error'
}
