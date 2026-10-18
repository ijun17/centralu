import { describe, expect, it } from 'vitest'
import type { Loaded } from '../../app/useLoad.js'
import { filesView, skillsView, SKILLS_NOT_READY, type FileAnswer, type Skills } from './autocompleteState.js'

const loaded = (over: Partial<Loaded<Skills>>): Loaded<Skills> => ({ data: undefined, error: null, loading: false, ...over })
const skills = (over: Partial<Skills> = {}): Skills => ({ sessionId: 's1', ready: true, commands: [], ...over })
const review = { name: 'review', description: '', argumentHint: '' }

describe('the / list: "loading", "not ready" and "failed" are three different things (#1143 U13)', () => {
  it('is loading until the first answer arrives', () => {
    expect(skillsView('s1', loaded({ loading: true }))).toEqual({ commands: [], loading: true, note: null })
  })

  it('shows what the host answered', () => {
    const v = skillsView('s1', loaded({ data: skills({ commands: [review] }) }))
    expect(v).toEqual({ commands: [review], loading: false, note: null })
  })

  it('says why when the read failed, instead of "Loading skills…" for ever', () => {
    const v = skillsView('s1', loaded({ error: 'timed out' }))
    expect(v.loading).toBe(false)
    expect(v.note).toBe('Could not load skills: timed out')
  })

  it('ends on a note when the tool answered that it is not ready, instead of "Loading skills…" for ever', () => {
    const v = skillsView('s1', loaded({ data: skills({ ready: false }) }))
    expect(v).toEqual({ commands: [], loading: false, note: SKILLS_NOT_READY })
  })

  it('is loading again while a re-ask is on its way, whatever the last answer was', () => {
    expect(skillsView('s1', loaded({ data: skills({ ready: false }), loading: true })).loading).toBe(true)
    expect(skillsView('s1', loaded({ error: 'timed out', loading: true })).loading).toBe(true)
  })

  it('keeps the list when only a refresh failed', () => {
    const v = skillsView('s1', loaded({ data: skills({ commands: [review] }), error: 'timed out' }))
    expect(v).toEqual({ commands: [review], loading: false, note: null })
  })

  it('never shows another session\'s list, for the frame before the load resets', () => {
    const v = skillsView('s2', loaded({ data: skills({ sessionId: 's1', commands: [review] }) }))
    expect(v.commands).toEqual([])
    expect(v.loading).toBe(true)
  })
})

describe('the @ file list: "failed" is not "no files" (#1143 U14)', () => {
  const answer = (over: Partial<FileAnswer> = {}): FileAnswer => ({
    key: 'p1\nfo',
    projectId: 'p1',
    query: 'fo',
    list: [],
    error: null,
    ...over,
  })
  const view = (over: Partial<Parameters<typeof filesView>[0]> = {}) =>
    filesView({ fileKey: 'p1\nfoo', projectId: 'p1', query: 'foo', answer: answer(), gaveUp: null, ...over })

  it('says the search failed, with its reason', () => {
    const v = view({ fileKey: 'p1\nfo', query: 'fo', answer: answer({ error: 'the host did not answer' }) })
    expect(v.list).toEqual([])
    expect(v.note).toBe('Could not search files: the host did not answer')
  })

  it('waits for the next search after a failed one, because a failure found nothing out', () => {
    const v = view({ answer: answer({ error: 'the host did not answer' }) })
    expect(v.stale).toBe(true)
  })

  it('does not wait for a longer query when the earlier search really found nothing', () => {
    expect(view({ answer: answer() }).stale).toBe(false)
  })

  it('waits for the answer to the query on screen, and does not pick the earlier one', () => {
    const file = { path: 'src/fo.ts', name: 'fo.ts' }
    const v = view({ answer: answer({ list: [file] }) })
    expect(v.stale).toBe(true)
    expect(v.list).toEqual([file])
  })

  it('stops waiting once the wait gave up, and shows nothing', () => {
    const v = view({ answer: answer({ list: [{ path: 'src/fo.ts', name: 'fo.ts' }] }), gaveUp: 'p1\nfoo' })
    expect(v).toEqual({ list: [], stale: false, note: null })
  })

  it('never shows another project\'s results', () => {
    const v = view({ projectId: 'p2', fileKey: 'p2\nfoo', answer: answer({ list: [{ path: 'src/fo.ts', name: 'fo.ts' }] }) })
    expect(v.list).toEqual([])
  })
})
