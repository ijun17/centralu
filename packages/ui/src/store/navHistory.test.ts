import { describe, expect, it } from 'vitest'
import { closeLayer, EMPTY_NAV, NAV_LIMIT, sameScreen, step, visit, type NavHistory, type Screen } from './navHistory.js'

const session = (id: string): Screen => ({ kind: 'session', id })
const grid: Screen = { kind: 'grid' }
const settings: Screen = { kind: 'settings' }
const all = () => true
const of = (...screens: Screen[]): NavHistory => screens.reduce(visit, EMPTY_NAV)

describe('navigation history (#374)', () => {
  it('records each new screen and folds a repeat of the current one', () => {
    const h = of(session('a'), session('a'), grid, grid)
    expect(h).toEqual({ entries: [session('a'), grid], index: 1 })
  })

  it('tells apps apart by project and id', () => {
    expect(sameScreen({ kind: 'app', projectId: 'p', appId: 'x' }, { kind: 'app', projectId: null, appId: 'x' })).toBe(false)
    expect(sameScreen({ kind: 'app', projectId: 'p', appId: 'x' }, { kind: 'app', projectId: 'p', appId: 'x' })).toBe(true)
  })

  it('goes back and forward, and a new visit drops what was ahead', () => {
    const h = of(session('a'), session('b'), session('c'))
    const back = step(h, -1, all)
    expect(back.screen).toEqual(session('b'))
    const forward = step(back.history, 1, all)
    expect(forward.screen).toEqual(session('c'))
    const branched = visit(back.history, grid)
    expect(branched.entries).toEqual([session('a'), session('b'), grid])
    expect(step(branched, 1, all).screen).toBeNull()
  })

  it('has nowhere to go at either end', () => {
    expect(step(EMPTY_NAV, -1, all).screen).toBeNull()
    expect(step(of(session('a')), -1, all).screen).toBeNull()
    expect(step(of(session('a')), 1, all).screen).toBeNull()
  })

  it('skips and drops a screen that is gone, in both directions', () => {
    const exists = (s: Screen) => !sameScreen(s, session('gone'))
    const h = of(session('a'), session('gone'), session('b'))
    const back = step(h, -1, exists)
    expect(back.screen).toEqual(session('a'))
    expect(back.history).toEqual({ entries: [session('a'), session('b')], index: 0 })

    const fromStart = { entries: [session('a'), session('gone'), session('b')], index: 0 }
    const forward = step(fromStart, 1, exists)
    expect(forward.screen).toEqual(session('b'))
    expect(forward.history).toEqual({ entries: [session('a'), session('b')], index: 1 })
  })

  it('skips an entry equal to the current one, left behind when a screen between them went', () => {
    const exists = (s: Screen) => !sameScreen(s, session('gone'))
    const h = of(session('a'), grid, session('gone'), grid)
    const back = step(h, -1, exists)
    expect(back.screen).toEqual(session('a'))
  })

  it('keeps the newest entries past the limit', () => {
    const h = of(...Array.from({ length: NAV_LIMIT + 10 }, (_, i) => session(String(i))))
    expect(h.entries).toHaveLength(NAV_LIMIT)
    expect(h.entries[0]).toEqual(session('10'))
    expect(h.index).toBe(NAV_LIMIT - 1)
  })

  it('closing Settings steps back to the screen under it, and forward reopens it', () => {
    const h = closeLayer(of(session('a'), settings), session('a'))
    expect(h).toEqual({ entries: [session('a'), settings], index: 0 })
    expect(step(h, 1, all).screen).toEqual(settings)
  })

  it('closing Settings onto another screen is an ordinary visit', () => {
    const h = closeLayer(of(session('a'), settings), session('b'))
    expect(h.entries).toEqual([session('a'), settings, session('b')])
  })
})

describe('a file and the git screen as pages', () => {
  const file = (path: string, under: Screen | null = session('a')): Screen => ({ kind: 'file', path, projectId: 'p', under })
  const git = (sub: 'changes' | 'history' | 'branches', sha: string | null = null, under: Screen | null = session('a')): Screen => ({
    kind: 'git',
    sub,
    path: null,
    sha,
    staged: null,
    under,
  })

  it('tells files apart by path and project, not by the screen under them', () => {
    expect(sameScreen(file('a.ts'), file('a.ts', grid))).toBe(true)
    expect(sameScreen(file('a.ts'), file('b.ts'))).toBe(false)
    expect(sameScreen(file('a.ts'), { kind: 'file', path: 'a.ts', projectId: null, under: null })).toBe(false)
  })

  it('tells git screens apart by what they show', () => {
    expect(sameScreen(git('changes'), git('changes', null, grid))).toBe(true)
    expect(sameScreen(git('history', 'abc'), git('history', 'def'))).toBe(false)
    expect(sameScreen(git('changes'), git('branches'))).toBe(false)
  })

  it('closing a file or the git screen steps back to the screen under it, so forward reopens it', () => {
    for (const layer of [file('a.ts'), git('history', 'abc')]) {
      const h = of(session('a'), layer)
      const closed = closeLayer(h, session('a'))
      expect(closed).toEqual({ entries: [session('a'), layer], index: 0 })
      expect(step(closed, 1, all).screen).toEqual(layer)
    }
  })

  it('closing one onto another screen than the one before it is an ordinary visit', () => {
    const h = of(session('a'), file('a.ts'))
    expect(closeLayer(h, grid)).toEqual({ entries: [session('a'), file('a.ts'), grid], index: 2 })
  })
})
