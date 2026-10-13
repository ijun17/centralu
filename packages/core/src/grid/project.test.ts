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

describe('migration', () => {
  it('preserves the legacy visible order including unplaced panels, but not hidden or gone ones', () => {
    const legacy = { order: [app, b, b, 'session:gone'], hidden: [a] }
    const migrated = migrateArrangement([a, b, c, app], legacy)
    expect(migrated).toEqual({ ...legacy, panels: [app, b, c] })
    expect(arrangePanels([a, b, c, app, 'session:new'], migrated)).toEqual([app, b, c])
  })

  it('migrates hide-only and all-hidden layouts, while an unarranged project stays empty', () => {
    expect(migrateArrangement([a, b, app], { order: [], hidden: [b] }).panels).toEqual([a, app])
    expect(migrateArrangement([a, b], { order: [], hidden: [a, b] }).panels).toEqual([])
    expect(migrateArrangement([a, b], { order: [], hidden: [] }).panels).toEqual([])
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
