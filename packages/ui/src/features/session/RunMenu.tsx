import { useEffect, useRef, useState } from 'react'
import { CloseIcon, PlayIcon } from '../../components/icons.jsx'
import { IconButton } from '../../components/IconButton.jsx'
import { useStore } from '../../store/store.js'

/** A module constant, not a fresh `[]` per render — that would make the zustand snapshot unstable */
const NO_COMMANDS: string[] = []

/**
 * The project's saved shell commands, in the session pane header (issue #44).
 *
 * **Registering, running and removing all live in this one menu.** A settings page
 * elsewhere would mean leaving what you are doing to add the command you wanted to run,
 * and the moment you want a command saved is the moment you have just typed it. So the
 * last row is always the one that adds another.
 *
 * **Nothing here goes near the approval system.** These are the user's own commands, going
 * to the user's own shell — the same as typing into the terminal below. Approvals exist for
 * what an *agent* proposes; asking permission for what the person just typed would teach
 * them to wave the prompt through in the place where it matters.
 *
 * The shape follows the settings menu at the other end of the pane: a button, a popover,
 * escape and outside-click to close. It opens **downward**, because this end is the top of
 * the pane — the same reasoning that sends the settings menu the other way.
 */
export function RunMenu({
  sessionId,
  projectId,
  open,
  onOpenChange,
}: {
  sessionId: string
  projectId: string
  /**
   * Held by the pane, not here.
   *
   * In the grid the header is the handle that moves the panel (`draggable`), and a menu
   * you are typing into cannot also be a thing you drag: press on a row, move a few pixels,
   * and the browser starts dragging the panel instead of letting the click land. The pane
   * turns the handle off while this is open, so it has to know.
   */
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const commands = useStore((s) => s.projects[projectId]?.commands ?? NO_COMMANDS)
  const save = useStore((s) => s.setProjectCommands)
  const run = useStore((s) => s.runProjectCommand)
  const [draft, setDraft] = useState('')
  const rootRef = useRef<HTMLSpanElement>(null)

  /*
   * Outside click and escape close it — the browser does not do this for a popover the way
   * it does for a `<select>`, and a menu left open over the header is a wall (same care as
   * SessionSettings, which is where this came from).
   */
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) onOpenChange(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      // Only the innermost open thing closes — the inbox and modals must not go with it
      e.stopPropagation()
      onOpenChange(false)
    }
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, onOpenChange])

  const add = () => {
    const next = draft.trim()
    if (!next) return
    setDraft('')
    void save(projectId, [...commands, next])
  }

  return (
    <span className="relative flex items-center" ref={rootRef}>
      <IconButton
        label="Run a saved command in this project's terminal"
        onClick={() => onOpenChange(!open)}
        testId="run-open"
        align="right"
      >
        <PlayIcon />
      </IconButton>

      {open && (
        <div
          role="menu"
          data-testid="run-menu"
          className="absolute right-0 top-full z-30 mt-1 w-64 overflow-hidden rounded border border-edge bg-panel shadow-[0_12px_32px_-8px_rgb(0_0_0/0.9)]"
        >
          {/*
            An empty project shows the add row and nothing else. A "no commands yet" line
            would be a row that says nothing the empty input does not already say.
          */}
          {commands.map((c, i) => (
            <div key={`${i}-${c}`} className="flex items-center">
              <button
                type="button"
                role="menuitem"
                data-testid={`run-command-${i}`}
                title={`${c} — runs in this project's Terminal tab`}
                onClick={() => {
                  onOpenChange(false)
                  void run(sessionId, c)
                }}
                className="readout min-w-0 flex-1 truncate px-2.5 py-1 text-left text-[12px] text-ash transition-colors hover:bg-graphite/25 hover:text-chalk"
              >
                {c}
              </button>
              {/*
                Removing is its own target, kept apart from the one that runs. Hitting Run
                when you meant Remove starts something; the reverse only loses a line you
                can type again — so the risk is all on one side, and that side gets the gap.
                No confirmation for the same reason: this app saves those for the
                irreversible, and retyping a command is not that.
              */}
              <button
                type="button"
                data-testid={`run-delete-${i}`}
                aria-label={`Remove ${c}`}
                title={`Remove ${c} from this list`}
                onClick={() => void save(projectId, commands.filter((_, j) => j !== i))}
                className="ml-1 shrink-0 px-2 py-1 text-slate transition-colors hover:text-chalk"
              >
                <CloseIcon size={11} />
              </button>
            </div>
          ))}

          <form
            className="flex items-center gap-1.5 border-t border-edge px-2.5 py-1.5 first:border-t-0"
            onSubmit={(e) => {
              e.preventDefault()
              add()
            }}
          >
            <input
              className="readout min-w-0 flex-1 bg-transparent text-[12px] text-chalk placeholder:text-slate focus:outline-none"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Add a command"
              aria-label="Add a command"
              data-testid="run-add-input"
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              data-testid="run-add"
              className="shrink-0 rounded border border-edge px-1.5 py-0.5 text-[11px] text-ash transition-colors hover:border-graphite hover:text-chalk disabled:opacity-40"
            >
              Add
            </button>
          </form>
        </div>
      )}
    </span>
  )
}
