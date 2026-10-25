import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handoffNoteDir, handoffNotePath, sweepHandoffNotes, writeHandoffNote, writeHandoffNoteSync } from './handoff-notes.js'
import { itSymlink, linkDir } from '../link.test-helpers.js'

/**
 * Where a handoff note lives (#142) — under the data folder at
 * `handoff/<project id>/<session id>.md`. Both ids become a path segment, so anything that is not
 * exactly one segment is denied a spot.
 */
let data: string
beforeEach(() => {
  data = mkdtempSync(join(tmpdir(), 'cc-handoff-notes-'))
  vi.stubEnv('CC_DATA_DIR', data)
})
afterEach(() => {
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

  itSymlink('cleanup never follows a link — whether it sits at the folder\'s spot or the file\'s', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cc-handoff-outside-'))
    try {
      writeFileSync(join(outside, 'NOTES.md'), 'outside text')
      await writeHandoffNote('p1', 'gone', 'orphaned text')
      // Someone placed a link inside the data folder — one at the project folder's spot, one at the note's spot
      mkdirSync(join(data, 'handoff'), { recursive: true })
      linkDir(outside, join(data, 'handoff', 'p2'))
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

describe('a note written over a link (#850)', () => {
  /*
   * The note's spot is cleared with the data folder's removal (recursive, so Node honours its Windows retries). A link
   * sitting there must go as itself: what it points at is not the host's to delete.
   */
  it.skipIf(process.platform === 'win32')('removes a link to a folder at the note spot, never the folder it points at', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cc-handoff-outside-'))
    try {
      writeFileSync(join(outside, 'keep.txt'), 'keep')
      mkdirSync(handoffNoteDir('p1'), { recursive: true })
      linkDir(outside, handoffNotePath('p1', 's1'))
      await writeHandoffNote('p1', 's1', 'async')
      expect(readFileSync(handoffNotePath('p1', 's1'), 'utf8')).toBe('async')
      rmSync(handoffNotePath('p1', 's1'))
      linkDir(outside, handoffNotePath('p1', 's1'))
      writeHandoffNoteSync('p1', 's1', 'sync')
      expect(readFileSync(handoffNotePath('p1', 's1'), 'utf8')).toBe('sync')
      expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
