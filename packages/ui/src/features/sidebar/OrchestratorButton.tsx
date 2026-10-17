import { useStore } from '../../store/store.js'
import { CrownIcon } from '../../components/icons.jsx'
import { SESSION_MIME } from './reorder.js'

/**
 * The door to the orchestrator — **directing by talking**.
 *
 * Placed directly above the grid. The two are two ways of looking at the same thing, so they
 * should stand side by side:
 *   orchestrator  direct sessions by talking, in one window
 *   grid          watch several windows at a glance
 *
 * Not nested under a project. This session does not belong to any project — crossing multiple
 * projects is the whole reason it exists.
 *
 * **The button spells out that it is still experimental** (issue #1). It looks identical to the
 * grid button, and people pressed it without knowing the difference. Putting the label **inside**
 * the orchestrator screen would be too late — the person has already pressed it by then, and the
 * harm being prevented is exactly "pressing it without knowing."
 *
 * Follows the palette rule (styles/index.css) as is: **urgency is brightness, kind is shape.**
 * The text is ink-faint (the color reserved for background information). Making it brighter would be
 * a lie that it is more urgent than the grid button — "experimental" is not urgent, it is
 * **something the person should press knowingly.**
 *
 * The border used to be dashed. The reasoning was "when the sidebar narrows, the text gets
 * clipped away and only the shape is left," but **measuring it showed that was not true.** The
 * 'Experimental' badge is `shrink-0`, so it stands at its full 63px even at the narrowest width
 * (180px, with the button at 163px) — what gets clipped instead is the name. Since there was
 * nothing the dashed border was protecting, there was no reason for it to stay either.
 */
export function OrchestratorButton() {
  const view = useStore((s) => s.view)
  const open = useStore((s) => s.openOrchestrator)
  const id = useStore((s) => s.orchestratorId)
  const active = view === 'orchestrator'

  // pt-2: the lane's top margin. Search used to stand above this row (#529); it moved to the top bar (#727)
  return (
    <div className="px-2 pt-2">
      <button
        className={`flex w-full items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left text-sm transition-colors ${
          active
            ? 'border-ink-faint/50 bg-surface-hover text-ink'
            : 'border-line bg-surface-raised text-ink-muted hover:border-line-strong hover:text-ink'
        }`}
        // The same rule as the grid: a selection, not a toggle. To leave, choose something else
        onClick={() => void open()}
        /*
          The orchestrator is a session too. Before the first conversation, no session exists yet,
          so it is not made draggable — that keeps the #63 rule that opening a screen alone never
          creates a process. Once a conversation exists, it can be dragged into the grid like any
          other session row. The side that receives an ID into GridView was already shared code;
          this was the only entry point still missing from it.
        */
        draggable={!!id}
        onDragStart={(e) => {
          if (!id) return
          e.dataTransfer.setData(SESSION_MIME, id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        aria-pressed={active}
        data-testid="orchestrator-button"
        title={
          id
            ? 'One conversation that directs your sessions. Drag it to Grid to watch it beside other sessions.'
            : 'One conversation that directs your sessions.'
        }
      >
        <CrownIcon />
        <span className="truncate font-medium tracking-tight">Orchestrator</span>
      </button>
    </div>
  )
}
