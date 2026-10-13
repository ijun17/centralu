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
  const empty: ProjectArrangement = { panels: [], order: [], hidden: [a, b, c, app] }
  const all: ProjectArrangement = { panels: present, order: present, hidden: [] }
  const shows = (next: ProjectArrangement | null) => arrangePanels(present, next ?? undefined)

  it('an absent panel dropped on an untouched screen is the only panel added', () => {
    const next = droppedArrangement(present, undefined, b, null, false)
    expect(shows(next)).toEqual([b])
    expect(next?.hidden).toEqual([a, c, app])
  })

  it('an absent panel dropped on the padding comes back at the end', () => {
    expect(shows(droppedArrangement(present, { panels: [a, c, app], order: [a, c, app], hidden: [b] }, b, null, false))).toEqual([a, c, app, b])
  })

  it('an absent panel dropped on a panel stands before or after it', () => {
    const saved = { panels: [a, b, c], order: [a, b, c], hidden: [app] }
    expect(shows(droppedArrangement(present, saved, app, b, true))).toEqual([a, app, b, c])
    expect(shows(droppedArrangement(present, saved, app, b, false))).toEqual([a, b, app, c])
  })

  it('a visible panel dropped on another moves there', () => {
    expect(shows(droppedArrangement(present, all, c, a, true))).toEqual([c, a, b, app])
    expect(shows(droppedArrangement(present, all, a, app, false))).toEqual([b, c, app, a])
  })

  it('a visible panel dropped on the padding, or where it already stands, changes nothing', () => {
    expect(droppedArrangement(present, all, b, null, false)).toBeNull()
    expect(droppedArrangement(present, all, b, b, true)).toBeNull()
    expect(droppedArrangement(present, all, a, b, true)).toBeNull()
  })

  it('a sidebar reorder preserves an unavailable app between the visible slots', () => {
    const next = droppedArrangement([a, b, c], { panels: [a, app, b], order: [a, app, b], hidden: [] }, b, a, true)
    expect(next?.panels).toEqual([b, app, a])
    expect(arrangePanels([a, b, c, app], next ?? undefined)).toEqual([b, app, a])
  })

  it('a sidebar addition at a target preserves unavailable app slots', () => {
    const next = droppedArrangement([a, b, c], { panels: [a, app, b], order: [a, app, b], hidden: [] }, c, a, true)
    expect(next?.panels).toEqual([c, app, a, b])
    expect(arrangePanels([a, b, c, app], next ?? undefined)).toEqual([c, app, a, b])
  })

  it('a panel the project does not have changes nothing, listed or not', () => {
    expect(droppedArrangement(present, undefined, 'session:other', a, true)).toBeNull()
    expect(droppedArrangement(present, empty, 'session:other', null, false)).toBeNull()
  })

  it('an absent panel dropped on a panel that is gone comes back at the end', () => {
    expect(shows(droppedArrangement(present, { panels: [b, c, app], order: [b, c, app], hidden: [a] }, a, 'session:gone', true))).toEqual([
      b,
      c,
      app,
      a,
    ])
  })
})
