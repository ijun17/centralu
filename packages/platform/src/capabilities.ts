import { frameDragEndInPage } from './engine.js'
import type { PlatformCapabilities, ShortcutKeys } from './ports/index.js'

/**
 * The capabilities a platform answers with before anything is asked, written once (#972 item 7). The desktop asks
 * its shell and overrides what it learns; the browser and the mock keep these.
 *
 * The Mac spelling of the keys is the answer when nothing can be asked. A page could sniff the keyboard from the user
 * agent, and deliberately does not: the dev server, the contract tests and e2e run on a Mac, and a capability that
 * answers differently depending on the machine running the suite is one a test cannot pin. On the desktop, a failure
 * to ask can only mean the command is missing from the shell's handler list, a build-time mistake on every platform.
 */
export const MAC_SHORTCUT_KEYS: ShortcutKeys = { mod: '⌘', alt: '⌥', join: '' }

/** What a file manager is called when nobody says: the phrase that is true anywhere */
export const ANY_FILE_MANAGER = 'file manager'

export function defaultCapabilities(over: Partial<PlatformCapabilities> = {}): PlatformCapabilities {
  return {
    // A browser draws no window controls over our page
    windowControlsInset: 0,
    shortcutKeys: MAC_SHORTCUT_KEYS,
    fileManagerName: ANY_FILE_MANAGER,
    // A browser window has its own controls
    windowControls: false,
    // Unlike the keyboard, the engine is the page's own: whichever one runs it
    frameDragEndInPage: frameDragEndInPage(),
    ...over,
  }
}

/** A dock badge's count: a whole number, never below zero — clamped the same on every platform (#972 item 7) */
export function badgeCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0
}
