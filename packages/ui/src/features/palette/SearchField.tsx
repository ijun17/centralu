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
 * It stood at the top of the sidebar (#535), moved to the middle of the top bar (#727) and went back
 * (owner, 2026-11-05): the bar is going to hold more controls, which squeeze a centred field. It is
 * the first row of the sidebar, the sidebar's full width less its padding, and the palette it opens
 * hangs directly under it (CommandPalette, which reads the geometry below). The sidebar is under the
 * top bar, not beside the traffic lights, and is no drag region, so the field needs no guard for either.
 *
 * Field-shaped and faint: it is a door used now and then, and must not compete with the rows below.
 */

/** The top bar's height (App's TopBar, h-9); the sidebar and the palette's anchor start under it */
export const TOP_BAR_H = 36
/** The field's row in the sidebar: 8px above (pt-2), 28px tall (h-7), 8px at each side (px-2) */
export const SEARCH_ROW = { top: 8, height: 28, side: 8 } as const
/** Where the field ends, in the window: what the palette hangs from */
export const SEARCH_FIELD_BOTTOM = TOP_BAR_H + SEARCH_ROW.top + SEARCH_ROW.height

export function SearchField() {
  const sc = useShortcut()
  const open = useStore((s) => s.paletteOpen)
  return (
    <button
      className={`flex h-7 w-full min-w-0 items-center gap-2 rounded-field border pl-3 pr-1 text-left text-sm transition-colors hover:border-line-strong hover:text-ink ${
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
      {/*
        A field's corner, 10px (`rounded-field`; owner, 2026-10-18: an input, so not the status capsules' full round). The
        key inside follows it: its corner is the field's less the gap around it (`rounded-field-key`, 10 - 5 = 5px, the gap
        even on top and right), so the curves run parallel.
      */}
      <span className="ml-auto shrink-0 text-2xs [&_.keycap]:rounded-field-key">
        <Kbd>{sc('mod', 'K')}</Kbd>
      </span>
    </button>
  )
}
