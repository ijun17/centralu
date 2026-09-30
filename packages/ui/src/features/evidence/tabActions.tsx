import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Where the current tab's control buttons live — **the right end of the tab strip** (user request,
 * 2026-09-07).
 *
 * Each tab used to draw one more header bar of its own. In a vertically narrow panel that put two
 * header bars (the tab strip, then the tab's own bar) back to back, with the actual content only
 * starting in whatever room was left below them. On top of that, the bar's label ("Terminal",
 * "Changes") was already saying exactly what the tab right above it said.
 *
 * Lifting the buttons up onto the strip by hoisting each screen's state upward instead (the
 * terminal's add function, whether ignored files are shown, and so on) would mean the strip has to
 * know every tab's business. So a **portal** is used instead: the button stays declared inside its
 * own screen and keeps using its own state as is, and only where it is rendered is the strip. The
 * strip knows nothing about any tab beyond handing out a slot.
 *
 * Each group has its own separate slot — when the screen splits top and bottom, each half's own
 * strip carries its own tab's buttons.
 */
const SlotCtx = createContext<HTMLElement | null>(null)

export const TabActionSlot = SlotCtx.Provider

/** This tab's control buttons. Renders nothing if the strip has no slot (e.g. a standalone render in a test) */
export function TabActions({ children }: { children: ReactNode }) {
  const slot = useContext(SlotCtx)
  return slot ? createPortal(children, slot) : null
}
