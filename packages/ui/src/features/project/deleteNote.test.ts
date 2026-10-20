import { describe, expect, it } from 'vitest'
import { CHECKING, folderNote } from './deleteNote.js'

const LEFT_ALONE = 'The folder on disk is left alone.'

/**
 * What the Delete project dialog says of the folder (#1301): an ordinary project's folder is left alone, while the host may move a
 * folder of the user folder registered in place to app-trash/ once nothing can restore the project (#1204). Never put as certain, a
 * project inside an app folder is not called one, a path that could not be checked is said so, and nothing is said on a guess.
 */
describe('the Delete project dialog\'s sentence about the folder', () => {
  it('is today\'s for an ordinary project, and for one from a host that does not send the mark or the answer', () => {
    expect(folderNote({})).toBe(LEFT_ALONE)
    expect(folderNote({ fromUserFolder: false })).toBe(LEFT_ALONE)
    expect(folderNote({}, null)).toBe(LEFT_ALONE)
    // And for what the host says stays, marked or not
    expect(folderNote({ fromUserFolder: true }, 'stays')).toBe(LEFT_ALONE)
  })

  it('goes by the mark from a host without the call (null)', () => {
    const note = folderNote({ fromUserFolder: true })
    expect(note).toContain('app-trash/')
    expect(note).toContain('The host may move the folder')
    expect(folderNote({ fromUserFolder: true }, null)).toBe(note)
  })

  it('says only that it is checking while the host\'s answer is on its way, marked or not', () => {
    expect(folderNote({}, 'pending')).toBe(CHECKING)
    expect(folderNote({ fromUserFolder: true }, 'pending')).toBe(CHECKING)
  })

  it('says for an app folder that the host may move it, when, where to, that nothing is deleted, and what putting it back is', () => {
    const note = folderNote({}, 'may_move')
    expect(note).not.toContain('left alone')
    // Never a certainty
    expect(note).toContain('The host may move the folder to app-trash/')
    expect(note).not.toMatch(/the host moves/i)
    // When: nothing in Centralu's session archive that could bring the project back, nothing else at the folder
    expect(note).toContain('when no session that could bring the project back is left in Centralu’s session archive and no other project is at the folder')
    expect(note).toContain('data folder of the computer it is on')
    // And that nothing is lost, and what coming back is
    expect(note).toContain('Nothing is deleted')
    expect(note).toContain('under its app id')
    expect(note).toContain('as a new project with its data, logs and versions')
    expect(note).toContain('secrets and grants are not kept')
  })

  it('does not call a project inside an app folder one: its own folder is left alone, the folder around it may move', () => {
    const note = folderNote({ fromUserFolder: true }, 'around_may_move')
    expect(note).toContain('This project lies inside an app folder')
    expect(note).not.toContain('This project is an app folder')
    expect(note).toContain('leaves its own folder alone')
    expect(note).toContain('the host may move the app folder around it to app-trash/')
    expect(note).toContain('when no project is left at or inside that folder')
    expect(note).toContain('Nothing is deleted')
  })

  it('says it could not check where the project\'s folder is, and does not call it an app folder', () => {
    const note = folderNote({}, 'unsure')
    expect(note).toContain('could not check where this project’s folder is')
    expect(note).toContain('If it is an app folder')
    expect(note).not.toContain('This project is an app folder')
    expect(note).toContain('may move')
    expect(note).toContain('Nothing is deleted')
  })

  it('the host\'s answer outranks the mark: a marked project the host says stays gets the ordinary sentence, an unmarked one that may move does not', () => {
    expect(folderNote({ fromUserFolder: true }, 'stays')).toBe(LEFT_ALONE)
    expect(folderNote({}, 'may_move')).toContain('app-trash/')
  })
})
