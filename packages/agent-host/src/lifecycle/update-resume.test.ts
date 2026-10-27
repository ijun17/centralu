import { afterEach, describe, expect, it, vi } from 'vitest'
import { dropFromUpdateResume, parseUpdateResume, readUpdateResume, recordUpdateCut, type UpdateResumeFile } from './update-resume.js'

/**
 * The data folder's list of the turns an update cut (#1618): written by the host an update stops, as it stops, and read by
 * the next. Each id leaves it only once its turn was dealt with, so no stop or failed start in between loses one, and a
 * second stop adds to it rather than replacing it. The folder is played by a variable here; stopped-mark.ts reaches the
 * real one.
 */
afterEach(() => vi.restoreAllMocks())

/** A data folder holding the file's text, or none */
function folder(text?: string): UpdateResumeFile & { text(): string | undefined } {
  let held = text
  return {
    read: () => held ?? null,
    write: (t) => {
      held = t
    },
    remove: () => {
      held = undefined
    },
    text: () => held,
  }
}

describe('the turns an update cut, in the data folder', () => {
  it('a stop writes the turns it ends; the next start reads them without taking them, and each leaves once dealt with', () => {
    const f = folder()
    recordUpdateCut(f, ['s1', 's2'])
    expect([...readUpdateResume(f)]).toEqual(['s1', 's2'])
    // Read again (a start that failed its check, before anything was sent): still all there
    expect([...readUpdateResume(f)]).toEqual(['s1', 's2'])
    dropFromUpdateResume(f, 's1')
    expect([...readUpdateResume(f)]).toEqual(['s2'])
    dropFromUpdateResume(f, 's2')
    // The last one takes the file with it
    expect(f.text()).toBeUndefined()
  })

  it('a second stop before the turns were continued adds its own to them: none is continued zero times (#1618 review D2)', () => {
    const f = folder()
    recordUpdateCut(f, ['s1', 's2'])
    // The next host continued s1, then was stopped again (a rollback, a second update) with s1's continued turn and s3 running
    dropFromUpdateResume(f, 's1')
    recordUpdateCut(f, ['s1', 's3'])
    expect([...readUpdateResume(f)]).toEqual(['s2', 's1', 's3'])
  })

  it('a stop that ends no turn leaves the list as it was, and writes no file where there was none', () => {
    const f = folder()
    recordUpdateCut(f, [])
    expect(f.text()).toBeUndefined()
    recordUpdateCut(f, ['s1'])
    recordUpdateCut(f, [])
    expect([...readUpdateResume(f)]).toEqual(['s1'])
  })

  it('does not expire: the next start continues them whenever it comes, on whichever clock', () => {
    const f = folder(JSON.stringify({ v: 1, at: 0, ids: ['s1'] }))
    expect([...readUpdateResume(f)]).toEqual(['s1'])
  })

  it('reads nothing from another format, text that is not JSON, or ids that are not ids', () => {
    expect(parseUpdateResume(JSON.stringify({ v: 2, ids: ['s1'] }))).toEqual([])
    expect(parseUpdateResume('{"v":1,')).toEqual([])
    expect(parseUpdateResume(null)).toEqual([])
    expect(parseUpdateResume(JSON.stringify({ v: 1, ids: ['s1', 7, null, '', '../x y', 's2', 's1'] }))).toEqual(['s1', 's2'])
  })

  it('a folder it cannot write in or read from loses the list, never the stop or the start', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken: UpdateResumeFile = {
      read: () => {
        throw new Error('EACCES')
      },
      write: () => {
        throw new Error('EACCES')
      },
      remove: () => {
        throw new Error('EACCES')
      },
    }
    expect(() => recordUpdateCut(broken, ['s1'])).not.toThrow()
    expect([...readUpdateResume(broken)]).toEqual([])
    expect(() => dropFromUpdateResume(broken, 's1')).not.toThrow()
  })
})
