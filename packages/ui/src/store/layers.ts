/**
 * The layers that can stand over the screen, as the store records them (#850 item 11). A modal or another window
 * opened through local state counts itself in `openLayers` (`Modal`, #158); the others are the store's own flags.
 */
export type CoveringLayers = {
  /** The count of windows opened via local state (delete confirmation, new session, image zoom, command palette…) */
  openLayers: number
  paletteOpen: boolean
  settingsOpen: boolean
  usageOpen: boolean
  inboxOpen: boolean
  overlay: unknown
}

/** A layer that asks whether something covers it, and so does not count itself */
export type OwnLayer = 'inbox' | 'overlay'

/**
 * Whether another layer stands over this one: a modal, the palette, settings, usage, the inbox or an overlay.
 *
 * Every keyboard listener on the window that acts on something on screen asks this first, so a key meant for the
 * layer on top is not also answered underneath. It used to be written out four times, and the copies drifted: the
 * capability question over an app view left out `openLayers`, so y or n answered it while a modal stood over it
 * (#850 item 11). `own` names the layer asking, which does not cover itself.
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
