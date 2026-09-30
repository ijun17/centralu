import { describe, expect, it } from 'vitest'
import { arrangePanels, type ProjectArrangement } from '@cc/core'
import { APP_MIME, PANEL_MIME, PROJECT_MIME, SESSION_MIME, projectItemMime } from '../sidebar/reorder.js'
import { PATH_MIME } from '../files/dragPath.js'
import { dragVerdict, droppedArrangement, droppedPanelId } from './drop.js'

const [a, b, c] = ['session:a', 'session:b', 'session:c']
const app = 'app:slider'
const present = [a, b, c, app]

/** A drop's data, the way `DataTransfer.getData` answers: an empty string for a type it does not carry */
const data =
  (entries: Record<string, string>) =>
  (type: string): string =>
    entries[type] ?? ''

describe('dragVerdict', () => {
  it("takes this project's session or app, from the types alone", () => {
    expect(dragVerdict([SESSION_MIME, projectItemMime('p1')], 'p1')).toBe('add')
    expect(dragVerdict([APP_MIME, projectItemMime('p1')], 'p1')).toBe('add')
  })

  it("refuses another project's session or app, and a session that belongs to no project (the orchestrator)", () => {
    expect(dragVerdict([SESSION_MIME, projectItemMime('p2')], 'p1')).toBe('refuse')
    expect(dragVerdict([APP_MIME, projectItemMime('p2')], 'p1')).toBe('refuse')
    expect(dragVerdict([SESSION_MIME], 'p1')).toBe('refuse')
  })

  it("leaves the screen's own panel drag to the reorder, even though a session's panel carries the session", () => {
    expect(dragVerdict([PANEL_MIME, SESSION_MIME], 'p1')).toBe('panel')
  })

  it('leaves files, paths and project rows to whoever owns them', () => {
    expect(dragVerdict(['Files'], 'p1')).toBe('ignore')
    expect(dragVerdict([PATH_MIME, 'text/plain'], 'p1')).toBe('ignore')
    expect(dragVerdict([PROJECT_MIME], 'p1')).toBe('ignore')
  })

  it('reads the project from a type the browser has lowercased', () => {
    const types = [SESSION_MIME, projectItemMime('Mock-Project-1')].map((t) => t.toLowerCase())
    expect(dragVerdict(types, 'Mock-Project-1')).toBe('add')
  })
})

describe('droppedPanelId', () => {
  const sessions = [{ id: 'a' }, { id: 'b' }]
  const apps = [{ key: 'p1/slider', appId: 'slider' }]

  it("names the panel of this project's session or app", () => {
    expect(droppedPanelId(data({ [SESSION_MIME]: 'b' }), sessions, apps)).toBe('session:b')
    expect(droppedPanelId(data({ [APP_MIME]: 'p1/slider' }), sessions, apps)).toBe(app)
  })

  it("refuses a session this project does not have, even when the drop arrives without a dragover's yes", () => {
    expect(droppedPanelId(data({ [SESSION_MIME]: 'other' }), sessions, apps)).toBeNull()
  })

  it("refuses another project's app with the same id — the key carries the project", () => {
    expect(droppedPanelId(data({ [APP_MIME]: 'p2/slider' }), sessions, apps)).toBeNull()
    expect(droppedPanelId(data({ [APP_MIME]: '_user/slider' }), sessions, apps)).toBeNull()
  })

  it('refuses a drop that carries neither', () => {
    expect(droppedPanelId(data({ 'text/plain': 'session:a' }), sessions, apps)).toBeNull()
  })
})

describe('droppedArrangement', () => {
  const allHidden: ProjectArrangement = { order: [], hidden: [a, b, c, app] }
  const shows = (next: ProjectArrangement | null) => arrangePanels(present, next ?? undefined)

  it('a hidden panel dropped on the empty screen comes back', () => {
    const next = droppedArrangement(present, allHidden, b, null, false)
    expect(shows(next)).toEqual([b])
    expect(next?.hidden).toEqual([a, c, app])
  })

  it('a hidden panel dropped on the padding comes back at the end', () => {
    expect(shows(droppedArrangement(present, { order: [], hidden: [b] }, b, null, false))).toEqual([a, c, app, b])
  })

  it('a hidden panel dropped on a panel stands before or after it', () => {
    const saved = { order: [], hidden: [app] }
    expect(shows(droppedArrangement(present, saved, app, b, true))).toEqual([a, app, b, c])
    expect(shows(droppedArrangement(present, saved, app, b, false))).toEqual([a, b, app, c])
  })

  it('a visible panel dropped on another moves there', () => {
    expect(shows(droppedArrangement(present, undefined, c, a, true))).toEqual([c, a, b, app])
    expect(shows(droppedArrangement(present, undefined, a, app, false))).toEqual([b, c, app, a])
  })

  it('a visible panel dropped on the padding, or where it already stands, changes nothing', () => {
    expect(droppedArrangement(present, undefined, b, null, false)).toBeNull()
    expect(droppedArrangement(present, undefined, b, b, true)).toBeNull()
    expect(droppedArrangement(present, undefined, a, b, true)).toBeNull()
  })

  it('a panel the project does not have changes nothing, hidden or not', () => {
    expect(droppedArrangement(present, undefined, 'session:other', a, true)).toBeNull()
    expect(droppedArrangement(present, allHidden, 'session:other', null, false)).toBeNull()
  })

  it('a hidden panel dropped on a panel that is gone comes back at the end', () => {
    expect(shows(droppedArrangement(present, { order: [], hidden: [a] }, a, 'session:gone', true))).toEqual([
      b,
      c,
      app,
      a,
    ])
  })
})
