import { useEffect, type RefObject } from 'react'

/** Keeps the arrow keys' row (`data-cursor` inside `root`) in view, scrolling the least it needs to */
export function useKeepInView(root: RefObject<HTMLElement | null>, cursor: number): void {
  useEffect(() => {
    root.current?.querySelector<HTMLElement>('[data-cursor]')?.scrollIntoView({ block: 'nearest' })
  }, [root, cursor])
}
