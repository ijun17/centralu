import type { InlineViews } from './inline-views.js'
import type { OpenView, ViewHost } from './views/view-host.js'

/**
 * Open app views across a planned hand-over (#280 option C step 4).
 *
 * Under the keeper, a build switch replaces the host while the window stays open: the old host
 * drains and a new one takes over behind the same front door. View instances live only in the
 * host's memory, so without this an open view went blank, or its next call failed with "This app
 * view is not open", until the person reopened it.
 *
 * So the leaving host writes down what it takes to serve each open view again — its id, its app
 * and its `ui://` address, nothing the app returned — and the next host started under the keeper
 * opens them again under the same ids at startup. With the view's address also stable (the front
 * door's port and a secret derived from the keeper's token, main.ts), the UI's re-request after
 * the reconnect gets the very address it already has and leaves the view alone (AppFrame).
 *
 * Only a **planned** ending writes the record: the drain of a swap, or a signal while the keeper's
 * child service holds the agents (a restart; main.ts). A crash writes nothing, and its views are
 * lost as before: there is no moment to write in, and an uncaught exception's state is not one to
 * carry forward.
 */

/** The `app_settings` key the record lives under */
export const VIEW_HANDOVER_KEY = 'views.handover'

/**
 * How old a record may be and still be restored. A swap's gap is the drain bound (10 s) plus the
 * new host's start; ten minutes leaves room for a slow start while making sure a record left by a
 * host that was stopped and not replaced does not reopen views at some unrelated later start (a
 * restored view holds its app from going idle until the UI closes it).
 */
export const VIEW_HANDOVER_MAX_AGE_MS = 10 * 60_000

/** One handed-over view. `inline` is set for a view inside a conversation (inline-views.ts): which card it belongs to */
export type HandedView = OpenView & { inline?: { sessionId: string; callId: string; tool: string } }

type HandoverRecord = { at: number; views: HandedView[] }

/** The part of the store this needs (dev-services/store.ts) */
export type HandoverSettings = {
  appSetting(key: string): string | null
  setAppSetting(key: string, value: string): void
  deleteAppSetting(key: string): void
}

/** Writes the open views down. Returns how many were recorded; nothing is written when none is open */
export function recordViewHandover(settings: HandoverSettings, views: ViewHost, inline: InlineViews | null, now = Date.now()): number {
  const open: HandedView[] = views.list().map((v) => {
    const owner = inline?.owner(v.id)
    return owner ? { ...v, inline: { sessionId: owner.sessionId, callId: owner.callId, tool: owner.tool } } : v
  })
  if (open.length === 0) {
    settings.deleteAppSetting(VIEW_HANDOVER_KEY)
    return 0
  }
  const record: HandoverRecord = { at: now, views: open }
  settings.setAppSetting(VIEW_HANDOVER_KEY, JSON.stringify(record))
  return open.length
}

/**
 * Opens the recorded views again, if the record is recent, and deletes it either way: a record is
 * read once, so a later start can never reopen the same views a second time.
 */
export function restoreViewHandover(
  settings: HandoverSettings,
  views: ViewHost,
  inline: InlineViews | null,
  now = Date.now(),
): { restored: number; skipped: number } {
  const raw = settings.appSetting(VIEW_HANDOVER_KEY)
  if (raw === null) return { restored: 0, skipped: 0 }
  settings.deleteAppSetting(VIEW_HANDOVER_KEY)
  let record: Partial<HandoverRecord>
  try {
    record = JSON.parse(raw) as Partial<HandoverRecord>
  } catch {
    return { restored: 0, skipped: 0 }
  }
  const list = Array.isArray(record?.views) ? record.views : []
  // A record from the future (a clock moved back) is as unknown as an old one
  const age = typeof record?.at === 'number' ? now - record.at : Number.NaN
  if (!(age >= 0 && age <= VIEW_HANDOVER_MAX_AGE_MS)) return { restored: 0, skipped: list.length }
  const opened = new Set(views.restore(list))
  for (const v of list) {
    // An element the previous host wrote in a shape this build does not read was not opened above (#384)
    if (typeof v !== 'object' || v === null || !opened.has(v.id)) continue
    const o = v.inline
    if (!o || typeof o.sessionId !== 'string' || typeof o.callId !== 'string' || typeof o.tool !== 'string') continue
    inline?.adopt({ sessionId: o.sessionId, callId: o.callId, ref: v.app, tool: o.tool, uri: v.uri, instanceId: v.id })
  }
  return { restored: opened.size, skipped: list.length - opened.size }
}
