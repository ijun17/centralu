import { useCallback } from 'react'
import type { ShortcutKeys } from '@cc/platform/ports'
import { useCapability } from './PlatformProvider.jsx'

/**
 * Shortcuts are written by meaning, and the keyboard is left to attach the name (issue #32).
 *
 * `⌘` used to be baked directly into screens all over the app. That key does not exist on Linux
 * or Windows — the combination itself already accepted both `metaKey || ctrlKey`, so the behavior
 * was fine and only the label was lying. Writing the glyph at every call site meant that lie
 * existed in 61 places at once.
 *
 * So the caller only writes the meaning, 'mod' or 'alt'. Whether that means `⌘` or `Ctrl` is
 * answered by the side that knows the keyboard (@cc/platform) — ui never learns which OS it is
 * on.
 *
 * `⇧` is not a token. It is printed the same way on both keyboards, so there is no word to
 * translate, and it is attached directly to the preceding key (`'⇧A'`) — `Ctrl+⇧A` reads better
 * than `Ctrl+⇧+A`.
 */
const TOKENS = { mod: 'mod', alt: 'alt' } as const

/**
 * Written as a single string: `('mod', 'I')` → `⌘I` or `Ctrl+I`.
 *
 * Unlike a place drawn as separate boxes (`<Kbd mod />`), there are places that must be a plain
 * string, like a title attribute or a settings table, so both forms are needed. Whether the parts
 * are joined directly or with `+` is decided by the keyboard.
 */
export function shortcut(keys: ShortcutKeys, ...parts: string[]): string {
  return parts
    .map((p) => (p === TOKENS.mod ? keys.mod : p === TOKENS.alt ? keys.alt : p))
    .join(keys.join)
}

/** Gives the same thing, bound to whichever keyboard this app is running on right now */
export function useShortcut(): (...parts: string[]) => string {
  const keys = useCapability('shortcutKeys')
  // capabilities is built once when the platform is created, so this function stays the same
  // reference throughout — some call sites (like the palette) put it in a useMemo dependency
  // list, so its identity must not shift.
  return useCallback((...parts: string[]) => shortcut(keys, ...parts), [keys])
}
