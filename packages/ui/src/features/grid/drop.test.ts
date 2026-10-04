import { describe, expect, it } from 'vitest'
import { appGridPanel, sessionGridPanel } from '@cc/core'
import { APP_MIME, PANEL_MIME, SESSION_MIME, projectItemMime } from '../sidebar/reorder.js'
import { droppedGridList, droppedGridPanel, gridTakes } from './drop.js'

/** The data of a drop, as `DataTransfer.getData` hands it out — '' for a type the drag does not carry */
const carrying = (data: Record<string, string>) => (type: string) => data[type] ?? ''

const apps = new Map([
  ['p1/slider', { projectId: 'p1', appId: 'slider' }],
  ['_user/notes', { projectId: null, appId: 'notes' }],
])

describe('gridTakes', () => {
  it('answers a session or an app being dragged, a user-folder app with no project type included', () => {
    expect(gridTakes([SESSION_MIME, projectItemMime('p1')])).toBe(true)
    expect(gridTakes([APP_MIME, projectItemMime('p1')])).toBe(true)
    expect(gridTakes([APP_MIME])).toBe(true)
  })

  it('leaves anything else to its owner: a file, a project-screen panel without a session, a path', () => {
    expect(gridTakes(['Files'])).toBe(false)
    expect(gridTakes([PANEL_MIME])).toBe(false)
    expect(gridTakes(['application/x-cc-path'])).toBe(false)
  })
})

describe('droppedGridPanel', () => {
  it('reads a live session and an app the list has, from any project or none', () => {
    expect(droppedGridPanel(carrying({ [SESSION_MIME]: 's1' }), new Set(['s1']), apps)).toEqual(
      sessionGridPanel('s1'),
    )
    expect(droppedGridPanel(carrying({ [APP_MIME]: 'p1/slider' }), new Set(), apps)).toEqual(
      appGridPanel('p1', 'slider'),
    )
    expect(droppedGridPanel(carrying({ [APP_MIME]: '_user/notes' }), new Set(), apps)).toEqual(
      appGridPanel(null, 'notes'),
    )
  })

  it('takes nothing the grid could not draw: a session that is gone, an app the list does not have', () => {
    expect(droppedGridPanel(carrying({ [SESSION_MIME]: 'gone' }), new Set(['s1']), apps)).toBeNull()
    expect(droppedGridPanel(carrying({ [APP_MIME]: 'p2/slider' }), new Set(), apps)).toBeNull()
    expect(droppedGridPanel(carrying({ 'text/plain': 'p1/slider' }), new Set(), apps)).toBeNull()
  })
})

describe('droppedGridList', () => {
  const s1 = sessionGridPanel('s1')
  const s2 = sessionGridPanel('s2')
  const slider = appGridPanel('p1', 'slider')

  it('places a new app before or after the panel it lands on, or at the end on the padding', () => {
    expect(droppedGridList([s1, s2], slider, 's2', true)).toEqual([s1, slider, s2])
    expect(droppedGridList([s1, s2], slider, 's1', false)).toEqual([s1, slider, s2])
    expect(droppedGridList([s1, s2], slider, null, false)).toEqual([s1, s2, slider])
  })

  it('moves an app already there, and leaves it where it is when it lands on the padding', () => {
    expect(droppedGridList([slider, s1, s2], slider, 's2', false)).toEqual([s1, s2, slider])
    expect(droppedGridList([slider, s1, s2], appGridPanel('p1', 'slider'), null, false)).toEqual([
      slider,
      s1,
      s2,
    ])
  })

  it('moves a session against an app the same way', () => {
    expect(droppedGridList([slider, s1], s1, 'app:p1/slider', true)).toEqual([s1, slider])
  })
})
