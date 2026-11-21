export type CoveringLayers = {
  /** Windows opened through local state count themselves here (`Modal`, #158) */
  openLayers: number
  paletteOpen: boolean
  settingsOpen: boolean
  usageOpen: boolean
  inboxOpen: boolean
  overlay: unknown
}

export type OwnLayer = 'inbox' | 'overlay'

/**
 * Every window keyboard listener that acts on the screen asks this first, so a key meant for the layer on top is not
 * answered underneath. One definition: a copy without `openLayers` lets y/n answer under a modal (#850 item 11).
 */
export function isCovered(st: CoveringLayers, own?: OwnLayer): boolean {
  return (
    st.openLayers > 0 ||
    st.paletteOpen ||
    st.settingsOpen ||
    st.usageOpen ||
    (own !== 'inbox' && st.inboxOpen) ||
    (own !== 'overlay' && st.overlay !== null)
  )
}

/**
 * Global shortcuts wait while a dialog is up (#842 item 1): ⌘K would open a hidden palette that takes the keyboard,
 * and ⌘1-9 or ⌘[ would move the screen behind it. The palette is not one: ⌘K closes it.
 */
export function dialogOpen(st: Pick<CoveringLayers, 'openLayers' | 'settingsOpen' | 'usageOpen'>): boolean {
  return st.openLayers > 0 || st.settingsOpen || st.usageOpen
}

export type WindowLayers = Pick<CoveringLayers, 'paletteOpen' | 'settingsOpen' | 'usageOpen' | 'inboxOpen'>

/**
 * A popover under a window that just opened closes (`useDismiss`): its Escape, claimed on the window first, would
 * close the hidden popover instead of the window on top.
 */
export function coveringLayerOpened(prev: WindowLayers, next: WindowLayers): boolean {
  return (
    (next.paletteOpen && !prev.paletteOpen) ||
    (next.settingsOpen && !prev.settingsOpen) ||
    (next.usageOpen && !prev.usageOpen) ||
    (next.inboxOpen && !prev.inboxOpen)
  )
}
