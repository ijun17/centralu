import { describe, expect, it } from 'vitest'
import { appPanelId, arrangePanels, migrateArrangement, parsePanelId, sanitizeArrangements, sessionPanelId, withPanel, withOrder } from './project.js'

const [a, b, c] = ['session:a', 'session:b', 'session:c']
const app = 'app:slider'
const saved = (panels: string[]) => ({ panels, order: panels, hidden: [] })

describe('arrangePanels', () => {
  it('an untouched project starts empty even when it has sessions and apps', () => {
    expect(arrangePanels([a, b, app], undefined)).toEqual([])
  })

  it('keeps only explicit panels in order and never adds a newly created session', () => {
    expect(arrangePanels([a, b, c, app], saved([app, b, a]))).toEqual([app, b, a])
    expect(arrangePanels([a, b], saved([]))).toEqual([])
  })

  it('skips unavailable and duplicate ids without erasing temporarily unlisted apps', () => {
    const arrangement = saved([app, b, b, a])
    expect(arrangePanels([a], arrangement)).toEqual([a])
    expect(arrangePanels([a, app], arrangement)).toEqual([app, a])
    expect(arrangement.panels).toEqual([app, b, b, a])
  })
})

describe('withOrder and withPanel', () => {
  it('writes ordered membership with a legacy projection readable by the previous build', () => {
    expect(withOrder([a, b, app], undefined, [b, b, 'session:gone'])).toEqual({
      panels: [b], order: [b], hidden: [a, app],
    })
  })

  it('adds only the requested available panel, removes it, and adds it back at the end', () => {
    const first = withPanel([a, b, c], undefined, b, true)
    expect(arrangePanels([a, b, c], first)).toEqual([b])
    const next = withPanel([a, b, c], first, a, true)
    expect(arrangePanels([a, b, c], next)).toEqual([b, a])
    const removed = withPanel([a, b, c], next, b, false)
    expect(removed.panels).toEqual([a])
    expect(arrangePanels([a, b, c], withPanel([a, b, c], removed, b, true))).toEqual([a, b])
    expect(withPanel([a], undefined, 'session:gone', true)).toEqual({ panels: [], order: [], hidden: [a] })
  })
})

describe('editing while apps are unavailable', () => {
  const layouts = [
    { where: 'first', panels: [app, a, b], reordered: [app, b, a], removed: [app, b] },
    { where: 'middle', panels: [a, app, b], reordered: [b, app, a], removed: [app, b] },
    { where: 'last', panels: [a, b, app], reordered: [b, a, app], removed: [b, app] },
  ]

  it.each(layouts)('reordering keeps an unavailable app in its saved $where position', ({ panels, reordered }) => {
    const next = withOrder([a, b, c], saved(panels), [b, a])
    expect(next.panels).toEqual(reordered)
    expect(next.order).toEqual(reordered)
    expect(arrangePanels([a, b, c, app], next)).toEqual(reordered)
  })

  it.each(layouts)('adding keeps an unavailable app in its saved $where position', ({ panels }) => {
    const next = withPanel([a, b, c], saved(panels), c, true)
    expect(next.panels).toEqual([...panels, c])
    expect(arrangePanels([a, b, c, app], next)).toEqual([...panels, c])
  })

  it.each(layouts)('removing a session keeps an unavailable app in its saved $where position', ({ panels, removed }) => {
    const next = withPanel([a, b, c], saved(panels), a, false)
    expect(next.panels).toEqual(removed)
    expect(arrangePanels([a, b, c, app], next)).toEqual(removed)
  })

  it('removes an unavailable panel only when explicitly asked, preserving other unavailable panels and legacy exclusions', () => {
    const other = 'app:other'
    const next = withPanel([a, b], { panels: [other, a, app, b], order: [other, a, app, b], hidden: ['app:hidden'] }, app, false)
    expect(next.panels).toEqual([other, a, b])
    expect(next.hidden).toEqual(['app:hidden', app])
    expect(arrangePanels([a, b, app, other], next)).toEqual([other, a, b])
  })

  it('an edit with no available panels preserves the entire saved list', () => {
    const initial = saved([app, 'app:other'])
    expect(withOrder([], initial, []).panels).toEqual(initial.panels)
    expect(withPanel([], initial, 'session:unknown', true).panels).toEqual(initial.panels)
  })

  it('a reorder naming only some visible panels cannot silently remove another saved panel', () => {
    expect(withOrder([a, b], saved([a, app, b]), [b]).panels).toEqual([b, app, a])
  })
})

describe('migration', () => {
  it('preserves every non-hidden legacy ordered id and appends unplaced available panels', () => {
    const legacy = { order: [app, b, b, 'session:gone'], hidden: [a] }
    const migrated = migrateArrangement([a, b, c, app], legacy)
    expect(migrated).toEqual({ ...legacy, panels: [app, b, 'session:gone', c] })
    expect(arrangePanels([a, b, c, app, 'session:new'], migrated)).toEqual([app, b, c])
  })

  it('migrates hide-only, all-hidden and empty-array entries as arranged projects', () => {
    expect(migrateArrangement([a, b, app], { order: [], hidden: [b] }).panels).toEqual([a, app])
    expect(migrateArrangement([a, b], { order: [], hidden: [a, b] }).panels).toEqual([])
    expect(migrateArrangement([a, b], { order: [], hidden: [] }).panels).toEqual([a, b])
  })

  it.each([{ apps: [] }, { apps: [app] }])('keeps legacy app ids with an incomplete initial catalog $apps and draws them when available', ({ apps }) => {
    const absent = 'app:offline'
    const legacy = { order: [absent, a, app, absent, 'app:hidden'], hidden: ['app:hidden'] }
    const migrated = migrateArrangement([a, ...apps], legacy)
    expect(migrated).toEqual({ ...legacy, panels: [absent, a, app] })
    expect(arrangePanels([a, ...apps], migrated)).toEqual([a, ...apps])
    expect(arrangePanels([a, app, absent, 'app:hidden'], migrated)).toEqual([absent, a, app])
  })

  it('is idempotent and never derives new panels once the explicit field exists', () => {
    const arrangement = saved([])
    expect(migrateArrangement([a, app], arrangement)).toBe(arrangement)
    const migrated = migrateArrangement([a], { order: [a], hidden: [] })
    expect(migrateArrangement([a, b, app], migrated)).toBe(migrated)
  })
})

describe('panel ids', () => {
  it('carry their kind, so a session and an app with the same id are two panels', () => {
    expect(sessionPanelId('x')).not.toBe(appPanelId('x'))
    expect(parsePanelId(sessionPanelId('x'))).toEqual({ kind: 'session', id: 'x' })
    expect(parsePanelId(appPanelId('my:app'))).toEqual({ kind: 'app', id: 'my:app' })
    expect(parsePanelId('widget:x')).toBeNull()
    expect(parsePanelId('x')).toBeNull()
  })
})

describe('sanitizeArrangements', () => {
  it('keeps legacy fields and distinguishes missing explicit membership from empty or malformed membership', () => {
    expect(sanitizeArrangements({
      p1: { order: [a, 3, null], hidden: 'no' }, p2: null,
      p3: { panels: [b, 3], order: [b] }, p4: { panels: 'no' }, p5: [],
    })).toEqual({
      p1: { order: [a], hidden: [] }, p3: { panels: [b], order: [b], hidden: [] },
      p4: { panels: [], order: [], hidden: [] },
    })
    expect(sanitizeArrangements([a])).toEqual({})
    expect(sanitizeArrangements(undefined)).toEqual({})
  })
})
