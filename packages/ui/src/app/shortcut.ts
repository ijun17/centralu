import { useCallback } from 'react'
import type { ShortcutKeys } from '@cc/platform/ports'
import { useCapability } from './PlatformProvider.jsx'

/**
 * Callers write the meaning, 'mod' or 'alt', and @cc/platform prints `⌘` or `Ctrl` (#32): the ui never knows its OS.
 * `⇧` is no token: both keyboards print it, attached to its key (`'⇧A'`).
 */
const TOKENS = { mod: 'mod', alt: 'alt' } as const

/** As one string, for a title or a settings table: `('mod', 'I')` → `⌘I` or `Ctrl+I` */
export function shortcut(keys: ShortcutKeys, ...parts: string[]): string {
  return parts
    .map((p) => (p === TOKENS.mod ? keys.mod : p === TOKENS.alt ? keys.alt : p))
    .join(keys.join)
}

export function useShortcut(): (...parts: string[]) => string {
  const keys = useCapability('shortcutKeys')
  // `keys` is built once with the platform, so this keeps its identity (the palette's useMemo depends on it)
  return useCallback((...parts: string[]) => shortcut(keys, ...parts), [keys])
}

/**
 * Prints the back/forward pair this keyboard's browsers use (#374; both work everywhere, `navKeyOf`): mod+[ ]
 * where the port joins with no separator (the Mac), alt+← → elsewhere.
 */
export function navShortcut(keys: ShortcutKeys, dir: -1 | 1): string {
  return keys.join === '' ? shortcut(keys, 'mod', dir < 0 ? '[' : ']') : shortcut(keys, 'alt', dir < 0 ? '←' : '→')
}

export function useNavShortcut(): (dir: -1 | 1) => string {
  const keys = useCapability('shortcutKeys')
  return useCallback((dir: -1 | 1) => navShortcut(keys, dir), [keys])
}
