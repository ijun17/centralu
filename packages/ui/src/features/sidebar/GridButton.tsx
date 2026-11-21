import { useState } from 'react'
import { useStore } from '../../store/store.js'
import { catalogByKey } from '../../store/app-catalog.js'
import { droppedGridList, droppedGridPanel, gridTakes } from '../grid/drop.js'

/**
 * The door to the grid, in a rounded box: a way of watching, not one more project. Dropping a session or an app (#288)
 * on it opens the grid with it added. No Experimental badge: on this always-visible lane a warning that warns nobody is
 * clutter.
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
            ? 'border-line-strong bg-surface-hover text-ink'
            : 'border-line bg-surface-raised text-ink-muted hover:border-line-strong hover:text-ink'
        } ${over ? 'shadow-[inset_0_0_0_2px_var(--color-focus)]' : ''}`}
        // A selection like the other rows, not a toggle: a toggle reads as a layer over the previous screen
        onClick={() => setView('grid')}
        aria-pressed={active}
        data-testid="grid-button"
        title="See sessions and apps side by side."
        onDragOver={(e) => {
          // The grid's own rule (grid/drop.ts)
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
        {/* No panel count: not what the button is read for */}
      </button>
    </div>
  )
}

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
