import { createContext, useContext, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * The current tab's buttons at the right end of its group's tab strip, instead of a second header bar that would repeat
 * the tab. A portal, so each button keeps its screen's state and the strip knows no tab's business.
 */
const SlotCtx = createContext<HTMLElement | null>(null)

export const TabActionSlot = SlotCtx.Provider

/** Renders nothing without a slot (a standalone render in a test) */
export function TabActions({ children }: { children: ReactNode }) {
  const slot = useContext(SlotCtx)
  return slot ? createPortal(children, slot) : null
}
