import { useStore } from '../../store/store.js'
import { useShortcut } from '../../app/shortcut.js'
import { Kbd } from '../../components/primitives.jsx'
import { SearchIcon } from '../../components/icons.jsx'

/**
 * The door to search (#529): sessions, projects, apps, actions and what was said in past
 * conversations, all in the command palette.
 *
 * The palette used to open only by ⌘K / Ctrl+K, so a person who had not been told the key had no
 * way to search at all: finding a past conversation had no path anyone could see (the task-cost
 * baseline, docs/ux-metrics.md). This is that path, and it says its key out loud, so the shortcut
 * is learned by using the field rather than by being told.
 *
 * It sat at the top of the sidebar, which left the left side crowded (#727). It now stands in the
 * middle of the top bar, the way an editor's command bar does: the place pressed is the top edge,
 * and the palette it opens hangs directly under it (CommandPalette).
 *
 * Field-shaped and faint: it is a door used now and then, and must not compete with the counts
 * beside it. Only the field is the button: the bar around it stays the window's drag handle, so
 * the wrapper in App's TopBar lets presses through everywhere but here (DragRegion skips a press
 * on a `button`).
 */
export function SearchField() {
  const sc = useShortcut()
  const open = useStore((s) => s.paletteOpen)
  return (
    <button
      className={`pointer-events-auto flex h-7 w-full min-w-0 items-center gap-2 rounded-full border px-3 text-left text-sm transition-colors hover:border-line-strong hover:text-ink ${
        open ? 'border-line-strong text-ink' : 'border-line text-ink-faint'
      }`}
      onClick={() => useStore.getState().togglePalette(true)}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-testid="search-button"
      title="Search sessions, projects, apps and past conversations"
    >
      <SearchIcon />
      <span className="truncate">Search</span>
      <span className="ml-auto shrink-0 text-2xs">
        <Kbd>{sc('mod', 'K')}</Kbd>
      </span>
    </button>
  )
}
