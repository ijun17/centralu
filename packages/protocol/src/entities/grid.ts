import { z } from 'zod'
import { MachineId } from '../machines.js'
import { AppId, ProjectId, SessionId } from './ids.js'

/** A bound on what is stored, not drawn: the grid clamps a span to the cells it has at the window's size */
export const GRID_SPAN_MAX = 4

/** An app panel's span (a session panel is 1 × 1); the grid places one that does not fit at the largest that does */
export const GridSpan = z.object({
  cols: z.number().int().min(1).max(GRID_SPAN_MAX),
  rows: z.number().int().min(1).max(GRID_SPAN_MAX),
})
export type GridSpan = z.infer<typeof GridSpan>

/**
 * Tagged, as a session id and an app id can collide; an app is its project (null: the user folder) and id. Identity
 * only, so a client stores it as it is; the app id is never a path, so it skips the manifest's character rule.
 */
export const GridPanel = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('session'), sessionId: SessionId }),
  z.object({
    kind: z.literal('app'),
    projectId: ProjectId.nullable(),
    appId: AppId.min(1).max(128),
    /** Absent is not chosen, not 1 × 1 (`resolveGridSpan`); not defaulted, which would write a choice nobody made */
    span: GridSpan.optional(),
    /** A linked machine's user-folder app, which a null project cannot name (docs/plans/remote-hub.md §11.8) */
    machine: MachineId.optional(),
  }),
])
export type GridPanel = z.infer<typeof GridPanel>
