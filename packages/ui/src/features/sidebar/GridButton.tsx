import { useState } from 'react'
import { useStore } from '../../store/store.js'
import { catalogByKey } from '../../store/app-catalog.js'
import { droppedGridList, droppedGridPanel, gridTakes } from '../grid/drop.js'

/**
 * The door to the grid.
 *
 * **It has to look different from a project.** If it had the same shape as the other rows in the
 * list, it would read as "one more project," but this is not a project, it is **a way of
 * watching**. Wrapping it in a rounded box sets it apart from the list — the shape says it is a
 * different kind of thing before the text does.
 *
 * Dropping a session or an app (#288) here switches into the grid and adds it there. If the person had to
 * open the screen first and then drag it in separately, that would be doing the work twice, so
 * dropping it here handles both steps at once.
 *
 * **The Experimental badge is gone** (2026-08-27, by the user's call). It went up when the
 * grid shipped looking finished while the spec still listed it under non-goals (issue #25) —
 * the mark existed to warn about the hour you might lose inside an unproven view. Weeks of
 * dogfooding later the grid is simply how sessions get watched side by side, and a warning
 * that no longer warns anyone is clutter on the one lane that is always on screen.
 * The orchestrator's badge stays — that surface still is what its mark says it is.
 */
export function GridButton() {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)
  const panels = useStore((s) => s.gridPanels)
  const setGridPanels = useStore((s) => s.setGridPanels)
  const [over, setOver] = useState(false)
  const active = view === 'grid'

  return (
    <div className="px-2 pb-1 pt-1.5">
      <button
        className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors ${
          active
            ? 'border-ink-faint/50 bg-surface-hover text-ink'
            : 'border-line bg-surface-raised text-ink-muted hover:border-line-strong hover:text-ink'
        } ${over ? 'shadow-[inset_0_0_0_2px_var(--color-focus)]' : ''}`}
        /*
          A **selection**, not a toggle.
          Making it an on/off switch reads as "a layer briefly covering the previous screen" — it
          actually was misread that way. It follows the same rule as the other rows in the
          sidebar: pressing it shows this, and leaving it means choosing something else.
        */
        onClick={() => setView('grid')}
        aria-pressed={active}
        data-testid="grid-button"
        title="See sessions and apps side by side."
        onDragOver={(e) => {
          // A session or an app (#288), from the sidebar or from a panel — the grid's own rule (grid/drop.ts)
          if (!gridTakes(e.dataTransfer.types)) return
          e.preventDefault()
          setOver(true)
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          setOver(false)
          const st = useStore.getState()
          const panel = droppedGridPanel(
            (type) => e.dataTransfer.getData(type),
            new Set(Object.keys(st.sessions)),
            catalogByKey(st.externalApps),
          )
          if (!panel) return
          e.preventDefault()
          // At the end; one already on the grid stays where it is
          void setGridPanels(droppedGridList(panels, panel, null, false))
          setView('grid')
        }}
      >
        <GridIcon />
        <span className="truncate font-medium tracking-tight">Grid</span>
        {panels.length > 0 && <span className="readout ml-auto text-2xs text-ink-faint">{panels.length}</span>}
      </button>
    </div>
  )
}

/** A split screen — a symbol drawn to depict exactly what the grid does */
function GridIcon({ size = 13 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden className="shrink-0">
      <rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="1.5" width="5.5" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <rect x="1.5" y="9" width="5.5" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
      <rect x="9" y="9" width="5.5" height="5.5" rx="1.2" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}
