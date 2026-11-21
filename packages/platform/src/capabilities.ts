import { frameDragEndInPage } from './engine.js'
import type { PlatformCapabilities, ShortcutKeys } from './ports/index.js'

/**
 * The keys when nothing can be asked, never sniffed from the user agent: the suite runs on a Mac, and a capability that
 * varies with the machine running it cannot be pinned by a test. On the desktop a failed ask can only be a command
 * missing from the shell's handler list, a build-time mistake on every OS alike.
 */
export const MAC_SHORTCUT_KEYS: ShortcutKeys = { mod: '⌘', alt: '⌥', join: '' }

export const ANY_FILE_MANAGER = 'file manager'

/** A browser's answers; the desktop overrides them with its shell's */
export function defaultCapabilities(over: Partial<PlatformCapabilities> = {}): PlatformCapabilities {
  return {
    windowControlsInset: 0,
    shortcutKeys: MAC_SHORTCUT_KEYS,
    fileManagerName: ANY_FILE_MANAGER,
    windowControls: false,
    servesHost: false,
    // Unlike the keyboard, the engine is the page's own
    frameDragEndInPage: frameDragEndInPage(),
    ...over,
  }
}

/** Clamped the same on every platform */
export function badgeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
}
