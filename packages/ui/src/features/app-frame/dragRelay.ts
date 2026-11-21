import { AppDragMessage, type AppId } from '@cc/protocol/client'

// The page's half of a drag out of an app view (docs/apps/view-theme-layout-drag.md "Dragging an item out of a view").
// The link goes out as a DOM event bubbling from the element under the end point, so this feature need not know what a
// session is; a session pane (SessionView) takes it, anywhere else it falls through.

export const APP_LINK_DROP_EVENT = 'cc-app-link-drop'

/** What a session pane receives. `landed` is set by whoever took it, so the frame knows it went somewhere */
export type AppLinkDrop = {
  uri: string
  text: string
  /** `machine`: a linked machine's user-folder app, which is not this computer's of the same id (#82) */
  from: { appId: AppId; projectId: string | null; machine?: string | null }
  landed: boolean
}

type Box = { left: number; top: number; width: number; height: number }
type End = Extract<AppDragMessage, { phase: 'end' }>

/** A drag is a hand held down, so minutes is generous; a later end belongs to no drag the person is making */
export const DRAG_START_TTL_MS = 120_000

/** Border box less borders; the borders are in layout pixels, scaled by `rect.width / offsetWidth` so the root zoom does not move the box */
function contentBox(frame: HTMLIFrameElement): Box {
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
 * WebKit's `dragend` is in the frame's coordinates, Chromium's in the page's (`frameDragEndInPage`, measured in platform
 * engine.ts). Frame coordinates scale by the content box over the view's size; the view fills its proxy, which fills the frame.
 */
export function pagePoint(end: Pick<End, 'x' | 'y' | 'width' | 'height'>, box: Box, inPage: boolean): { x: number; y: number } {
  if (inPage) return { x: end.x, y: end.y }
  return { x: box.left + (end.x * box.width) / end.width, y: box.top + (end.y * box.height) / end.height }
}

const inside = (p: { x: number; y: number }, b: Box) => p.x >= b.left && p.x < b.left + b.width && p.y >= b.top && p.y < b.top + b.height

/**
 * One view's relay, built per frame and fed every relay message. The messages are the app's word, so the doc's checks
 * apply: shape, a start from this view within `DRAG_START_TTL_MS`, the frame holding focus, no end inside or over a frame.
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

  /** Returns the drop handed out, or null */
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
