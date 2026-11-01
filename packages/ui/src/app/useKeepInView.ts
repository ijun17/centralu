import { useEffect, type RefObject } from 'react'

/**
 * Keeps the row the arrow keys are on in view: after `cursor` moves, the element inside `root` marked `data-cursor` scrolls
 * the least it needs to (`nearest`), so a list taller than its box follows the cursor instead of leaving it out of sight.
 */
export function useKeepInView(root: RefObject<HTMLElement | null>, cursor: number): void {
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[data-cursor]')?.scrollIntoView({ block: 'nearest' })
  }, [root, cursor])
}
