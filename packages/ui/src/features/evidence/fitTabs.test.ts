import { describe, expect, it } from 'vitest'
import type { PanelTab } from '../../store/panelLayout.js'
import { fitTabs } from './fitTabs.js'

/**
 * The rule for collapsing tabs in a narrow strip (user request, 2026-09-07).
 * Widths are fixed by the test — real measurement is the browser's job, and only the decision
 * logic is under test here.
 */
describe('fitTabs', () => {
  const ORDER: PanelTab[] = ['files', 'git', 'history', 'terminal']
  const W: Record<string, number> = { files: 50, git: 40, history: 60, terminal: 70 }
  const w = (t: PanelTab) => W[t]!
  const opts = { gap: 2, more: 24 }

  it('collapses nothing when everything fits', () => {
    expect(fitTabs(ORDER, w, 1000, 'files', opts)).toEqual({ shown: ORDER, hidden: [] })
  })

  it('collapses from the back when it does not fit — order stays the same', () => {
    // files+git+history = 150 + gap 4 = 154, plus `…` and its gap 26 → fits up to here at 180
    const r = fitTabs(ORDER, w, 180, 'files', opts)
    expect(r.shown).toEqual(['files', 'git', 'history'])
    expect(r.hidden).toEqual(['terminal'])
  })

  it('never collapses the selected tab — takes the last slot if it gets pushed out', () => {
    const r = fitTabs(ORDER, w, 180, 'terminal', opts)
    expect(r.shown).toEqual(['files', 'git', 'terminal'])
    expect(r.hidden).toEqual(['history'])
    // The relative order of the tabs that kept their slot is unchanged
    expect(r.shown.indexOf('files')).toBeLessThan(r.shown.indexOf('git'))
  })

  it('leaves the selected tab even when too narrow to fit even one', () => {
    const r = fitTabs(ORDER, w, 10, 'history', opts)
    expect(r.shown).toEqual(['history'])
    expect(r.hidden).toEqual(['files', 'git', 'terminal'])
  })

  it('collapses nothing before it has been measured (width 0) — collapsing before measuring makes the screen flicker', () => {
    expect(fitTabs(ORDER, w, 0, 'files', opts).shown).toEqual(ORDER)
  })

  it('has nothing to collapse when there is only one tab', () => {
    expect(fitTabs(['git'], w, 5, 'git', opts)).toEqual({ shown: ['git'], hidden: [] })
  })
})
