import { AppDragMessage, type AppId } from '@cc/protocol'

/**
 * The page's half of an item dragged out of an app view (#308).
 *
 * The page never hears that drag: a drag that starts in a document of another origin is not handed
 * to this one (agent-host views/drag-relay.ts has the measurement). The host adds a relay to every
 * view that posts, through the view's bridge, the drag's link and text when it starts and the point
 * where it ended. This turns that point into one in the page, and hands the link to whatever lies
 * there as a DOM event, `APP_LINK_DROP_EVENT`, bubbling from the element under the point. A session
 * pane listens for it (SessionView) and puts the link into its composer; anywhere else it falls
 * through and nothing happens, as a drop on a spot that takes nothing.
 *
 * An event rather than a call: this feature does not know what a session is, and the element under
 * the point is how the page already says what is there.
 */

export const APP_LINK_DROP_EVENT = 'cc-app-link-drop'

/** What a session pane receives. `landed` is set by whoever took it, so the frame knows it went somewhere */
export type AppLinkDrop = {
  uri: string
  text: string
  from: { appId: AppId; projectId: string | null }
  landed: boolean
}

type Box = { left: number; top: number; width: number; height: number }
type End = Extract<AppDragMessage, { phase: 'end' }>

/**
 * How long a started drag waits for its end. A drag is a hand held down, so minutes is already
 * generous; past it, an end that arrives belongs to no drag the person is making.
 */
export const DRAG_START_TTL_MS = 120_000

/**
 * The frame's content box in the page: its border box less its borders. The borders are measured
 * in layout pixels, and scaled by how the frame's box is drawn (`rect.width / offsetWidth`), so a
 * page zoom (the text size setting zooms the root) does not move the box.
 */
export function contentBox(frame: HTMLIFrameElement): Box {
  const rect = frame.getBoundingClientRect()
  const cs = getComputedStyle(frame)
  const k = frame.offsetWidth > 0 ? rect.width / frame.offsetWidth : 1
  const l = parseFloat(cs.borderLeftWidth) * k || 0
  const r = parseFloat(cs.borderRightWidth) * k || 0
  const t = parseFloat(cs.borderTopWidth) * k || 0
  const b = parseFloat(cs.borderBottomWidth) * k || 0
  return { left: rect.left + l, top: rect.top + t, width: rect.width - l - r, height: rect.height - t - b }
}

/**
 * Where a view's `dragend` happened, in the page. The engines disagree on what that point is
 * measured from (`PlatformCapabilities.frameDragEndInPage`, platform engine.ts has the measurement):
 * WebKit gives the frame's own coordinates, as the spec has it, and Chromium the page's. In the
 * frame's coordinates the point is scaled by the content box over the view's own size, so a zoomed
 * page and a view that reports its size in its own pixels still meet; the view fills its proxy,
 * which fills the frame (proxy-page.ts). In the page's it is the point as it came.
 */
export function pagePoint(end: Pick<End, 'x' | 'y' | 'width' | 'height'>, box: Box, inPage: boolean): { x: number; y: number } {
  if (inPage) return { x: end.x, y: end.y }
  return { x: box.left + (end.x * box.width) / end.width, y: box.top + (end.y * box.height) / end.height }
}

const inside = (p: { x: number; y: number }, b: Box) => p.x >= b.left && p.x < b.left + b.width && p.y >= b.top && p.y < b.top + b.height

/**
 * One view's relay: what it started, and where it ends. Built per frame (AppFrame), fed every
 * relay message its bridge receives.
 *
 * What the view says is the app's word, so nothing is taken on trust beyond being a link and a title
 * for a draft: the shape is checked (`AppDragMessage`), an end only counts after a start from the
 * same view and within `DRAG_START_TTL_MS`, the frame must hold the page's focus (pressing on an item
 * to drag it gives its frame focus; measured in both engines, `document.activeElement` was the frame
 * after the drag), and the link only ever goes into a draft the person sends themselves. An end
 * inside the frame is the app's own drop (a card moved between the board's columns), and one over
 * another frame lands on a view, not on the page.
 */
export class DragRelay {
  private started: { uri: string; text: string; at: number } | null = null

  constructor(
    private readonly frame: () => HTMLIFrameElement | null,
    private readonly from: () => AppLinkDrop['from'],
    /** `PlatformCapabilities.frameDragEndInPage`: whether the engine's `dragend` is in the page's coordinates */
    private readonly endInPage: boolean,
    private readonly now: () => number = Date.now,
  ) {}

  /** One relay message. Returns the drop it handed out, or null when it handed out nothing */
  take(params: unknown): AppLinkDrop | null {
    const parsed = AppDragMessage.safeParse(params)
    if (!parsed.success) return null
    const m = parsed.data
    if (m.phase === 'start') {
      this.started = m.uri || m.text ? { uri: m.uri, text: m.text, at: this.now() } : null
      return null
    }
    const started = this.started
    this.started = null
    const frame = this.frame()
    if (!started || !frame || this.now() - started.at > DRAG_START_TTL_MS) return null
    const doc = frame.ownerDocument
    if (doc.activeElement !== frame) return null
    const box = contentBox(frame)
    const at = pagePoint(m, box, this.endInPage)
    if (inside(at, box)) return null
    const target = doc.elementFromPoint(at.x, at.y)
    if (!target || target instanceof HTMLIFrameElement) return null
    const drop: AppLinkDrop = { uri: started.uri, text: started.text, from: this.from(), landed: false }
    target.dispatchEvent(new CustomEvent<AppLinkDrop>(APP_LINK_DROP_EVENT, { bubbles: true, detail: drop }))
    return drop
  }
}
