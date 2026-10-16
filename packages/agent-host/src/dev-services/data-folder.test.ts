import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attachmentBytes } from './attachments.js'
import { handoffNoteBytes, handoffNotePath } from './handoff-notes.js'
import { worktreeRecoveryBytes, worktreeRecoveryDir } from './worktree-recovery.js'

/**
 * What one session's data folders take, as the trash shows it (#204, #850 item 19), through the
 * three functions the trash adds up: attachments, worktree recovery snapshots and the handoff note.
 * The same rule for all three: regular files count, a link counts for nothing and is never followed,
 * and one entry that cannot be read costs only itself.
 */

// Windows needs a privilege to create a symbolic link; the rule is the same there
const links = process.platform === 'win32' ? it.skip : it

let dir = ''
let outside = ''
const sessionId = randomUUID()
const projectId = randomUUID()

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), 'cc-data-bytes-')))
  vi.stubEnv('CC_DATA_DIR', join(dir, 'data'))
  outside = join(dir, 'outside.bin')
  writeFileSync(outside, Buffer.alloc(10_000))
})

afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

function plantRecovery(): string {
  const snap = join(worktreeRecoveryDir(sessionId), randomUUID())
  mkdirSync(snap, { recursive: true })
  writeFileSync(join(snap, 'snapshot.json'), Buffer.alloc(100))
  writeFileSync(join(snap, '0.patch'), Buffer.alloc(23))
  return snap
}

describe("a session's data folders are sized one way", () => {
  links('a link to nothing inside a recovery snapshot costs only itself, not the snapshot beside it', async () => {
    const snap = plantRecovery()
    symlinkSync(join(dir, 'gone'), join(snap, 'dangling'))

    expect(await worktreeRecoveryBytes(sessionId)).toBe(123)
  })

  links('a link out of a data folder is not followed: the file it points at is not the session\'s', async () => {
    const snap = plantRecovery()
    symlinkSync(outside, join(snap, 'out'))
    symlinkSync(dir, join(snap, 'out-dir'))
    const att = join(dir, 'data', 'attachments', sessionId)
    mkdirSync(att, { recursive: true })
    writeFileSync(join(att, 'shot.png'), Buffer.alloc(7))
    symlinkSync(outside, join(att, 'linked.png'))
    const note = handoffNotePath(projectId, sessionId)
    mkdirSync(join(note, '..'), { recursive: true })
    symlinkSync(outside, note)

    expect(await worktreeRecoveryBytes(sessionId)).toBe(123)
    expect(await attachmentBytes(sessionId)).toBe(7)
    expect(await handoffNoteBytes(projectId, sessionId)).toBe(0)
  })

  it('nested folders count, and a session with no folders takes nothing', async () => {
    expect(await worktreeRecoveryBytes(sessionId)).toBe(0)
    expect(await attachmentBytes(sessionId)).toBe(0)
    expect(await handoffNoteBytes(projectId, sessionId)).toBe(0)

    plantRecovery()
    plantRecovery()
    const note = handoffNotePath(projectId, sessionId)
    mkdirSync(join(note, '..'), { recursive: true })
    writeFileSync(note, 'hand over')
    expect(await worktreeRecoveryBytes(sessionId)).toBe(246)
    expect(await handoffNoteBytes(projectId, sessionId)).toBe(9)
  })
})
