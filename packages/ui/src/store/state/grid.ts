import type {
  GridPanel,
  GridSpan,
} from '@cc/protocol/client'
import type {
  ProjectArrangement,
} from '@cc/core'

/** The grid's panels and the spans of app panels. */
export type GridSlice = {
  /** docs/state-management.md "Project panel membership". Its legacy order/hidden fields stay for the previous build. */
  projectPanels: Record<string, ProjectArrangement>
  arrangeProject(projectId: string, next: ProjectArrangement): void
  /**
   * Each app's grid span from Settings (#306), by `appKeyOf`, in the workspace snapshot: below a placement's own span,
   * above the app's recommendation (`resolveGridSpan`), else 1 × 1. Why: docs/product-spec.md §5.4.
   */
  appSpans: Record<string, GridSpan>
  setAppSpan(projectId: string | null, appId: string, span: GridSpan | null, machine?: string | null): void
  /** One placement's span (#306), by `gridPanelKey`, saved with the grid. */
  setGridPanelSpan(key: string, span: GridSpan | null): Promise<void>
  /** As the host stores them (#288), unknown kinds included; GridView leaves those out */
  gridPanels: GridPanel[]
  /** Saves them whole; an app panel left out has its view closed, teardown first. */
  setGridPanels(panels: GridPanel[]): Promise<void>
}
