import { z } from 'zod'

// An item dragged out of an app view into a composer (#308). The browser does not hand a drag from a view to the page
// around it (measured in agent-host views/drag-relay.ts), so the host adds a relay to every view; the UI reads it here.

/** Outside the standard, like `centralu/notifications/changed` */
export const APP_DRAG_NOTIFICATION = 'centralu/notifications/drag'

/** A link and its title, not a document */
export const APP_DRAG_TEXT_MAX = 4096

/**
 * The app's words: trusted only as a link and a title for a draft. `end` is the `dragend` point in the view's own
 * coordinates, with its size, so the UI can place it whatever the frame's scale
 */
export const AppDragMessage = z.discriminatedUnion('phase', [
  z.object({
    phase: z.literal('start'),
    uri: z.string().max(APP_DRAG_TEXT_MAX),
    text: z.string().max(APP_DRAG_TEXT_MAX),
  }),
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
 * Why a session cannot use an app's tools, so the composer can say what would fix it when the app's item is dropped.
 * `other-project`: not given to this session (apps/attaching.md "Which session gets which apps"). `app-unusable`:
 * `status` says why. `restart` and `bridge-failed` come only from a host older than #2231 (Codex takes no new servers
 * into a running thread); kept for it (docs/protocol.md §4).
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
