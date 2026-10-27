import type {
  GridPanel,
  GridSpan,
} from '@cc/protocol/client'
import type {
  ProjectArrangement,
} from '@cc/core'

/** The grid's panels and the spans of app panels. */
export type GridSlice = {
  /**
   * Explicit ordered panel lists per project (#604), kept in the workspace snapshot.
   * Availability filters drawing; explicit session deletion removes membership. Deleting a
   * project drops its entry. Legacy order/hidden fields remain for the previous build.
   */
  projectPanels: Record<string, ProjectArrangement>
  /** Writes one project's arrangement whole and saves the snapshot */
  arrangeProject(projectId: string, next: ProjectArrangement): void
  /**
   * The person's span for each app's panel on the grid (#306), keyed by `appKeyOf` — Settings → Apps. The default for
   * every placement of that app that has no span of its own (from the panel's top bar), and ahead of the app's own
   * recommendation (core's `resolveGridSpan`). An app with no entry takes its recommendation, else 1 × 1.
   *
   * Kept in the workspace snapshot, like `projectPanels`: a way of looking that only this UI reads, about an app the
   * host's tables do not key (a user-folder app has no project). The choice for one placement is on the placement
   * itself, in the host's grid table, because it goes when the panel goes.
   */
  appSpans: Record<string, GridSpan>
  /** Sets or clears (`null`) the person's span for an app, and saves the snapshot */
  setAppSpan(projectId: string | null, appId: string, span: GridSpan | null, machine?: string | null): void
  /**
   * Sets or clears (`null`) the span of one app panel on the grid, keyed by core's `gridPanelKey` — the panel's top bar
   * (#306). Saved with the grid, like a move.
   */
  setGridPanelSpan(key: string, span: GridSpan | null): Promise<void>
  /** The grid's panels, sessions and apps, in order (#288) — as stored by the host, unknown ones included (GridView leaves those out) */
  gridPanels: GridPanel[]
  /**
   * Saves the grid's panels whole — adding, removing and reordering are all this one call. An app panel no longer in
   * the list has its view closed, teardown first, as the project screen's × does.
   */
  setGridPanels(panels: GridPanel[]): Promise<void>
}
