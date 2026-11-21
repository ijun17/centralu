import { useStore } from '../../store/store.js'
import { useShortcut } from '../../app/shortcut.js'
import { Kbd } from '../../components/primitives.jsx'
import { SearchIcon } from '../../components/icons.jsx'

// The door to the palette (#529): with ⌘K alone, one never told the key cannot search (docs/ux-metrics.md); this says its
// key. The sidebar's first row (#535, #727): the top bar will hold more, and here no traffic lights or drag region need a
// guard. Faint: a door used now and then must not compete with the rows below.

/** What the palette finds the field by, to hang under it (CommandPalette) */
export const SEARCH_ANCHOR = 'data-search-anchor'

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
      {...{ [SEARCH_ANCHOR]: '' }}
      title="Search sessions, projects, apps and past conversations"
    >
      <SearchIcon />
      <span className="truncate">Search</span>
      {/*
        `rounded-field` and `rounded-field-key` (docs/design-system.md §2); the gap is even on top and right
      */}
      <span className="ml-auto shrink-0 text-2xs [&_.keycap]:rounded-field-key">
        <Kbd>{sc('mod', 'K')}</Kbd>
      </span>
    </button>
  )
}
