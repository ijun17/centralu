import { describe, expect, it } from 'vitest'
import {
  activateTab,
  defaultLayout,
  moveTab,
  moveTabToGroupEnd,
  sanitizeLayout,
  splitTab,
  type PanelGroup,
} from './panelLayout.js'

const one = (): PanelGroup[] => [{ tabs: ['git', 'history', 'files', 'terminal'], active: 'git' }]
const split = (): PanelGroup[] => [
  { tabs: ['git', 'history', 'files'], active: 'git' },
  { tabs: ['terminal'], active: 'terminal' },
]

describe('moveTab', () => {
  it('reorders within a group and makes the dragged tab active — you dropped it to look at it', () => {
    expect(moveTab(one(), 'terminal', 'git', true)).toEqual([
      { tabs: ['terminal', 'git', 'history', 'files'], active: 'terminal' },
    ])
  })

  it('self-drop and unknown targets change nothing (same contract as sidebar moveTo)', () => {
    expect(moveTab(one(), 'git', 'git', true)).toEqual(one())
    expect(moveTab(split(), 'terminal', 'terminal', false)).toEqual(split())
  })

  it('moves across groups, landing before/after the target', () => {
    expect(moveTab(split(), 'files', 'terminal', false)).toEqual([
      { tabs: ['git', 'history'], active: 'git' },
      { tabs: ['terminal', 'files'], active: 'files' },
    ])
  })

  it('dragging the bottom group‘s last tab to the top strip dissolves the split', () => {
    expect(moveTab(split(), 'terminal', 'history', true)).toEqual([
      { tabs: ['git', 'terminal', 'history', 'files'], active: 'terminal' },
    ])
  })

  it('a group whose active tab left shows its first remaining one', () => {
    const g: PanelGroup[] = [
      { tabs: ['git', 'history'], active: 'history' },
      { tabs: ['files', 'terminal'], active: 'files' },
    ]
    expect(moveTab(g, 'history', 'files', true)).toEqual([
      { tabs: ['git'], active: 'git' },
      { tabs: ['history', 'files', 'terminal'], active: 'history' },
    ])
  })
})

describe('splitTab', () => {
  it('first split moves the tab into a new bottom group', () => {
    expect(splitTab(one(), 'terminal')).toEqual(split())
  })

  it('with a split open, another drop joins the existing bottom group — two groups is the cap', () => {
    expect(splitTab(split(), 'files')).toEqual([
      { tabs: ['git', 'history'], active: 'git' },
      { tabs: ['terminal', 'files'], active: 'files' },
    ])
  })

  it('the only tab of the only group cannot split — nothing would be left on top', () => {
    const solo: PanelGroup[] = [{ tabs: ['git'], active: 'git' }]
    expect(splitTab(solo, 'git')).toEqual(solo)
  })
})

describe('moveTabToGroupEnd', () => {
  it('appends to the group and activates there', () => {
    expect(moveTabToGroupEnd(split(), 'git', 1)).toEqual([
      { tabs: ['history', 'files'], active: 'history' },
      { tabs: ['terminal', 'git'], active: 'git' },
    ])
  })

  it('dropping the bottom group‘s last tab on the top strip closes the split', () => {
    expect(moveTabToGroupEnd(split(), 'terminal', 0)).toEqual([
      { tabs: ['git', 'history', 'files', 'terminal'], active: 'terminal' },
    ])
  })

  it('unknown tabs and groups change nothing', () => {
    expect(moveTabToGroupEnd(split(), 'terminal', 5)).toEqual(split())
  })
})

describe('activateTab', () => {
  it('activates in whichever group holds the tab, leaving the other group alone', () => {
    expect(activateTab(split(), 'files')).toEqual([
      { tabs: ['git', 'history', 'files'], active: 'files' },
      { tabs: ['terminal'], active: 'terminal' },
    ])
  })
})

describe('sanitizeLayout — a snapshot is a file on disk, treat it as untrusted', () => {
  it('round-trips a valid layout', () => {
    expect(sanitizeLayout(split())).toEqual(split())
  })

  it('garbage falls back to the default rather than guessing', () => {
    expect(sanitizeLayout(null)).toEqual(defaultLayout())
    expect(sanitizeLayout('git')).toEqual(defaultLayout())
    expect(sanitizeLayout([{ active: 'git' }])).toEqual(defaultLayout())
    expect(sanitizeLayout([])).toEqual(defaultLayout())
  })

  it('tabs the snapshot lost rejoin the first group — every tab exists exactly once', () => {
    expect(sanitizeLayout([{ tabs: ['terminal'], active: 'terminal' }])).toEqual([
      { tabs: ['terminal', 'git', 'history', 'files'], active: 'terminal' },
    ])
  })

  it('duplicates keep their first seat; unknown names and stale actives are dropped', () => {
    expect(
      sanitizeLayout([
        { tabs: ['git', 'git', 'chat'], active: 'chat' },
        { tabs: ['git', 'files'], active: 'files' },
      ]),
    ).toEqual([
      { tabs: ['git', 'history', 'terminal'], active: 'git' },
      { tabs: ['files'], active: 'files' },
    ])
  })

  it('a third group does not survive — its tabs come back through the first group', () => {
    expect(
      sanitizeLayout([
        { tabs: ['git'], active: 'git' },
        { tabs: ['files'], active: 'files' },
        { tabs: ['terminal'], active: 'terminal' },
      ]),
    ).toEqual([
      { tabs: ['git', 'history', 'terminal'], active: 'git' },
      { tabs: ['files'], active: 'files' },
    ])
  })
})
