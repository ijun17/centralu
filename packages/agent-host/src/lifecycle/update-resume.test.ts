import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseUpdateResume, recordUpdateCut, UpdateResumeLists, type UpdateResumeFolder } from './update-resume.js'
import { memoryUpdateFolder } from './update-resume.test-helpers.js'

/**
 * The data folder's lists of the turns an update cut (#1618): each written by a host an update stops, as it stops, and read
 * by the next. A turn is the one that stop cut by its mark (where its conversation ended then), not by its session alone,
 * and a list goes only once every turn it names was dealt with, so no stop or failed start in between loses one. The folder
 * is played by a map here; endings.test.ts reaches the real one.
 */
afterEach(() => vi.restoreAllMocks())

describe('the turns an update cut, in the data folder', () => {
  it('a stop writes the turns it ends; the next start reads them without taking them, and a list goes once all it names are dealt with', () => {
    const f = memoryUpdateFolder()
    recordUpdateCut(f, [{ id: 's1', seq: 4 }, { id: 's2', seq: 9 }])
    const lists = new UpdateResumeLists(f)
    expect([...lists.ids()]).toEqual(['s1', 's2'])
    // Read again (a start that failed its check, before anything was sent): still all there
    expect([...new UpdateResumeLists(f).ids()]).toEqual(['s1', 's2'])
    lists.done('s1')
    expect(f.ids()).toEqual(['s1', 's2'])
    lists.done('s2')
    expect(f.ids()).toBeNull()
  })

  it('a listed session is the turn that stop cut only while its conversation still ends where it did then (#1626 review)', () => {
    const f = memoryUpdateFolder()
    recordUpdateCut(f, [{ id: 's1', seq: 4 }])
    const lists = new UpdateResumeLists(f)
    expect(lists.cut('s1', 4)).toBe(true)
    // A turn begun since, under any version, recorded its input first
    expect(lists.cut('s1', 5)).toBe(false)
    expect(lists.cut('s2', 4)).toBe(false)
  })

  it('a second stop writes its own list beside the first, never replacing it: none is continued zero times (#1618 review D2)', () => {
    const f = memoryUpdateFolder()
    recordUpdateCut(f, [{ id: 's1', seq: 4 }, { id: 's2', seq: 9 }])
    // The next host was stopped again before it continued either, with s3 running too
    recordUpdateCut(f, [{ id: 's1', seq: 4 }, { id: 's2', seq: 9 }, { id: 's3', seq: 2 }])
    expect(f.files.size).toBe(2)
    const lists = new UpdateResumeLists(f)
    expect([...lists.ids()]).toEqual(['s1', 's2', 's3'])
    lists.done('s1')
    lists.done('s2')
    // The first list is dealt with; the second still names s3
    expect(f.files.size).toBe(1)
    lists.done('s3')
    expect(f.files.size).toBe(0)
  })

  it('a list that cannot be removed (held open) stays harmless and goes at a later start (#1626 review)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const f = memoryUpdateFolder()
    recordUpdateCut(f, [{ id: 's1', seq: 4 }])
    const remove = f.remove
    f.remove = () => {
      throw new Error('EBUSY: resource busy or locked')
    }
    new UpdateResumeLists(f).done('s1')
    expect(f.files.size).toBe(1)
    f.remove = remove
    // The next start finds s1's conversation further on: not that turn, so nothing to continue, and the list goes
    const later = new UpdateResumeLists(f)
    expect(later.cut('s1', 12)).toBe(false)
    later.done('s1')
    expect(f.files.size).toBe(0)
  })

  it('a stop that ends no turn writes no list', () => {
    const f = memoryUpdateFolder()
    recordUpdateCut(f, [])
    expect(f.files.size).toBe(0)
  })

  it('does not expire: the next start continues them whenever it comes, on whichever clock', () => {
    const f = memoryUpdateFolder()
    f.files.set('update-resume.old.json', JSON.stringify({ v: 1, at: 0, turns: [{ id: 's1', seq: 3 }] }))
    expect(new UpdateResumeLists(f).cut('s1', 3)).toBe(true)
  })

  it('a list a host killed mid-write left goes at the next start; one of another format is left to the host that wrote it', () => {
    const f = memoryUpdateFolder()
    f.files.set('update-resume.torn.json', '{"v":1,"turns":[{"id":"s1","se')
    f.files.set('update-resume.empty.json', '')
    f.files.set('update-resume.newer.json', JSON.stringify({ v: 2, turns: [{ id: 's2', seq: 1 }] }))
    expect([...new UpdateResumeLists(f).ids()]).toEqual([])
    expect([...f.files.keys()]).toEqual(['update-resume.newer.json'])
  })

  it('reads only turns: ids that are ids, marks that are row numbers', () => {
    expect(parseUpdateResume(JSON.stringify({ v: 2, turns: [] }))).toBe('other')
    expect(parseUpdateResume(JSON.stringify({ v: 1, ids: ['s1'] }))).toBe('other')
    expect(parseUpdateResume('{"v":1,')).toBe('torn')
    const turns = [{ id: 's1', seq: 1 }, { id: 7, seq: 1 }, { id: '../x y', seq: 1 }, { id: 's2', seq: -1 }, { id: 's3', seq: 1.5 }, { id: 's4' }, null, { id: 's5', seq: 0 }]
    expect(parseUpdateResume(JSON.stringify({ v: 1, turns }))).toEqual([{ id: 's1', seq: 1 }, { id: 's5', seq: 0 }])
  })

  it('a folder it cannot write in or read from loses the lists, never the stop or the start, and says why', () => {
    const said = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken: UpdateResumeFolder = {
      names: () => {
        throw new Error('EACCES: permission denied')
      },
      read: () => {
        throw new Error('EACCES')
      },
      add: () => {
        throw new Error('ENOSPC: no space left on device')
      },
      remove: () => {
        throw new Error('EACCES')
      },
    }
    expect(() => recordUpdateCut(broken, [{ id: 's1', seq: 1 }])).not.toThrow()
    expect(said.mock.calls.some((c) => String(c[0]).includes('ENOSPC: no space left on device'))).toBe(true)
    const lists = new UpdateResumeLists(broken)
    expect([...lists.ids()]).toEqual([])
    expect(() => lists.done('s1')).not.toThrow()
  })
})
