import { describe, expect, it } from 'vitest'
import {
  appGridPanel,
  appKeyOf,
  gridPanelKey,
  gridSessionIds,
  parseAppKey,
  sanitizeGridPanels,
  sessionGridPanel,
  visibleGridPanels,
  withPanelSpan,
} from './panels.js'

describe('grid panel keys', () => {
  it('a session keeps its id as its key, so the panels placed before apps existed keep theirs', () => {
    expect(gridPanelKey(sessionGridPanel('s1'))).toBe('s1')
  })

  it('an app is keyed by its project and id, and a user-folder app by the user scope', () => {
    expect(gridPanelKey(appGridPanel('p1', 'slider'))).toBe('app:p1/slider')
    expect(gridPanelKey(appGridPanel(null, 'slider'))).toBe('app:_user/slider')
  })

  it('two projects’ apps with the same id, and a session named like an app, are three panels', () => {
    const keys = [appGridPanel('p1', 'slider'), appGridPanel('p2', 'slider'), sessionGridPanel('slider')].map(
      gridPanelKey,
    )
    expect(new Set(keys).size).toBe(3)
  })

  it('an app key reads back as the pair it was made from', () => {
    expect(parseAppKey(appKeyOf('p1', 'slider'))).toEqual({ projectId: 'p1', appId: 'slider' })
    expect(parseAppKey(appKeyOf(null, 'slider'))).toEqual({ projectId: null, appId: 'slider' })
    for (const bad of ['', 'slider', '/slider', 'p1/']) expect(parseAppKey(bad)).toBeNull()
  })
})

describe('gridSessionIds', () => {
  it('lists only the sessions, in order', () => {
    expect(
      gridSessionIds([sessionGridPanel('b'), appGridPanel('p1', 'slider'), sessionGridPanel('a')]),
    ).toEqual(['b', 'a'])
  })
})

describe('visibleGridPanels', () => {
  it('leaves out a session or an app that does not exist right now, keeping the order of the rest', () => {
    const panels = [
      sessionGridPanel('gone'),
      appGridPanel('p1', 'slider'),
      sessionGridPanel('a'),
      appGridPanel('p1', 'removed'),
      appGridPanel(null, 'notes'),
    ]
    const shown = visibleGridPanels(
      panels,
      new Set(['a']),
      new Set([appKeyOf('p1', 'slider'), appKeyOf(null, 'notes')]),
    )
    expect(shown.map(gridPanelKey)).toEqual(['app:p1/slider', 'a', 'app:_user/notes'])
  })

  it('does not take one project’s app for another’s with the same id', () => {
    expect(
      visibleGridPanels([appGridPanel('p2', 'slider')], new Set(), new Set([appKeyOf('p1', 'slider')])),
    ).toEqual([])
  })
})

describe('sanitizeGridPanels', () => {
  it('reads a list of bare session ids — what the grid stored before apps — as session panels', () => {
    expect(sanitizeGridPanels(['s3', 's1'])).toEqual([sessionGridPanel('s3'), sessionGridPanel('s1')])
  })

  it('keeps well-formed references of both kinds, a user-folder app included', () => {
    const list = [sessionGridPanel('s1'), appGridPanel('p1', 'slider'), appGridPanel(null, 'notes')]
    expect(sanitizeGridPanels(list)).toEqual(list)
  })

  it('drops what is not a reference and keeps the first place of a panel named twice', () => {
    expect(
      sanitizeGridPanels([
        's1',
        null,
        42,
        '',
        { kind: 'app', appId: 'slider' },
        { kind: 'app', projectId: '', appId: 'slider' },
        { kind: 'app', projectId: 'p1', appId: '' },
        { kind: 'session' },
        { kind: 'widget', id: 'x' },
        { kind: 'app', projectId: 'p1', appId: 'slider' },
        { kind: 'session', sessionId: 's1' },
        { kind: 'app', projectId: 'p1', appId: 'slider' },
      ]),
    ).toEqual([sessionGridPanel('s1'), appGridPanel('p1', 'slider')])
  })

  it('answers an empty list for something that is not a list at all', () => {
    for (const raw of [undefined, null, 'x', {}, 3]) expect(sanitizeGridPanels(raw)).toEqual([])
  })
})

// #306: an app panel's span rides on its placement, and only an app panel has one
describe('an app panel’s span', () => {
  it('survives sanitizing, clamped; one that is not a span reads as none chosen', () => {
    expect(
      sanitizeGridPanels([
        { kind: 'app', projectId: 'p1', appId: 'board', span: { cols: 2, rows: 1 } },
        { kind: 'app', projectId: null, appId: 'wide', span: { cols: 9, rows: 1 } },
        { kind: 'app', projectId: null, appId: 'odd', span: { cols: 'two', rows: 1 } },
        { kind: 'session', sessionId: 's1', span: { cols: 2, rows: 1 } },
      ]),
    ).toEqual([
      { kind: 'app', projectId: 'p1', appId: 'board', span: { cols: 2, rows: 1 } },
      { kind: 'app', projectId: null, appId: 'wide', span: { cols: 4, rows: 1 } },
      { kind: 'app', projectId: null, appId: 'odd' },
      { kind: 'session', sessionId: 's1' },
    ])
  })

  it('withPanelSpan sets or clears one app panel’s span and leaves every other panel as it was', () => {
    const list = [sessionGridPanel('s1'), appGridPanel('p1', 'board'), appGridPanel(null, 'notes')]
    const set = withPanelSpan(list, 'app:p1/board', { cols: 2, rows: 1 })
    expect(set).toEqual([
      sessionGridPanel('s1'),
      { ...appGridPanel('p1', 'board'), span: { cols: 2, rows: 1 } },
      appGridPanel(null, 'notes'),
    ])
    expect(withPanelSpan(set, 'app:p1/board', null)).toEqual(list)
    // A session's key changes nothing: a session panel is always 1 × 1
    expect(withPanelSpan(list, 's1', { cols: 2, rows: 1 })).toEqual(list)
  })
})
