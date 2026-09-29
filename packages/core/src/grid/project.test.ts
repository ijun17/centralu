import { describe, expect, it } from 'vitest'
import { appPanelId, arrangePanels, parsePanelId, sanitizeArrangements, sessionPanelId, withHidden, withOrder } from './project.js'

const [a, b, c] = ['session:a', 'session:b', 'session:c']
const app = 'app:slider'

describe('arrangePanels', () => {
  it('an untouched project shows everything it has, in its natural order', () => {
    expect(arrangePanels([a, b, app], undefined)).toEqual([a, b, app])
  })

  it('dragged panels keep their order and a panel created after the drag lands at the end', () => {
    expect(arrangePanels([a, b, c, app], { order: [app, b, a], hidden: [] })).toEqual([app, b, a, c])
  })

  it('a hidden panel is left out, and an id that no longer exists is skipped', () => {
    expect(arrangePanels([a, b], { order: ['session:gone', b, a], hidden: [a] })).toEqual([b])
  })

  it('an order with a repeated id still shows the panel once', () => {
    expect(arrangePanels([a, b], { order: [b, b, a], hidden: [] })).toEqual([b, a])
  })
})

describe('withOrder', () => {
  it('stores what the screen shows and drops ids that no longer exist', () => {
    expect(withOrder([a, b], { order: [], hidden: [a, 'session:gone'] }, [b, 'session:gone'])).toEqual({
      order: [b],
      hidden: [a],
    })
  })
})

describe('withHidden', () => {
  it('hiding takes the panel off the screen and out of the order', () => {
    const next = withHidden([a, b, c], { order: [c, b, a], hidden: [] }, b, true)
    expect(next).toEqual({ order: [c, a], hidden: [b] })
    expect(arrangePanels([a, b, c], next)).toEqual([c, a])
  })

  it('a panel shown again comes back at the end, not at the place it held', () => {
    const hidden = withHidden([a, b, c], { order: [b, a, c], hidden: [] }, b, true)
    const shown = withHidden([a, b, c], hidden, b, false)
    expect(arrangePanels([a, b, c], shown)).toEqual([a, c, b])
  })

  it('shown again on a screen nobody has dragged, it still comes back at the end', () => {
    const hidden = withHidden([a, b, c], undefined, a, true)
    expect(arrangePanels([a, b, c], withHidden([a, b, c], hidden, a, false))).toEqual([b, c, a])
  })

  it('an id that does not exist is not hidden', () => {
    expect(withHidden([a], undefined, 'session:gone', true)).toEqual({ order: [], hidden: [] })
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
  it('keeps lists of strings and drops everything else instead of throwing', () => {
    expect(
      sanitizeArrangements({ p1: { order: [a, 3, null], hidden: 'no' }, p2: null, p3: { order: [b] } }),
    ).toEqual({ p1: { order: [a], hidden: [] }, p3: { order: [b], hidden: [] } })
    expect(sanitizeArrangements([a])).toEqual({})
    expect(sanitizeArrangements(undefined)).toEqual({})
  })
})
