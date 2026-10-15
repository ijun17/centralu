import { composingKey } from '../../../app/keys.js'
import { useStore } from '../../../store/store.js'

/**
 * Left folds and Right unfolds the group of the focused row (#666), the way a tree row does. A row with no group
 * ignores both, and so does a key with a modifier or one that belongs to an input method.
 */
export function foldKeys(hasGroup: boolean, folded: boolean, setFolded: (folded: boolean) => void) {
  return (e: React.KeyboardEvent) => {
    if (!hasGroup || composingKey(e.nativeEvent) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    if (e.key === 'ArrowLeft' && !folded) {
      e.preventDefault()
      setFolded(true)
    } else if (e.key === 'ArrowRight' && folded) {
      e.preventDefault()
      setFolded(false)
    }
  }
}

/** A group's folded state, remembered in the screen preferences (#666) */
export function useGroupFold(key: string): [boolean, (folded: boolean) => void] {
  const folded = useStore((s) => s.prefs.foldedGroups.includes(key))
  const setGroupsFolded = useStore((s) => s.setGroupsFolded)
  return [folded, (next) => setGroupsFolded([key], next)]
}
