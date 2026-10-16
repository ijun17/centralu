import { z } from 'zod'
import { MachineId } from '../machines.js'
import { AppId, ProjectId, SessionId } from './ids.js'

/**
 * The largest span, in grid cells, a panel may ask for in either direction (#306). A bound on what is stored and
 * declared, not on what is drawn: the grid clamps a span to the columns and rows it has at the window's size.
 */
export const GRID_SPAN_MAX = 4

/**
 * How many grid cells an app panel spans, columns × rows (#306). A session panel is always 1 × 1. Whole numbers from 1
 * to `GRID_SPAN_MAX`; the grid places a span that does not fit at the largest size that does.
 */
export const GridSpan = z.object({
  cols: z.number().int().min(1).max(GRID_SPAN_MAX),
  rows: z.number().int().min(1).max(GRID_SPAN_MAX),
})
export type GridSpan = z.infer<typeof GridSpan>

/**
 * One panel placed on the grid (#288): a session, or an app.
 *
 * Tagged rather than a bare id, because the grid holds both in one order and a session id and an
 * app id can collide. An app is named by its project and its id, the same pair that identifies it
 * everywhere else (`ExternalAppInfo`): `projectId: null` is a user-folder app, and two projects can
 * each have an app with the same id.
 *
 * The shape says nothing about the host's tables on purpose. The grid is a way of looking, and #82
 * moves the grid's list to the client with the remote mode; a reference made only of the panel's
 * identity is something the client can store as it is.
 *
 * The app id is not checked against the manifest's character rule here: this is a layout entry,
 * never a path or a server name, and an app the grid names that does not exist (deleted, or not
 * listed yet) is simply not drawn. The length cap only keeps a value that is not an id out.
 */
export const GridPanel = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: SessionId }),
  z.object({
    kind: z.literal('app'),
    projectId: ProjectId.nullable(),
    appId: AppId.min(1).max(128),
    /**
     * The span the person chose for this placement from the panel's top bar (#306), absent when they have not chosen
     * one. Absent is not 1 × 1: the panel then takes the person's setting for the app, else the app's recommendation,
     * else 1 × 1 (the UI's `resolveGridSpan`). Optional rather than defaulted, because "not chosen" is the value — a
     * default would write a choice nobody made. A host from before #306 strips it, and the panel falls back to the
     * defaults; nothing else changes.
     */
    span: GridSpan.optional(),
    /**
     * A linked machine's user-folder app (#82, docs/plans/remote-hub.md §11.8): which machine, since a null project
     * cannot say so. Absent for this computer's apps and for any project app, whose qualified id already names its
     * machine. Additive: a host from before it strips it, and its `grid.set` drops a panel it cannot place.
     */
    machine: MachineId.optional(),
  }),
])
export type GridPanel = z.infer<typeof GridPanel>
