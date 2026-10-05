import { z } from 'zod'

/**
 * An item dragged out of an app view into a session's composer (#308).
 *
 * The browser does not hand a drag from a view to the page around it (agent-host
 * views/drag-relay.ts has the measurement), so the host adds a relay to every view that posts the
 * drag's link and text when it starts and the point where it ended. Both halves read this one
 * description: the host writes the relay, the UI's bridge reads its messages.
 */

/** The notification the relay posts through the view's bridge. Outside the standard, like `centralu/notifications/changed` */
export const APP_DRAG_NOTIFICATION = 'centralu/notifications/drag'

/** The longest `text/uri-list` or `text/plain` the relay passes on: a link and its title, not a document */
export const APP_DRAG_TEXT_MAX = 4096

/**
 * What the relay posts. The view sends it, so the UI reads it as the app's words: the shape is
 * checked here, and nothing in it is trusted beyond being a link and a title for a draft.
 *
 *   start  the drag's `text/uri-list` and `text/plain`, read at `dragstart`
 *   end    where that drag ended, in the view's own coordinates (`clientX`/`clientY` of its
 *          `dragend`), with the view's size, so the UI can place it whatever the frame's scale
 */
export const AppDragMessage = z.discriminatedUnion('phase', [
  z.object({ phase: z.literal('start'), uri: z.string().max(APP_DRAG_TEXT_MAX), text: z.string().max(APP_DRAG_TEXT_MAX) }),
  z.object({
    phase: z.literal('end'),
    x: z.number(),
    y: z.number(),
    width: z.number().positive(),
    height: z.number().positive(),
  }),
])
export type AppDragMessage = z.infer<typeof AppDragMessage>

/**
 * Whether a session can use one app's tools right now (`apps.reach`, #308), and if not, why — so the
 * composer can say what would fix it when an item from that app is dropped on it.
 *
 *   other-project   the app is not one this session is given: another project's app, a user-folder
 *                   app outside the orchestrator, or a session stood up by an app (apps.md §9.1)
 *   untrusted       the app's project, which is this session's, is not trusted
 *   app-unusable    the app cannot be attached: its manifest is invalid, it is not turned on yet
 *                   (`unconfirmed`), or it stopped after repeated failures (`failed`); `status` says which
 *   restart         a Codex thread started before the app was attached: Codex does not take new
 *                   servers into a running thread, so the session has to restart
 *   bridge-failed   the app's bridge for this session failed to start (Codex reported it)
 *   unavailable     the host has no apps, or the app is gone
 */
export const AppReach = z.discriminatedUnion('reachable', [
  z.object({ reachable: z.literal(true) }),
  z.object({
    reachable: z.literal(false),
    reason: z.enum(['other-project', 'untrusted', 'app-unusable', 'restart', 'bridge-failed', 'unavailable']),
    status: z.string().optional(),
  }),
])
export type AppReach = z.infer<typeof AppReach>
