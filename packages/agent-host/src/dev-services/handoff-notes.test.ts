import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handoffNoteDir, handoffNotePath, sweepHandoffNotes, writeHandoffNote } from './handoff-notes.js'

/**
 * Where a handoff note lives (#142) — under the data folder at
 * `handoff/<project id>/<session id>.md`. Both ids become a path segment, so anything that is not
 * exactly one segment is denied a spot.
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

describe('where a note lives (#142)', () => {
  it('under the data folder, one folder per project, one file per session', async () => {
    const path = await writeHandoffNote('p1', 's1', 'note')
    expect(path).toBe(join(data, 'handoff', 'p1', 's1.md'))
    expect(handoffNotePath('p1', 's1')).toBe(path)
    expect(readFileSync(path, 'utf8')).toBe('note')
  })

  it('an id that is a path is denied a spot — neither the project id nor the session id', () => {
    expect(() => handoffNoteDir('../../Documents')).toThrow(/Not a project id/)
    expect(() => handoffNotePath('p1', '../../../.ssh/authorized_keys')).toThrow(/Not a session id/)
    expect(() => handoffNotePath('..', 's1')).toThrow(/Not a project id/)
  })

  it('cleanup never follows a link — whether it sits at the folder\'s spot or the file\'s', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cc-handoff-outside-'))
    try {
      writeFileSync(join(outside, 'NOTES.md'), 'outside text')
      await writeHandoffNote('p1', 'gone', 'orphaned text')
      // Someone placed a link inside the data folder — one at the project folder's spot, one at the note's spot
      mkdirSync(join(data, 'handoff'), { recursive: true })
      symlinkSync(outside, join(data, 'handoff', 'p2'))
      symlinkSync(join(outside, 'NOTES.md'), join(data, 'handoff', 'p1', 'link.md'))

      await sweepHandoffNotes(() => false)
      expect(existsSync(join(data, 'handoff', 'p1', 'gone.md'))).toBe(false) // the orphan was removed
      expect(readdirSync(outside)).toEqual(['NOTES.md']) // what is past the link is untouched
      expect(readFileSync(join(outside, 'NOTES.md'), 'utf8')).toBe('outside text')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
