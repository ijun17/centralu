import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handoffNoteDir, handoffNotePath, sweepHandoffNotes, writeHandoffNote } from './handoff-notes.js'

/**
 * 인수인계 노트의 자리 (#142) — 데이터 폴더 아래 `handoff/<프로젝트 id>/<세션 id>.md`.
 * 두 id가 모두 경로 조각이 되므로, 조각 하나가 아닌 것은 자리를 얻지 못한다.
 */
let data: string
let prev: string | undefined
beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'cc-handoff-notes-'))
  prev = process.env.CC_DATA_DIR
  process.env.CC_DATA_DIR = data
})
afterEach(() => {
  process.env.CC_DATA_DIR = prev
  rmSync(data, { recursive: true, force: true })
})

describe('노트의 자리 (#142)', () => {
  it('데이터 폴더 아래, 프로젝트마다 한 폴더, 세션마다 한 파일', async () => {
    const path = await writeHandoffNote('p1', 's1', '노트')
    expect(path).toBe(join(data, 'handoff', 'p1', 's1.md'))
    expect(handoffNotePath('p1', 's1')).toBe(path)
    expect(readFileSync(path, 'utf8')).toBe('노트')
  })

  it('경로인 id는 자리를 얻지 못한다 — 프로젝트 id도 세션 id도', () => {
    expect(() => handoffNoteDir('../../Documents')).toThrow(/Not a project id/)
    expect(() => handoffNotePath('p1', '../../../.ssh/authorized_keys')).toThrow(/Not a session id/)
    expect(() => handoffNotePath('..', 's1')).toThrow(/Not a project id/)
  })

  it('청소는 링크를 따라가지 않는다 — 폴더 자리의 링크도, 파일 자리의 링크도', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cc-handoff-outside-'))
    try {
      writeFileSync(join(outside, 'NOTES.md'), '밖의 글')
      await writeHandoffNote('p1', 'gone', '주인 없는 글')
      // 누군가 데이터 폴더 안에 링크를 놓았다 — 프로젝트 폴더 자리에 하나, 노트 자리에 하나
      mkdirSync(join(data, 'handoff'), { recursive: true })
      symlinkSync(outside, join(data, 'handoff', 'p2'))
      symlinkSync(join(outside, 'NOTES.md'), join(data, 'handoff', 'p1', 'link.md'))

      await sweepHandoffNotes(() => false)
      expect(existsSync(join(data, 'handoff', 'p1', 'gone.md'))).toBe(false) // 고아는 걷혔다
      expect(readdirSync(outside)).toEqual(['NOTES.md']) // 링크 너머는 그대로다
      expect(readFileSync(join(outside, 'NOTES.md'), 'utf8')).toBe('밖의 글')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
