import { describe, expect, it } from 'vitest'
import { folderNote } from './deleteNote.js'

/**
 * What the Delete project dialog says of the folder (#1301): an ordinary project's folder is left alone, while a folder of the
 * user folder registered in place is moved to app-trash/ by the host once nothing can restore the project (#1204).
 */
describe('the Delete project dialog\'s sentence about the folder', () => {
  it('is today\'s for an ordinary project, and for one from a host that does not send the mark', () => {
    expect(folderNote({})).toBe('The folder on disk is left alone.')
    expect(folderNote({ fromUserFolder: false })).toBe('The folder on disk is left alone.')
  })

  it('says for an app folder of the user folder when it moves, where to, that nothing is deleted, and how to bring it back', () => {
    const note = folderNote({ fromUserFolder: true })
    expect(note).not.toContain('left alone')
    // When: nothing in Centralu's trash or at the folder needs it any more
    expect(note).toContain('none of its sessions left in Centralu’s trash')
    expect(note).toContain('no other project at the folder')
    // Where to
    expect(note).toContain('app-trash/')
    expect(note).toContain('data folder of the computer it is on')
    // And that nothing is lost, and what coming back is
    expect(note).toContain('Nothing is deleted')
    expect(note).toContain('under its app id')
    expect(note).toContain('as a new project with its data, logs and versions')
    expect(note).toContain('secrets and grants are not kept')
  })
})
