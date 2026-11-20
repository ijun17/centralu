/**
 * Is the app in front of the person right now.
 *
 * The notification policy hinges on this: do not notify while it is in front (that would be
 * noise). So if this judgment is wrong, notifications disappear silently — the kind of failure
 * that leaves no trace at all.
 *
 * Two signals are needed:
 *   - `hasFocus`   is it covered by another app (false when switching apps on a Mac)
 *   - `visibility` is it minimized or covered by another tab
 *
 * Looking only at `visibility` is not enough: after switching to another app (false via blur),
 * another occlusion event finds the window still 'visible' and answers true again, and from that
 * moment on notifications are blocked.
 */
export function isForeground(hasFocus: boolean, visibility: DocumentVisibilityState): boolean {
  return hasFocus && visibility === 'visible'
}
